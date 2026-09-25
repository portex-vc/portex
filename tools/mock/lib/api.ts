/** Off-chain Portex API calls made by the mock: image uploads, builder profiles, builder updates, signed feedback. */
import type { PrivateKeyAccount } from 'viem/accounts';
import { signRequest } from '@portex/api/lib/signed-request';
import { errorText, log } from './log';
import { isTransient, sleep } from './chain';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export class ApiClient {
  constructor(
    readonly base: string,
    readonly dryRun = false,
  ) {}

  private async request(path: string, init: RequestInit = {}, attempts = 4): Promise<any> {
    for (let attempt = 1; ; attempt++) {
      try {
        const response = await fetch(`${this.base}${path}`, { ...init, signal: AbortSignal.timeout(30_000) });
        const text = await response.text();
        let body: any = null;
        try {
          body = text ? JSON.parse(text) : null;
        } catch {
          body = text;
        }
        if (response.ok) return body;
        const error = new ApiError(
          response.status,
          body?.error?.code ?? 'HTTP_ERROR',
          body?.error?.message ?? `HTTP ${response.status}`,
        );
        if ((response.status >= 500 || response.status === 429) && attempt < attempts)
          throw Object.assign(error, { retryable: true });
        throw error;
      } catch (error) {
        const retryable =
          (error as { retryable?: boolean }).retryable ||
          (!(error instanceof ApiError) &&
            (isTransient(error) || error instanceof TypeError || (error as Error)?.name === 'TimeoutError'));
        if (!retryable || attempt >= attempts) throw error;
        const wait = 1000 * 2 ** (attempt - 1);
        log.warn('api-retry', { path, attempt, waitMs: wait, error: errorText(error) });
        await sleep(wait);
      }
    }
  }

  get(path: string): Promise<any> {
    return this.request(path);
  }

  async signed(account: PrivateKeyAccount, method: string, path: string, value: unknown): Promise<any> {
    if (this.dryRun) {
      log.info('plan-api', { method, path, as: account.address });
      return null;
    }
    const body = JSON.stringify(value);
    // Sign on every attempt: a retried request must carry a fresh timestamp.
    for (let attempt = 1; ; attempt++) {
      const headers = await signRequest(account, method, path, body);
      try {
        return await this.request(
          path,
          { method, headers: { 'content-type': 'application/json', ...headers }, body },
          1,
        );
      } catch (error) {
        const retryable =
          (error instanceof ApiError && (error.status >= 500 || error.status === 429)) ||
          (!(error instanceof ApiError) && attempt < 4);
        if (!retryable || attempt >= 4) throw error;
        await sleep(1000 * 2 ** (attempt - 1));
      }
    }
  }

  /** True once the API indexer knows the raise (profile writes need the indexed row). */
  async hasRaise(address: string): Promise<boolean> {
    try {
      await this.request(`/v2/raises/${address}`, {}, 2);
      return true;
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return false;
      throw error;
    }
  }

  upload(
    account: PrivateKeyAccount,
    png: Uint8Array,
  ): Promise<{ uri: string; url: string; cid: string | null; bytes: number } | null> {
    return this.signed(account, 'POST', '/v2/uploads', {
      contentType: 'image/png',
      data: Buffer.from(png).toString('base64'),
    });
  }

  putProfile(account: PrivateKeyAccount, raise: string, profile: Record<string, unknown>) {
    return this.signed(account, 'PUT', `/v2/raises/${raise}/profile`, profile);
  }

  postUpdate(account: PrivateKeyAccount, raise: string, update: { title: string; body: string; kind: string }) {
    return this.signed(account, 'POST', `/v2/raises/${raise}/updates`, update);
  }

  async postFeedback(account: PrivateKeyAccount, raise: string, rating: number, text: string) {
    if (this.dryRun) {
      log.info('plan-api', { method: 'POST', path: `/v2/raises/${raise}/feedback`, as: account.address });
      return null;
    }
    const signature = await account.signMessage({
      message: `Portex feedback\nraise: ${raise.toLowerCase()}\nrating: ${rating}\ntext: ${text}`,
    });
    return this.request(`/v2/raises/${raise}/feedback`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ author: account.address, rating, text, signature }),
    });
  }
}
