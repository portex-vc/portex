import { computeMetrics, type Metrics } from './metrics.ts';
import type { Finding, Scorer, ScorerInput, ScorerResult } from './types.ts';

/**
 * Deterministic heuristic scorer — always on. Every threshold below is transparent and each
 * breach becomes a finding. Score = sum of breached-threshold weights, capped at 10_000.
 *
 * Thresholds are RELATIVE to the raise, not absolute:
 *  - the burst window is a fraction of the raise's own `minIncubation`, and burstiness is
 *    only assessed once there are enough deposits for the statistic to mean anything;
 *  - concentration metrics (top-1 / top-5 / Herfindahl) are only assessed when a perfectly
 *    equal split among the actual backers would NOT itself trip the warn threshold — a raise
 *    with 3 backers trivially has top-5 = 100%, which says nothing;
 *  - "no feedback yet" is informational early in incubation and only warns once the
 *    incubation minimum has fully elapsed.
 *
 * VETO POLICY (delay-only; the council can clear it):
 *   veto when clusterShareBps  >= vetoClusterShareBps   (6000 = 60% of principal funded by one source), OR
 *         builderLinkedShareBps >= vetoBuilderLinkedBps (5000 = 50% of principal from builder-funded wallets).
 * Both indicate a raise whose "community" is one actor — exactly the pattern the analyst
 * exists to slow down.
 */
export const HEURISTIC_CONFIG = {
  // Burst window = minIncubation / burstWindowFraction (clamped to >= burstMinWindowSec).
  burstWindowFraction: 12,
  burstMinWindowSec: 30,
  // Fewer deposits than this and the burst statistic is noise — skip it.
  burstMinDeposits: 8,
  // Below this many backers, concentration metrics are meaningless — one info finding instead.
  minBackersForConcentration: 5,
  // [warnBps, critBps, warnWeight, critWeight]
  top1Share: { warn: 2500, crit: 5000, warnWeight: 1200, critWeight: 2500 },
  top5Share: { warn: 6000, crit: 8500, warnWeight: 800, critWeight: 2000 },
  herfindahl: { warn: 2000, crit: 4000, warnWeight: 1000, critWeight: 2200 },
  cluster: { warn: 3000, crit: 6000, warnWeight: 2500, critWeight: 5000 },
  builderLinked: { warn: 1000, crit: 5000, warnWeight: 3000, critWeight: 5000 },
  burst: { warn: 5000, crit: 8000, warnWeight: 1000, critWeight: 2000 },
  duplicateFeedback: { warn: 5000, crit: 8000, warnWeight: 800, critWeight: 1500 },
  fewBackers: { count: 3, weight: 1000 },        // fewer than this many backers
  noFeedback: { weight: 500 },                   // only once minIncubation has elapsed
  vetoClusterShareBps: 6000,
  vetoBuilderLinkedBps: 5000,
} as const;

const PRODUCTION_MIN_INCUBATION_SEC = 30 * 86_400;

const pct = (bps: number) => `${(bps / 100).toFixed(1)}%`;
/** 0x1234…abcd, as the report shows addresses to backers. */
const short = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;
const backersText = (n: number) => `${n} backer${n === 1 ? '' : 's'}`;

function threshold(
  findings: Finding[], value: number, cfg: { warn: number; crit: number; warnWeight: number; critWeight: number },
  label: string, detail: (v: number) => string,
): number {
  if (value >= cfg.crit) {
    findings.push({ severity: 'critical', title: label, detail: detail(value) });
    return cfg.critWeight;
  }
  if (value >= cfg.warn) {
    findings.push({ severity: 'warn', title: label, detail: detail(value) });
    return cfg.warnWeight;
  }
  return 0;
}

/**
 * What a metric would be for a perfectly equal split among `n` backers. If that baseline
 * already trips the warn threshold, the metric cannot distinguish manipulation at this
 * sample size and is skipped entirely.
 */
function equalSplitBaseline(metric: 'top1' | 'top5' | 'hhi', n: number): number {
  if (n <= 0) return 10_000;
  if (metric === 'top5') return Math.min(10_000, Math.round((Math.min(5, n) / n) * 10_000));
  return Math.round(10_000 / n); // top1 and Herfindahl of an equal split are both 1/n
}

export function scoreHeuristic(input: ScorerInput, cfg = HEURISTIC_CONFIG): ScorerResult & { metrics: Metrics } {
  const minIncubationSec = input.minIncubationSec && input.minIncubationSec > 0
    ? input.minIncubationSec
    : PRODUCTION_MIN_INCUBATION_SEC;
  const burstWindowSec = Math.max(cfg.burstMinWindowSec, Math.floor(minIncubationSec / cfg.burstWindowFraction));
  const m = computeMetrics(input, burstWindowSec);
  const findings: Finding[] = [];
  let score = 0;

  if (m.backerCount === 0) {
    findings.push({ severity: 'info', title: 'No backers yet', detail: 'Nobody has deposited in this raise yet.' });
    score += 500;
  } else if (m.backerCount < cfg.fewBackers.count) {
    findings.push({ severity: 'warn', title: 'Very few backers', detail: `Only ${backersText(m.backerCount)} so far, so these figures can change quickly.` });
    score += cfg.fewBackers.weight;
  }

  // ---- concentration: only when the sample size makes the metric meaningful ------------
  if (m.backerCount > 0 && m.backerCount < cfg.minBackersForConcentration) {
    findings.push({
      severity: 'info', title: 'Too early to judge how spread out the money is',
      detail: `With only ${backersText(m.backerCount)}, it is too early to tell whether the money is spread across many people.`,
    });
  } else if (m.backerCount >= cfg.minBackersForConcentration) {
    if (equalSplitBaseline('top1', m.backerCount) < cfg.top1Share.warn) {
      score += threshold(findings, m.top1ShareBps, cfg.top1Share, 'One backer holds a large share',
        (v) => `The largest backer put in ${pct(v)} of the money.`);
    }
    if (equalSplitBaseline('top5', m.backerCount) < cfg.top5Share.warn) {
      score += threshold(findings, m.top5ShareBps, cfg.top5Share, 'Five backers hold most of the money',
        (v) => `The five largest backers put in ${pct(v)} of the money.`);
    }
    if (equalSplitBaseline('hhi', m.backerCount) < cfg.herfindahl.warn) {
      score += threshold(findings, m.herfindahlBps, cfg.herfindahl, 'Money concentrated in a few wallets',
        (v) => `Most of the money sits with a few backers (concentration ${pct(v)}, where 100% would be a single backer).`);
    }
  }

  // ---- funding-source clustering / builder self-dealing (the veto drivers) -------------
  score += threshold(findings, m.clusterShareBps, cfg.cluster, 'Several wallets funded by one address',
    (v) => `${m.clusterSize} wallets holding ${pct(v)} of the money got their USDG from the same address${m.clusterFunder ? ` (${short(m.clusterFunder)})` : ''}. One person may be behind several wallets.`);
  score += threshold(findings, m.builderLinkedShareBps, cfg.builderLinked, 'Money from wallets the builder funded',
    (v) => `${pct(v)} of the money came from wallets the builder funded, so the builder may be backing their own project.`);

  // ---- deposit-time burstiness (raise-relative window, meaningful sample only) ---------
  if (input.deposits.length >= cfg.burstMinDeposits) {
    score += threshold(findings, m.burstShareBps, cfg.burst, 'Money arrived in one burst',
      (v) => `${pct(v)} of the money arrived within ${Math.max(1, Math.round(m.burstWindowSec / 60))} minutes, which can mean coordinated funding.`);
  }

  score += threshold(findings, m.duplicateFeedbackShareBps, cfg.duplicateFeedback, 'Copied feedback',
    (v) => `${pct(v)} of the feedback texts are near-copies of each other, a sign of fake reviews.`);

  // ---- feedback presence: informational early, warning only once incubation ran --------
  if (m.backerCount > 0 && m.feedbackCount === 0) {
    const startedAt = input.startedAtSec ?? 0;
    const now = input.nowSec ?? Math.floor(Date.now() / 1000);
    const incubationElapsed = startedAt > 0 && now >= startedAt + minIncubationSec;
    if (incubationElapsed) {
      findings.push({ severity: 'warn', title: 'No feedback yet', detail: 'The minimum incubation time has elapsed and no tester feedback has been submitted.' });
      score += cfg.noFeedback.weight;
    } else {
      findings.push({ severity: 'info', title: 'No feedback yet', detail: 'No tester feedback yet — normal this early in incubation.' });
    }
  }

  const veto =
    m.clusterShareBps >= cfg.vetoClusterShareBps ||
    m.builderLinkedShareBps >= cfg.vetoBuilderLinkedBps;

  const rationale = veto
    ? 'Delay recommended: one person appears to be behind most of the money (see the findings). Backers can still take their money back at cost; a delay only postpones graduation.'
    : findings.some((f) => f.severity === 'critical')
      ? 'Serious warning signs, but not enough to recommend a delay.'
      : findings.length > 0
        ? 'A few things to watch; the backing and feedback look broadly genuine.'
        : 'Nothing unusual: the money is spread out, no wallets share a funder, and no feedback looks copied.';

  return {
    riskScoreBps: Math.min(10_000, score),
    veto,
    rationale,
    findings,
    metrics: m,
  };
}

export const heuristicScorer: Scorer = {
  name: 'heuristic',
  async score(input) {
    const { metrics: _m, ...result } = scoreHeuristic(input);
    return result;
  },
};
