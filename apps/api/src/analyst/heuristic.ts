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
    findings.push({ severity: 'info', title: 'No backers yet', detail: 'The raise has no principal deposited.' });
    score += 500;
  } else if (m.backerCount < cfg.fewBackers.count) {
    findings.push({ severity: 'warn', title: 'Very few backers', detail: `Only ${m.backerCount} backer(s); concentration metrics are fragile at this sample size.` });
    score += cfg.fewBackers.weight;
  }

  // ---- concentration: only when the sample size makes the metric meaningful ------------
  if (m.backerCount > 0 && m.backerCount < cfg.minBackersForConcentration) {
    findings.push({
      severity: 'info', title: 'Too few backers to assess concentration',
      detail: `Only ${m.backerCount} backer(s) — with fewer than ${cfg.minBackersForConcentration}, the top-5 share is trivially 100% and the Herfindahl index says nothing.`,
    });
  } else if (m.backerCount >= cfg.minBackersForConcentration) {
    if (equalSplitBaseline('top1', m.backerCount) < cfg.top1Share.warn) {
      score += threshold(findings, m.top1ShareBps, cfg.top1Share, 'Single-backer dominance',
        (v) => `The largest backer holds ${pct(v)} of principal.`);
    }
    if (equalSplitBaseline('top5', m.backerCount) < cfg.top5Share.warn) {
      score += threshold(findings, m.top5ShareBps, cfg.top5Share, 'Top-5 concentration',
        (v) => `The five largest backers hold ${pct(v)} of principal.`);
    }
    if (equalSplitBaseline('hhi', m.backerCount) < cfg.herfindahl.warn) {
      score += threshold(findings, m.herfindahlBps, cfg.herfindahl, 'High Herfindahl index',
        (v) => `Herfindahl concentration index is ${pct(v)} (10k = one holder).`);
    }
  }

  // ---- funding-source clustering / builder self-dealing (the veto drivers) -------------
  score += threshold(findings, m.clusterShareBps, cfg.cluster, 'Funding-source clustering',
    (v) => `${pct(v)} of principal sits in ${m.clusterSize} wallets whose quote tokens came from a single sender${m.clusterFunder ? ` (${m.clusterFunder})` : ''} — consistent with one actor behind many wallets.`);
  score += threshold(findings, m.builderLinkedShareBps, cfg.builderLinked, 'Builder-linked capital',
    (v) => `${pct(v)} of principal was deposited by wallets funded by the builder — the builder may be backing their own raise.`);

  // ---- deposit-time burstiness (raise-relative window, meaningful sample only) ---------
  if (input.deposits.length >= cfg.burstMinDeposits) {
    score += threshold(findings, m.burstShareBps, cfg.burst, 'Deposit burst',
      (v) => `${pct(v)} of all deposited principal arrived within a single ${m.burstWindowSec}s window (${Math.round(m.burstWindowSec / 60)} min = 1/${cfg.burstWindowFraction} of this raise's minimum incubation) — coordinated funding pattern.`);
  }

  score += threshold(findings, m.duplicateFeedbackShareBps, cfg.duplicateFeedback, 'Duplicate feedback',
    (v) => `${pct(v)} of feedback texts are near-duplicates — astroturfing signal.`);

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
    ? 'Veto: capital concentration indicates a single actor behind most of the raise (see critical findings). Stage 1 principal can always be taken back at cost; the veto only delays graduation.'
    : findings.some((f) => f.severity === 'critical')
      ? 'Elevated risk from concentration/feedback signals, below the veto threshold.'
      : findings.length > 0
        ? 'Moderate risk signals detected; distribution and feedback look broadly organic.'
        : 'No suspicious concentration, funding clustering, or feedback anomalies detected.';

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
