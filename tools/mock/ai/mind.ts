/**
 * The personas' "minds": asynchronous AI jobs the engine can wait on for a bounded time. A job that is not finished
 * within the tick's wait budget keeps running and is picked up on a later tick, so the runner never stalls on AI.
 * A null value means "no AI answer" (no key, budget spent, invalid output): callers fall back to templates.
 */
import type { AiClient } from './client';
import type { RaiseFacts } from './context';
import type { Mind } from './personas';
import {
  diligencePrompt,
  proposalPrompt,
  sentimentPrompt,
  updatePrompt,
  votePrompt,
  type CatalogBrief,
  type ProposalFacts,
} from './prompts';
import {
  builderUpdateValidator,
  diligenceValidator,
  proposalValidator,
  sentimentValidator,
  voteBatchValidator,
  type BuilderUpdateText,
  type Diligence,
  type ProposalText,
  type Sentiment,
  type VoteBatch,
} from './schemas';

export type JobResult<T> =
  { state: 'pending' } | { state: 'error'; error: string } | { state: 'done'; value: T | null };

interface Job {
  promise: Promise<unknown>;
  settled: boolean;
  value?: unknown;
  error?: string;
}

export class MindService {
  private jobs = new Map<string, Job>();

  constructor(readonly client: AiClient) {}

  get enabled(): boolean {
    return this.client.enabled;
  }

  get pending(): number {
    return [...this.jobs.values()].filter((j) => !j.settled).length;
  }

  /** Start (or join) job `key` and wait up to `waitMs` for it. A settled job is returned once and forgotten. */
  async run<T>(key: string, start: () => Promise<T | null>, waitMs: number): Promise<JobResult<T>> {
    let job = this.jobs.get(key);
    if (!job) {
      const created: Job = { settled: false, promise: Promise.resolve() };
      created.promise = start().then(
        (value) => {
          created.settled = true;
          created.value = value;
        },
        (error) => {
          created.settled = true;
          created.error = error instanceof Error ? error.message : String(error);
        },
      );
      this.jobs.set(key, created);
      job = created;
    }
    if (!job.settled && waitMs > 0) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        job.promise,
        new Promise((resolve) => {
          timer = setTimeout(resolve, waitMs);
        }),
      ]);
      clearTimeout(timer);
    }
    if (!job.settled) return { state: 'pending' };
    this.jobs.delete(key);
    return job.error !== undefined
      ? { state: 'error', error: job.error }
      : { state: 'done', value: (job.value ?? null) as T | null };
  }

  /** Without a key every task answers "no AI" at once, before any prompt is built. */
  private ask<T>(key: string, start: () => Promise<T | null>, waitMs: number): Promise<JobResult<T>> {
    if (!this.enabled) return Promise.resolve({ state: 'done', value: null });
    return this.run(key, start, waitMs);
  }

  /** Due diligence. `held` (USDG) turns it into a keep-or-exit review of an existing position. */
  diligence(
    key: string,
    mind: Mind,
    facts: RaiseFacts,
    maxUsdg: number,
    waitMs: number,
    held?: number,
  ): Promise<JobResult<Diligence>> {
    return this.ask(
      key,
      async () => {
        const review = held !== undefined;
        // The ticket never exceeds what the caller can still deposit (e.g. the cap on a user's raise).
        const hi = Math.max(0, Math.min(mind.ticket[1], Math.floor(maxUsdg)));
        const ticket: [number, number] = review ? [0, 0] : [Math.min(mind.ticket[0], hi), hi];
        const { system, user } = diligencePrompt(mind, facts, { ticket, held });
        return this.client.complete({
          task: review ? 'rereview' : 'diligence',
          system,
          user,
          validate: diligenceValidator(ticket),
        });
      },
      waitMs,
    );
  }

  votes(
    key: string,
    voters: { key: string; mind: Mind; weightPct: number }[],
    facts: RaiseFacts,
    proposal: ProposalFacts,
    waitMs: number,
  ): Promise<JobResult<VoteBatch>> {
    return this.ask(
      key,
      () => {
        const { system, user } = votePrompt(voters, facts, proposal);
        return this.client.complete({
          task: 'votes',
          system,
          user,
          validate: voteBatchValidator(voters.map((v) => v.key)),
          maxTokens: 5000,
        });
      },
      waitMs,
    );
  }

  update(
    key: string,
    brief: CatalogBrief,
    facts: RaiseFacts,
    n: number,
    waitMs: number,
  ): Promise<JobResult<BuilderUpdateText>> {
    return this.ask(
      key,
      () => {
        const { system, user } = updatePrompt(brief, facts, n);
        return this.client.complete({
          task: 'update',
          system,
          user,
          validate: builderUpdateValidator,
          thinking: false,
        });
      },
      waitMs,
    );
  }

  proposal(
    key: string,
    brief: CatalogBrief,
    facts: RaiseFacts,
    p: { kind: 'Budget draw' | 'Treasury spend'; poolUsdg: number; share: [number, number]; n: number },
    waitMs: number,
  ): Promise<JobResult<ProposalText>> {
    return this.ask(
      key,
      () => {
        const { system, user } = proposalPrompt(brief, facts, p);
        return this.client.complete({
          task: 'proposal',
          system,
          user,
          validate: proposalValidator(p.share),
          thinking: false,
        });
      },
      waitMs,
    );
  }

  sentiment(key: string, facts: RaiseFacts, waitMs: number): Promise<JobResult<Sentiment>> {
    return this.ask(
      key,
      () => {
        const { system, user } = sentimentPrompt(facts);
        return this.client.complete({
          task: 'sentiment',
          system,
          user,
          validate: sentimentValidator,
          thinking: false,
          maxTokens: 400,
          temperature: 0.3,
        });
      },
      waitMs,
    );
  }
}
