import { describe, test, expect } from 'bun:test';
import { scoreHeuristic, HEURISTIC_CONFIG } from '../src/analyst/heuristic.ts';
import { computeMetrics } from '../src/analyst/metrics.ts';
import type { ScorerInput } from '../src/analyst/types.ts';

const BUILDER = '0x90F79bf6EB2c4f870365E785982E1f101E93b906';
const FUNDER = '0xa0Ee7A142d267C1f36714E4a8F75612F20a79720';

let addrCounter = 0;
function addr(): string {
  addrCounter++;
  return `0x${String(addrCounter).padStart(40, '0')}`;
}

const usdg = (n: number) => (BigInt(n) * 10n ** 6n).toString();

function honestRaise(): ScorerInput {
  const backers: ScorerInput['backers'] = [];
  const deposits: ScorerInput['deposits'] = [];
  const funding: ScorerInput['funding'] = [];
  const feedback: ScorerInput['feedback'] = [];
  const t0 = 1_800_000_000;
  for (let i = 0; i < 30; i++) {
    const user = addr();
    const amount = 500 + ((i * 137) % 900); // 500..1400 USDG, spread
    backers.push({ user, principal: usdg(amount) });
    // deposits spread over 10 hours
    deposits.push({ user, amount: usdg(amount), timestamp: t0 + i * 1200 });
    // every wallet funded by a *different* source (or minted directly)
    funding.push({ user, funder: i % 3 === 0 ? null : addr() });
    if (i % 4 === 0) {
      feedback.push({
        author: user, rating: 3 + (i % 3), createdAt: t0 + i * 1300,
        text: `Tested the product for a few days — impression number ${i}, genuinely different text ${i * 7}.`,
        isBacker: true,
      });
    }
  }
  return {
    raise: addr(), builder: BUILDER, backers, deposits, funding, feedback,
    minIncubationSec: 43_200, startedAtSec: t0, nowSec: t0 + 36_000,
  };
}

function sybilRaise(): ScorerInput {
  const backers: ScorerInput['backers'] = [];
  const deposits: ScorerInput['deposits'] = [];
  const funding: ScorerInput['funding'] = [];
  const t0 = 1_800_000_000;
  for (let i = 0; i < 20; i++) {
    const user = addr();
    backers.push({ user, principal: usdg(1000) });
    // all 20 deposits within 4 minutes
    deposits.push({ user, amount: usdg(1000), timestamp: t0 + i * 12 });
    // every wallet received its quote tokens from ONE funder
    funding.push({ user, funder: FUNDER });
  }
  return {
    raise: addr(), builder: BUILDER, backers, deposits, funding, feedback: [],
    minIncubationSec: 3600, startedAtSec: t0, nowSec: t0 + 300,
  };
}

function builderFundedRaise(): ScorerInput {
  const backers: ScorerInput['backers'] = [];
  const deposits: ScorerInput['deposits'] = [];
  const funding: ScorerInput['funding'] = [];
  const t0 = 1_800_000_000;
  // 6 wallets funded by the builder holding 60% of principal
  for (let i = 0; i < 6; i++) {
    const user = addr();
    backers.push({ user, principal: usdg(2000) });
    deposits.push({ user, amount: usdg(2000), timestamp: t0 + i * 3600 });
    funding.push({ user, funder: BUILDER });
  }
  // 4 organic backers holding 40%
  for (let i = 0; i < 4; i++) {
    const user = addr();
    backers.push({ user, principal: usdg(2000) });
    deposits.push({ user, amount: usdg(2000), timestamp: t0 + i * 3700 });
    funding.push({ user, funder: null });
  }
  return {
    raise: addr(), builder: BUILDER, backers, deposits, funding, feedback: [],
    minIncubationSec: 43_200, startedAtSec: t0, nowSec: t0 + 20_000,
  };
}

/**
 * The honest localhost demo from the review: 3 backers × 20,000 USDG, deposits a few
 * minutes apart, no feedback yet. Must score LOW with no critical findings — with 3
 * backers top-5 is trivially 100% and a fixed 300 s burst window trivially trips, so
 * this case pins the raise-relative thresholds.
 */
function threeBackerDemo(opts?: { late?: boolean }): ScorerInput {
  const backers: ScorerInput['backers'] = [];
  const deposits: ScorerInput['deposits'] = [];
  const funding: ScorerInput['funding'] = [];
  const t0 = 1_800_000_000;
  for (let i = 0; i < 3; i++) {
    const user = addr();
    backers.push({ user, principal: usdg(20_000) });
    deposits.push({ user, amount: usdg(20_000), timestamp: t0 + i * 200 });
    funding.push({ user, funder: null }); // faucet mints — no external funder
  }
  return {
    raise: addr(), builder: BUILDER, backers, deposits, funding, feedback: [],
    minIncubationSec: 600, startedAtSec: t0,
    nowSec: opts?.late ? t0 + 700 : t0 + 300, // late = past minIncubation
  };
}

describe('heuristic scorer', () => {
  test('honest raise: no veto, no critical findings, low risk', () => {
    const r = scoreHeuristic(honestRaise());
    expect(r.veto).toBe(false);
    expect(r.findings.filter((f) => f.severity === 'critical')).toHaveLength(0);
    expect(r.riskScoreBps).toBeLessThan(4000);
  });

  test('one funder behind 20 wallets: clustering detected, veto', () => {
    const r = scoreHeuristic(sybilRaise());
    expect(r.metrics.clusterShareBps).toBe(10_000);
    expect(r.metrics.clusterSize).toBe(20);
    expect(r.veto).toBe(true);
    const crit = r.findings.filter((f) => f.severity === 'critical').map((f) => f.title);
    expect(crit).toContain('Funding-source clustering');
    expect(r.riskScoreBps).toBeGreaterThanOrEqual(HEURISTIC_CONFIG.cluster.critWeight);
  });

  test('builder-funded wallets: builder-linked share triggers veto', () => {
    const r = scoreHeuristic(builderFundedRaise());
    expect(r.metrics.builderLinkedShareBps).toBe(6000);
    expect(r.veto).toBe(true);
    const titles = r.findings.map((f) => f.title);
    expect(titles).toContain('Builder-linked capital');
  });

  test('metrics: herfindahl and burstiness on synthetic data', () => {
    const m = computeMetrics(sybilRaise());
    // 20 equal backers -> HHI = 20 * (1/20)^2 = 5%
    expect(m.herfindahlBps).toBe(500);
    // all deposits inside one window
    expect(m.burstShareBps).toBe(10_000);
    // top1 = 5%, top5 = 25%
    expect(m.top1ShareBps).toBe(500);
    expect(m.top5ShareBps).toBe(2500);
  });

  test('metrics: honest raise has no dominant cluster', () => {
    const m = computeMetrics(honestRaise());
    expect(m.clusterShareBps).toBeLessThan(1000);
    expect(m.builderLinkedShareBps).toBe(0);
    expect(m.burstShareBps).toBeLessThan(2000);
    expect(m.feedbackCount).toBeGreaterThan(0);
    expect(m.duplicateFeedbackShareBps).toBe(0);
  });

  test('duplicate feedback is flagged', () => {
    const input = honestRaise();
    input.feedback = [];
    for (let i = 0; i < 8; i++) {
      input.feedback.push({ author: addr(), rating: 5, text: 'Amazing product, best AI ever!', isBacker: false, createdAt: 1_800_000_000 + i });
    }
    const r = scoreHeuristic(input);
    expect(r.metrics.duplicateFeedbackShareBps).toBeGreaterThanOrEqual(8000);
    expect(r.findings.map((f) => f.title)).toContain('Duplicate feedback');
  });

  test('3-backer honest demo: low risk, no critical findings, no veto', () => {
    const r = scoreHeuristic(threeBackerDemo());
    expect(r.veto).toBe(false);
    expect(r.findings.filter((f) => f.severity === 'critical')).toHaveLength(0);
    expect(r.findings.filter((f) => f.severity === 'warn')).toHaveLength(0);
    expect(r.riskScoreBps).toBeLessThan(1000);
    // concentration is explained, not penalised
    const info = r.findings.find((f) => f.title === 'Too few backers to assess concentration');
    expect(info?.severity).toBe('info');
    // no feedback this early is informational, not a warning
    expect(r.findings.find((f) => f.title === 'No feedback yet')?.severity).toBe('info');
  });

  test('3-backer demo late in incubation: "no feedback" becomes a warning', () => {
    const r = scoreHeuristic(threeBackerDemo({ late: true }));
    expect(r.veto).toBe(false);
    expect(r.findings.filter((f) => f.severity === 'critical')).toHaveLength(0);
    expect(r.findings.find((f) => f.title === 'No feedback yet')?.severity).toBe('warn');
    expect(r.riskScoreBps).toBeLessThan(2000);
  });

  test('burst window scales with the raise minIncubation', () => {
    // demo raise: minIncubation 600 s -> 50 s window; 3 deposits 200 s apart are NOT a burst
    const demo = scoreHeuristic(threeBackerDemo());
    expect(demo.metrics.burstWindowSec).toBe(50);
    // a production-scale raise gets a proportionally larger window
    const prod = scoreHeuristic({ ...threeBackerDemo(), minIncubationSec: 30 * 86_400 });
    expect(prod.metrics.burstWindowSec).toBe(216_000);
  });

  test('equal-split raises are never flagged for concentration at any backer count', () => {
    for (const n of [5, 6, 9, 12]) {
      const input = threeBackerDemo();
      input.backers = [];
      input.deposits = [];
      input.funding = [];
      for (let i = 0; i < n; i++) {
        const user = addr();
        input.backers.push({ user, principal: usdg(5000) });
        input.deposits.push({ user, amount: usdg(5000), timestamp: 1_800_000_000 + i * 400 });
        input.funding.push({ user, funder: null });
      }
      input.feedback = [{ author: addr(), rating: 4, text: 'works', isBacker: true, createdAt: 1_800_000_100 }];
      const r = scoreHeuristic(input);
      const concentration = r.findings.filter((f) =>
        ['Single-backer dominance', 'Top-5 concentration', 'High Herfindahl index'].includes(f.title));
      expect(concentration).toHaveLength(0);
    }
  });
});
