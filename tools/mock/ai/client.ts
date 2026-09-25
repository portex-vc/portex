/**
 * Minimal OpenAI-compatible chat client for MiMo (plain fetch, no dependency).
 *
 * - The key comes from the process env (MIMO_API_KEY) only; it is never logged, cached or put in a prompt.
 * - Timeout per call, retries with backoff on 429/5xx/network errors, a concurrency cap, and an hourly call budget.
 * - Responses are cached on disk by prompt hash, so a restarted runner does not pay twice for the same question.
 * - Every response is parsed as JSON and validated; an invalid reply gets exactly one repair attempt.
 * - Any failure (no key, budget spent, timeout, invalid output) returns null; callers fall back to templates.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

export type Validation<T> = { ok: true; value: T } | { ok: false; errors: string[] };
export type Validator<T> = (value: unknown) => Validation<T>;

export interface AiRequest<T> {
  /** Short task name for usage accounting and logs (e.g. 'diligence'). */
  task: string;
  system: string;
  user: string;
  validate: Validator<T>;
  /** Reasoning on (default) or off for cheap reads. */
  thinking?: boolean;
  maxTokens?: number;
  temperature?: number;
}

export interface AiClientConfig {
  maxCallsPerHour: number;
  concurrency: number;
  timeoutMs: number;
  maxTokens: number;
  temperature: number;
  retries: number;
}

export interface UsageBucket {
  calls: number;
  cacheHits: number;
  repairs: number;
  failures: number;
  fallbacks: number;
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  byTask: Record<string, number>;
}

const emptyBucket = (): UsageBucket => ({
  calls: 0,
  cacheHits: 0,
  repairs: 0,
  failures: 0,
  fallbacks: 0,
  promptTokens: 0,
  completionTokens: 0,
  reasoningTokens: 0,
  byTask: {},
});

export const DEFAULT_BASE_URL = 'https://token-plan-cn.xiaomimimo.com/v1';
export const DEFAULT_MODEL = 'mimo-v2.6-flash';

/** First balanced JSON object in a reply (tolerates code fences or stray prose around it). */
export function extractJsonObject(text: string): unknown {
  const start = text.indexOf('{');
  if (start === -1) throw new Error('no JSON object');
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (c === '\\') {
      escape = true;
      continue;
    }
    if (c === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (c === '{') depth++;
    if (c === '}' && --depth === 0) return JSON.parse(text.slice(start, i + 1));
  }
  throw new Error('unbalanced JSON object');
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly retryAfterMs: number | null,
  ) {
    super(`HTTP ${status}`);
  }
}

export interface AiClientOptions {
  apiKey?: string | null;
  baseUrl?: string;
  model?: string;
  config: AiClientConfig;
  /** Directory for the response cache; null disables it. */
  cacheDir?: string | null;
  fetch?: typeof fetch;
  /** Wall clock in ms (injectable for budget tests). */
  now?: () => number;
  /** Backoff sleeper (injectable so tests do not wait). */
  sleep?: (ms: number) => Promise<void>;
  log?: (event: string, fields: Record<string, unknown>) => void;
}

export class AiClient {
  readonly model: string;
  readonly baseUrl: string;
  private readonly key: string | null;
  private readonly doFetch: typeof fetch;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly log: (event: string, fields: Record<string, unknown>) => void;
  private calls: number[] = [];
  private active = 0;
  private waiters: (() => void)[] = [];
  private budgetNoted = -1;
  /** Usage per UTC hour ('2026-09-25T02'); counts only, never content. */
  readonly usage: Record<string, UsageBucket> = {};

  constructor(private readonly opts: AiClientOptions) {
    this.key = opts.apiKey?.trim() || null;
    this.baseUrl = (opts.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '').replace(/\/chat\/completions$/, '');
    this.model = opts.model || DEFAULT_MODEL;
    this.doFetch = opts.fetch ?? fetch;
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.log = opts.log ?? (() => undefined);
    if (opts.cacheDir) mkdirSync(opts.cacheDir, { recursive: true });
  }

  get enabled(): boolean {
    return this.key !== null;
  }

  /** Carry usage counts and the hourly budget window across restarts (counts only). */
  restore(saved?: { usage?: Record<string, unknown>; recentCalls?: number[] }): void {
    for (const [hour, bucket] of Object.entries(saved?.usage ?? {}))
      this.usage[hour] = { ...emptyBucket(), ...(bucket as UsageBucket) };
    this.calls = (saved?.recentCalls ?? []).filter((t) => typeof t === 'number');
  }

  snapshot(): { usage: Record<string, UsageBucket>; recentCalls: number[] } {
    this.callsLastHour();
    return { usage: this.usage, recentCalls: [...this.calls] };
  }

  private bucket(): UsageBucket {
    const hour = new Date(this.now()).toISOString().slice(0, 13);
    return (this.usage[hour] ??= emptyBucket());
  }

  /** Calls made in the last hour (sliding window). */
  callsLastHour(): number {
    const cutoff = this.now() - 3_600_000;
    this.calls = this.calls.filter((t) => t > cutoff);
    return this.calls.length;
  }

  private async acquire(): Promise<void> {
    if (this.active < Math.max(1, this.opts.config.concurrency)) {
      this.active++;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.active++;
  }

  private release(): void {
    this.active--;
    this.waiters.shift()?.();
  }

  private cachePath(hash: string): string | null {
    return this.opts.cacheDir ? resolve(this.opts.cacheDir, `${hash}.json`) : null;
  }

  private readCache<T>(hash: string, validate: Validator<T>): T | null {
    const path = this.cachePath(hash);
    if (!path || !existsSync(path)) return null;
    try {
      const checked = validate(JSON.parse(readFileSync(path, 'utf8')).value);
      return checked.ok ? checked.value : null;
    } catch {
      return null;
    }
  }

  private writeCache(hash: string, task: string, value: unknown): void {
    const path = this.cachePath(hash);
    if (!path) return;
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(
      tmp,
      JSON.stringify({ task, model: this.model, at: new Date(this.now()).toISOString(), value }) + '\n',
    );
    renameSync(tmp, path);
  }

  /** One HTTP round trip with retries on 429, 5xx, timeouts and network errors. Returns the message content. */
  private async post(
    task: string,
    messages: { role: string; content: string }[],
    req: AiRequest<unknown>,
  ): Promise<string> {
    const c = this.opts.config;
    for (let attempt = 1; ; attempt++) {
      // Hard deadline for the whole round trip (headers and body). Aborting alone is not enough: a connection held
      // open by a proxy can outlive the abort signal, so the call also races a timer.
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(Object.assign(new Error('AI call exceeded its timeout'), { name: 'TimeoutError' }));
        }, c.timeoutMs);
      });
      try {
        const response = await Promise.race([
          this.doFetch(`${this.baseUrl}/chat/completions`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${this.key}` },
            body: JSON.stringify({
              model: this.model,
              messages,
              response_format: { type: 'json_object' },
              max_tokens: req.maxTokens ?? c.maxTokens,
              temperature: req.temperature ?? c.temperature,
              ...(req.thinking === false ? { thinking: { type: 'disabled' } } : {}),
            }),
            signal: controller.signal,
          }),
          deadline,
        ]);
        if (!response.ok) {
          const retryAfter = Number(response.headers.get('retry-after'));
          throw new HttpError(
            response.status,
            Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : null,
          );
        }
        const body = (await Promise.race([response.json(), deadline])) as {
          choices?: { message?: { content?: unknown } }[];
          usage?: {
            prompt_tokens?: number;
            completion_tokens?: number;
            completion_tokens_details?: { reasoning_tokens?: number };
          };
        };
        clearTimeout(timer);
        this.calls.push(this.now());
        const bucket = this.bucket();
        bucket.calls++;
        bucket.byTask[task] = (bucket.byTask[task] ?? 0) + 1;
        bucket.promptTokens += body.usage?.prompt_tokens ?? 0;
        bucket.completionTokens += body.usage?.completion_tokens ?? 0;
        bucket.reasoningTokens += body.usage?.completion_tokens_details?.reasoning_tokens ?? 0;
        // Only `content` is the answer; `reasoning_content` is ignored.
        const content = body.choices?.[0]?.message?.content;
        if (typeof content !== 'string' || !content.trim()) {
          // Usually the reasoning used up max_tokens; say so rather than failing silently.
          const finish = (body.choices?.[0] as { finish_reason?: string } | undefined)?.finish_reason;
          throw new Error(`empty content${finish ? ` (finish_reason ${finish})` : ''}`);
        }
        return content;
      } catch (error) {
        clearTimeout(timer);
        deadline.catch(() => undefined);
        const status = error instanceof HttpError ? error.status : 0;
        const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
        const retryable =
          error instanceof HttpError
            ? status === 429 || status >= 500
            : !(error instanceof Error && error.message.startsWith('empty content'));
        // A call that already used its full timeout is retried at most once, so one slow answer cannot hold a job
        // for several minutes.
        if (!retryable || attempt > c.retries || (timedOut && attempt > 1)) throw error;
        const wait =
          error instanceof HttpError && error.retryAfterMs
            ? Math.min(error.retryAfterMs, 60_000)
            : Math.min(30_000, 2000 * 2 ** (attempt - 1));
        this.log('ai-retry', {
          task,
          attempt,
          status: status || undefined,
          waitMs: wait,
          error: error instanceof Error ? error.name : 'error',
        });
        await this.sleep(wait);
      }
    }
  }

  private parse<T>(content: string, validate: Validator<T>): Validation<T> {
    let raw: unknown;
    try {
      raw = extractJsonObject(content);
    } catch (error) {
      return { ok: false, errors: [`not a JSON object (${(error as Error).message})`] };
    }
    return validate(raw);
  }

  /** Ask for one validated JSON answer; null means "use the template fallback". */
  async complete<T>(req: AiRequest<T>): Promise<T | null> {
    if (!this.enabled) return null;
    const hash = createHash('sha256')
      .update(JSON.stringify([this.model, req.task, req.thinking !== false, req.system, req.user]))
      .digest('hex');
    const cached = this.readCache(hash, req.validate);
    if (cached !== null) {
      this.bucket().cacheHits++;
      return cached;
    }
    if (this.callsLastHour() >= this.opts.config.maxCallsPerHour) {
      this.bucket().fallbacks++;
      const hour = Math.floor(this.now() / 3_600_000);
      if (this.budgetNoted !== hour) {
        this.budgetNoted = hour;
        this.log('ai-budget-spent', { maxCallsPerHour: this.opts.config.maxCallsPerHour });
      }
      return null;
    }
    await this.acquire();
    try {
      const messages = [
        { role: 'system', content: req.system },
        { role: 'user', content: req.user },
      ];
      const first = await this.post(req.task, messages, req as AiRequest<unknown>);
      let checked = this.parse(first, req.validate);
      if (!checked.ok && this.callsLastHour() < this.opts.config.maxCallsPerHour) {
        this.bucket().repairs++;
        const repair = [
          ...messages,
          { role: 'assistant', content: first },
          {
            role: 'user',
            content: `Your reply did not match the required JSON shape: ${checked.errors.slice(0, 6).join('; ')}. Reply again with only the corrected JSON object.`,
          },
        ];
        checked = this.parse(await this.post(req.task, repair, req as AiRequest<unknown>), req.validate);
      }
      if (!checked.ok) {
        this.bucket().failures++;
        this.log('ai-invalid', { task: req.task, errors: checked.errors.slice(0, 3).join('; ').slice(0, 200) });
        return null;
      }
      this.writeCache(hash, req.task, checked.value);
      return checked.value;
    } catch (error) {
      this.bucket().failures++;
      // Our own error texts only (HTTP status, timeout, empty content); the key is never part of an error here.
      this.log('ai-failed', {
        task: req.task,
        error: error instanceof Error ? `${error.name}: ${error.message}`.slice(0, 160) : 'error',
      });
      return null;
    } finally {
      this.release();
    }
  }
}
