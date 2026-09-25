import type { ScorerInput } from './types.ts';

/**
 * All analyst metrics, computed deterministically from indexed chain + feedback data.
 * Shares/Herfindahl are returned in basis points (0..10_000).
 */
export interface Metrics {
  backerCount: number;
  totalPrincipal: string;
  top1ShareBps: number;
  top5ShareBps: number;
  herfindahlBps: number;
  /** Largest share of principal whose wallets were quote-funded by one common sender. */
  clusterShareBps: number;
  clusterFunder: string | null;
  clusterSize: number;
  /** Share of principal from wallets funded by the builder. */
  builderLinkedShareBps: number;
  /** Largest share of principal deposited inside any single window of `burstWindowSec`. */
  burstShareBps: number;
  burstWindowSec: number;
  feedbackCount: number;
  distinctFeedbackAuthors: number;
  backerFeedbackShareBps: number;
  duplicateFeedbackShareBps: number;
}

export const BURST_WINDOW_SEC = 300;

function normalizeText(t: string): string {
  return t.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
}

export function computeMetrics(input: ScorerInput, burstWindowSec = BURST_WINDOW_SEC): Metrics {
  const total = input.backers.reduce((acc, b) => acc + Number(BigInt(b.principal)), 0);

  // ---- concentration -------------------------------------------------------
  const sorted = input.backers.map((b) => Number(BigInt(b.principal))).sort((a, b) => b - a);
  const share = (v: number) => (total > 0 ? Math.round((v / total) * 10_000) : 0);
  const top1 = sorted[0] ?? 0;
  const top5 = sorted.slice(0, 5).reduce((a, b) => a + b, 0);
  const hhi = total > 0
    ? Math.round(sorted.reduce((acc, v) => acc + (v / total) ** 2, 0) * 10_000)
    : 0;

  // ---- funding-source clustering -------------------------------------------
  const principalOf = new Map<string, number>();
  for (const b of input.backers) principalOf.set(b.user.toLowerCase(), Number(BigInt(b.principal)));
  const byFunder = new Map<string, { principal: number; wallets: number }>();
  let builderLinked = 0;
  for (const f of input.funding) {
    const p = principalOf.get(f.user.toLowerCase()) ?? 0;
    if (p <= 0 || !f.funder) continue;
    const funder = f.funder.toLowerCase();
    const cur = byFunder.get(funder) ?? { principal: 0, wallets: 0 };
    cur.principal += p;
    cur.wallets += 1;
    byFunder.set(funder, cur);
    if (funder === input.builder.toLowerCase()) builderLinked += p;
  }
  let clusterShareBps = 0; let clusterFunder: string | null = null; let clusterSize = 0;
  for (const [funder, c] of byFunder) {
    // One wallet with its own funder is not a cluster; its weight is already the largest-backer share.
    if (c.wallets < 2) continue;
    const s = share(c.principal);
    if (s > clusterShareBps) { clusterShareBps = s; clusterFunder = funder; clusterSize = c.wallets; }
  }

  // ---- deposit-time burstiness ----------------------------------------------
  const deps = [...input.deposits].sort((a, b) => a.timestamp - b.timestamp);
  const totalDeposited = deps.reduce((acc, d) => acc + Number(BigInt(d.amount)), 0);
  let burstShareBps = 0;
  let j = 0; let windowSum = 0;
  for (let i = 0; i < deps.length; i++) {
    windowSum += Number(BigInt(deps[i].amount));
    while (deps[i].timestamp - deps[j].timestamp > burstWindowSec) {
      windowSum -= Number(BigInt(deps[j].amount));
      j++;
    }
    if (totalDeposited > 0) {
      burstShareBps = Math.max(burstShareBps, Math.round((windowSum / totalDeposited) * 10_000));
    }
  }

  // ---- feedback ---------------------------------------------------------------
  const fb = input.feedback;
  const authors = new Set(fb.map((f) => f.author.toLowerCase()));
  const backersFb = fb.filter((f) => f.isBacker).length;
  const seen = new Map<string, number>();
  for (const f of fb) {
    const n = normalizeText(f.text);
    if (n) seen.set(n, (seen.get(n) ?? 0) + 1);
  }
  let dupes = 0;
  for (const count of seen.values()) if (count > 1) dupes += count - 1;

  return {
    backerCount: input.backers.length,
    totalPrincipal: input.backers.reduce((acc, b) => acc + BigInt(b.principal), 0n).toString(),
    top1ShareBps: share(top1),
    top5ShareBps: share(top5),
    herfindahlBps: hhi,
    clusterShareBps,
    clusterFunder,
    clusterSize,
    builderLinkedShareBps: share(builderLinked),
    burstShareBps,
    burstWindowSec,
    feedbackCount: fb.length,
    distinctFeedbackAuthors: authors.size,
    backerFeedbackShareBps: fb.length > 0 ? Math.round((backersFb / fb.length) * 10_000) : 0,
    duplicateFeedbackShareBps: fb.length > 0 ? Math.round((dupes / fb.length) * 10_000) : 0,
  };
}
