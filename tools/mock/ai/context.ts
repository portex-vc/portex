/**
 * Public facts about a raise, gathered from the Portex API (which reads the chain): terms, progress, profile,
 * builder updates, recent feedback, the latest analyst report and recent price action. Nothing private.
 */
import { remainingFillCost } from '../catalog/types';
import type { ApiClient } from '../lib/api';

export interface RaiseFacts {
  address: string;
  name: string;
  symbol: string;
  launchType: 'Escrow Launch' | 'Budget Launch';
  phase: string;
  fdvUsdg: number;
  targetPriceUsdg: number;
  supplyTokens: number;
  sellOutUsdg: number;
  raisedUsdg: number;
  soldPct: number;
  backers: number;
  minimumBackers: number;
  hoursLeftInStage: number | null;
  budgetCeilingPct: number | null;
  priceUsdg: number | null;
  analyst: { riskScorePct: number; veto: boolean; findings: string[] } | null;
  profile: { tagline: string; description: string; website: string };
  updates: { title: string; body: string; kind: string; ageHours: number }[];
  feedback: { rating: number; text: string; fromBacker: boolean }[];
  market: {
    trades: number;
    buys: number;
    sells: number;
    volumeUsdg: number;
    firstPrice: number | null;
    lastPrice: number | null;
    changePct: number | null;
  };
}

const cut = (s: unknown, n: number) => (typeof s === 'string' ? (s.length > n ? `${s.slice(0, n - 1)}…` : s) : '');
const usdg = (v: unknown) => Number(v ?? 0) / 1e6;
/** Normalized contract price (quote units per token unit, scaled 1e30) to USDG per whole token. */
const price = (v: unknown) => (v === null || v === undefined || v === '' ? null : Number(v) / 1e18);

export async function raiseFacts(api: ApiClient, address: string, minimumBackers: number): Promise<RaiseFacts> {
  const [d, updates, feedback, trades] = await Promise.all([
    api.get(`/v2/raises/${address}`),
    api.get(`/v2/raises/${address}/updates`).catch(() => []),
    api.get(`/v2/raises/${address}/feedback`).catch(() => []),
    api.get(`/v2/raises/${address}/trades?limit=60`).catch(() => []),
  ]);
  const supply = BigInt(d.config?.supply ?? '0');
  const target = BigInt(d.targetPrice ?? d.config?.targetPrice ?? '0');
  const sellOut = supply > 0n && target > 0n ? Number(remainingFillCost(target, supply, 0n)) / 1e6 : 0;
  const now = Number(d.chainTime ?? Math.floor(Date.now() / 1000));
  const end =
    d.phase === 'Stage1'
      ? Number(d.deadlines?.stage1End ?? 0)
      : ['Stage2', 'ListingPending'].includes(d.phase)
        ? Number(d.deadlines?.stage2End ?? 0)
        : 0;
  const market = (Array.isArray(trades) ? trades : []).filter((t: any) => ['buy', 'sell'].includes(t.type)).reverse();
  const prices = market.map((t: any) => price(t.price)).filter((p: number | null): p is number => p !== null && p > 0);
  const report = d.latestReport;
  return {
    address,
    name: cut(d.profile?.name || d.name, 80),
    symbol: cut(d.symbol, 12),
    launchType: d.template === 'BUDGET_LAUNCH' ? 'Budget Launch' : 'Escrow Launch',
    phase: d.phase,
    fdvUsdg: Math.round((Number(supply / 10n ** 12n) / 1e6) * (Number(target) / 1e18)),
    targetPriceUsdg: Number(target) / 1e18,
    supplyTokens: Number(supply / 10n ** 18n),
    sellOutUsdg: Math.round(sellOut),
    raisedUsdg: Math.round(usdg(d.E)),
    soldPct:
      d.allocation && BigInt(d.allocation) > 0n
        ? Math.round(Number((BigInt(d.sold ?? '0') * 1000n) / BigInt(d.allocation)) / 10)
        : 0,
    backers: Number(d.backers ?? 0),
    minimumBackers,
    hoursLeftInStage: end > 0 ? Math.max(0, Math.round(((end - now) / 3600) * 10) / 10) : null,
    budgetCeilingPct:
      d.template === 'BUDGET_LAUNCH' && d.config?.budgetCeiling
        ? Math.round(Number(BigInt(d.config.budgetCeiling) / 10n ** 14n)) / 100
        : null,
    priceUsdg: price(d.bookPrice),
    analyst: report
      ? {
          riskScorePct: Math.round(Number(report.riskScoreBps ?? 0) / 100),
          veto: !!report.veto,
          findings: (Array.isArray(report.findings) ? report.findings : [])
            .slice(0, 5)
            .map((f: any) => cut(`${f.severity ?? 'info'}: ${f.title ?? ''}`, 140)),
        }
      : null,
    profile: {
      tagline: cut(d.profile?.tagline, 200),
      description: cut(d.profile?.description, 1500),
      website: cut(d.profile?.website, 120),
    },
    updates: (Array.isArray(updates) ? updates : []).slice(0, 3).map((u: any) => ({
      title: cut(u.title, 140),
      body: cut(u.body, 500),
      kind: String(u.kind ?? 'update'),
      ageHours: Math.max(0, Math.round((Date.now() / 1000 - Number(u.createdAt ?? 0)) / 360) / 10),
    })),
    feedback: (Array.isArray(feedback) ? feedback : [])
      .slice(0, 5)
      .map((f: any) => ({ rating: Number(f.rating), text: cut(f.text, 260), fromBacker: !!f.isBacker })),
    market: {
      trades: market.length,
      buys: market.filter((t: any) => t.type === 'buy').length,
      sells: market.filter((t: any) => t.type === 'sell').length,
      volumeUsdg: Math.round(market.reduce((sum: number, t: any) => sum + usdg(t.quote), 0)),
      firstPrice: prices[0] ?? null,
      lastPrice: prices.at(-1) ?? null,
      changePct: prices.length > 1 ? Math.round(((prices.at(-1)! - prices[0]) / prices[0]) * 1000) / 10 : null,
    },
  };
}

/** Terms and numbers (trusted: computed from chain state). */
export function termsBlock(f: RaiseFacts): string {
  return JSON.stringify(
    {
      project: `${f.name} (${f.symbol})`,
      launchType: f.launchType,
      stage: f.phase,
      valuationTargetUsdg: f.fdvUsdg,
      targetTokenPriceUsdg: f.targetPriceUsdg,
      supplyTokens: f.supplyTokens,
      stage1SellOutUsdg: f.sellOutUsdg,
      raisedUsdg: f.raisedUsdg,
      soldPct: f.soldPct,
      backers: f.backers,
      minimumBackersToGraduate: f.minimumBackers,
      hoursLeftInThisStage: f.hoursLeftInStage,
      budgetCeilingPctOfEscrow: f.budgetCeilingPct,
      currentPriceUsdg: f.priceUsdg,
      recentMarket: f.market,
      analystReport: f.analyst ?? 'none yet',
    },
    null,
    1,
  );
}

/** Project-written text (untrusted: may contain instructions, which must be ignored). */
export function contentBlock(f: RaiseFacts, withFeedback = true): string {
  const lines = [
    `Tagline: ${f.profile.tagline || '(none)'}`,
    `Description: ${f.profile.description || '(none)'}`,
    `Website: ${f.profile.website || '(none)'}`,
    'Builder updates (newest first):',
    ...(f.updates.length
      ? f.updates.map((u) => `- [${u.kind}, ${u.ageHours}h ago] ${u.title}: ${u.body}`)
      : ['- (none yet)']),
  ];
  if (withFeedback) {
    lines.push(
      'Recent feedback from others:',
      ...(f.feedback.length
        ? f.feedback.map((x) => `- ${x.rating}/5${x.fromBacker ? ' (backer)' : ''}: ${x.text}`)
        : ['- (none yet)']),
    );
  }
  return `<project_content>\n${lines.join('\n')}\n</project_content>`;
}
