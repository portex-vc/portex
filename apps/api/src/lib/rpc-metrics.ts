/**
 * JSON-RPC call accounting. Every request the viem HTTP transport sends is counted by method, attributed to the API
 * request that caused it (AsyncLocalStorage) or to background work (indexer, state refresh) otherwise.
 *
 * `RPC_METRICS=1` exposes the tallies: every API response carries `X-Rpc-Calls`, and `GET /v2/debug/rpc` returns the
 * background totals. Counting itself is always on and costs one JSON parse of the outgoing body.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

export interface RpcTally { total: number; methods: Record<string, number> }
const scope = new AsyncLocalStorage<RpcTally>();
export const background: RpcTally = { total: 0, methods: {} };
export const rpcMetricsEnabled = () => process.env.RPC_METRICS === '1';
export const emptyTally = (): RpcTally => ({ total: 0, methods: {} });

/** Transport hook: counts the JSON-RPC calls in one outgoing HTTP body (single or batch). */
export function countRpcBody(body: unknown): void {
  let calls: { method?: string }[] = [];
  try {
    const parsed = typeof body === 'string' ? JSON.parse(body) : body;
    calls = Array.isArray(parsed) ? parsed : [parsed];
  } catch { calls = [{ method: 'unknown' }]; }
  const tally = scope.getStore() ?? background;
  for (const c of calls) {
    const method = String(c?.method ?? 'unknown');
    tally.total++;
    tally.methods[method] = (tally.methods[method] ?? 0) + 1;
  }
}

/** Runs `fn` with its own tally; RPC calls made anywhere inside its async call tree are attributed to it. */
export async function withRpcTally<T>(fn: () => Promise<T>): Promise<{ result: T; tally: RpcTally }> {
  const tally = emptyTally();
  const result = await scope.run(tally, fn);
  return { result, tally };
}

/** Runs `fn` as background work even when called from inside a request (e.g. a shared refresh it awaits). */
export function asBackground<T>(fn: () => T): T {
  return scope.run(background, fn);
}
