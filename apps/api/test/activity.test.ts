import { describe, test, expect } from 'bun:test';
import { summarizeActivity, formatAtoms, shortAddress, type ActivityContext, type ActivityRow } from '../src/activity.ts';

const BACKER1 = '0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65';
const WHALE = '0xa0Ee7A142d267C1f36714E4a8F75612F20a79720';
const BUILDER = '0x90F79bf6EB2c4f870365E785982E1f101E93b906';
const RANDOM = '0x000000000000000000000000000000000000dEaD';

const usdg = (n: number) => (BigInt(n) * 10n ** 6n).toString();
const tok = (n: number) => (BigInt(n) * 10n ** 18n).toString();

const ctx: ActivityContext = {
  quoteSymbol: 'USDG',
  quoteDecimals: 6,
  tokenSymbol: 'NRM',
  labels: {
    [WHALE.toLowerCase()]: 'whale',
    [BUILDER.toLowerCase()]: 'builder',
  },
  priceBefore: () => '275000000000000000', // 0.275
};

function row(contract: string, name: string, args: Record<string, unknown>): ActivityRow {
  return {
    contract, name, args: JSON.stringify(args),
    txHash: '0xabc', blockNumber: 10, logIndex: 2, timestamp: 1_800_000_000,
  };
}

describe('formatAtoms', () => {
  test('groups thousands and trims decimals', () => {
    expect(formatAtoms(usdg(20_000), 6)).toBe('20,000');
    expect(formatAtoms('275000000000000000', 18, 4)).toBe('0.275');
    expect(formatAtoms(usdg(3750), 6)).toBe('3,750');
  });
});

describe('summarizeActivity', () => {
  test('deposit: human sentence with short address for unknown accounts', () => {
    const s = summarizeActivity(row('raise', 'Deposited', { user: BACKER1, amount: usdg(20_000), shares: usdg(20_000), totalPrincipal: usdg(55_000) }), ctx);
    expect(s).not.toBeNull();
    expect(s!.summary).toBe(`${shortAddress(BACKER1)} deposited 20,000 USDG`);
    expect(s!.actor).toBe(BACKER1);
  });

  test('whale buy: label, formatted amounts and price arrow', () => {
    // post-trade reserves → some higher book price; we only pin the "from" side
    const R = usdg(100_000); const V = usdg(10_000); const T = tok(111_111);
    const s = summarizeActivity(row('pool', 'Buy', {
      trader: WHALE, quoteIn: usdg(100_000), tokensOut: tok(101_432),
      feeReserve: '0', feeVault: '0', feeBuilder: '0', R, V, T,
    }), ctx);
    expect(s!.summary).toMatch(/^Whale bought 101,432 NRM for 100,000 USDG \(price 0\.275 → /);
  });

  test('tranche commit: principal formatted', () => {
    const s = summarizeActivity(row('raise', 'TrancheCommitted', { user: BACKER1, k: 1, principal: usdg(5_000), epoch: 0 }), ctx);
    expect(s!.summary).toContain('committed tranche 1: 5,000 USDG');
  });

  test('report: risk percentage, veto wording', () => {
    const clean = summarizeActivity(row('board', 'ReportPosted', { raise: RANDOM, reportHash: '0x0', uri: '', riskScoreBps: 3100, veto: false, vetoUntil: 0 }), ctx);
    expect(clean!.summary).toBe('AI analyst posted a report: risk 31%, no veto');
    const veto = summarizeActivity(row('board', 'ReportPosted', { raise: RANDOM, reportHash: '0x0', uri: '', riskScoreBps: 6700, veto: true, vetoUntil: 1_800_000_600 }), ctx);
    expect(veto!.summary).toContain('risk 67%, VETO');
  });

  test('internal wiring and noise events are filtered (null)', () => {
    for (const [contract, name] of [
      ['board', 'Initialized'], ['board', 'VetoParamsSet'], ['board', 'FactorySet'],
      ['raise', 'WithdrawLockSet'], ['raise', 'GovernorSpend'],
      ['pool', 'PoolOpened'], ['pool', 'Converted'], ['pool', 'Graduated'],
      ['vault', 'Staked'], ['vault', 'QuoteFeeReceived'], ['vault', 'MigrationStarted'],
      ['factory', 'RaiseConfigured'], ['governor', 'Initialized'],
    ] as const) {
      expect(summarizeActivity(row(contract, name, {}), ctx), `${contract}:${name}`).toBeNull();
    }
  });

  test('governor lifecycle sentences', () => {
    expect(summarizeActivity(row('governor', 'Proposed', { id: 1, amount: usdg(1_000), uri: 'https://x', votingEnds: 1, disputeEnds: 2, totalPrincipalSnapshot: usdg(30_000) }), ctx)!.summary)
      .toContain('Builder proposed to spend 1,000 USDG');
    expect(summarizeActivity(row('governor', 'Voted', { id: 1, voter: BACKER1, support: true, weight: usdg(15_000) }), ctx)!.summary)
      .toContain('voted YES with 15,000 USDG');
    expect(summarizeActivity(row('governor', 'Executed', { id: 1, amount: usdg(1_000), to: BUILDER }), ctx)!.summary)
      .toContain('Spend executed: 1,000 USDG paid to the builder');
  });

  test('raise creation names the builder by label', () => {
    const s = summarizeActivity(row('factory', 'RaiseCreated', { raise: RANDOM, builder: BUILDER }), ctx);
    expect(s!.summary).toBe('Builder created this raise');
    expect(s!.actor).toBe(BUILDER);
  });
});
