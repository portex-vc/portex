import { describe, expect, test } from 'bun:test';
import {
  PROJECTS,
  FEEDBACK,
  validateCatalog,
  sizing,
  curveCost,
  remainingFillCost,
  markPng,
  markSpec,
  profileBody,
} from './catalog';
import { loadConfig } from './lib/config';
import { PERSONA_MIX } from './lib/wallets';
import { rng } from './lib/random';
import { BlockNotFoundError, HttpRequestError, InvalidParamsRpcError } from 'viem';
import { isRangeError, isTransient } from './lib/chain';

describe('catalog', () => {
  test('72 valid projects with unique tickers and a mix of launch types', () => {
    expect(validateCatalog()).toEqual([]);
    expect(PROJECTS.length).toBe(72);
    const budget = PROJECTS.filter((p) => p.template === 'BUDGET_LAUNCH').length;
    expect(budget).toBeGreaterThanOrEqual(10);
    expect(PROJECTS.length - budget).toBeGreaterThanOrEqual(18);
    for (const p of PROJECTS) expect(FEEDBACK[p.category].length).toBeGreaterThan(0);
  });

  test('no real domains and no securities or failure vocabulary', () => {
    for (const p of PROJECTS) {
      const body = profileBody(p);
      expect(body.website).toBe(`https://${p.slug}.example`);
      const text = [p.pitch, ...p.description, ...p.updates.flatMap((u) => [u.title, u.body])].join(' ').toLowerCase();
      for (const word of ['shareholder', 'dividend', 'equity', 'refunded', 'failed', '.com', '.io'])
        expect(text).not.toContain(word);
    }
  });

  test('a sold-out Stage 1 raises FDV / 6 on the exact curve', () => {
    for (const p of PROJECTS) {
      const { supply, targetPrice, fdv } = sizing(p);
      expect((targetPrice * supply) / 10n ** 18n).toBeGreaterThanOrEqual(100_000n * 10n ** 18n);
      const escrow = remainingFillCost(targetPrice, supply, 0n);
      expect(Math.abs(Number(escrow) / 1e6 - fdv / 6)).toBeLessThan(1);
    }
    // Rounding up, and additive across partial fills (to within one unit per step).
    const alloc = 200_000n * 10n ** 18n;
    const t = 10n ** 17n;
    const whole = curveCost(t, alloc, 0n, alloc);
    const split = curveCost(t, alloc, 0n, alloc / 2n) + curveCost(t, alloc, alloc / 2n, alloc / 2n);
    expect(split - whole >= 0n && split - whole <= 1n).toBe(true);
    expect(() => curveCost(t, alloc, alloc, 1n)).toThrow();
  });
});

describe('marks', () => {
  test('deterministic 512x512 PNGs, distinct per project', () => {
    const a = markPng(PROJECTS[0]);
    const b = markPng(PROJECTS[0]);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
    expect([...a.slice(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const view = new DataView(a.buffer, a.byteOffset);
    expect(view.getUint32(16)).toBe(512);
    expect(view.getUint32(20)).toBe(512);
    expect(a.length).toBeLessThan(64 * 1024);
    const specs = new Set(PROJECTS.map((p) => `${markSpec(p).motif}/${markSpec(p).palette}`));
    expect(specs.size).toBe(PROJECTS.length);
  });
});

describe('config and personas', () => {
  test('defaults follow the founder cadence: opening batch, then one launch about every two hours', () => {
    const c = loadConfig();
    expect(c.bootstrap.launches).toBe(5);
    expect(c.steady.launchEveryMinutes).toEqual([110, 130]);
    expect(c.steady.launchBatch).toEqual([1, 1]);
    expect(c.steady.stage1Minutes).toEqual([180, 300]);
    expect(c.steady.stage2Minutes).toEqual([480, 720]);
    expect(c.steady.dissolveShare).toBe(0.45);
    expect(c.stage2.quietTradesPerHour).toBe(12);
    expect(c.stage3.quietSwapsPerHour).toBe(10);
    expect(c.occupancy).toMatchObject({ stage1Min: 2, stage2Min: 2, maxGapFillsPerHour: 1 });
    expect(c.volume.dailyUsdg).toEqual([5000, 40000]);
  });

  test('tempo config loads and accepts typed overrides', () => {
    const c = loadConfig(undefined, ['tickSeconds=5', 'steady.launchEveryMinutes=[30,45]']);
    expect(c.tickSeconds).toBe(5);
    expect(c.steady.launchEveryMinutes).toEqual([30, 45]);
    expect(() => loadConfig(undefined, ['nope=1'])).toThrow();
    expect(() => loadConfig(undefined, ['tickSeconds="x"'])).toThrow();
  });

  test('about forty personas across every behaviour', () => {
    const total = PERSONA_MIX.reduce((n, [, count]) => n + count, 0);
    expect(total).toBe(40);
    expect(PERSONA_MIX.map(([kind]) => kind).sort()).toEqual([
      'builder',
      'conservative',
      'rollover',
      'stage2',
      'stage3',
      'voter',
      'whale',
    ]);
  });

  test('seeded randomness is reproducible and lognormal sizes are positive', () => {
    const a = rng('x');
    const b = rng('x');
    const xs = Array.from({ length: 50 }, () => a.lognormal(100, 0.9));
    expect(xs).toEqual(Array.from({ length: 50 }, () => b.lognormal(100, 0.9)));
    expect(xs.every((x) => x > 0)).toBe(true);
  });
});

describe('rpc error classification', () => {
  test('load-balanced RPC disagreements are transient; range caps shrink instead', () => {
    expect(isTransient(new BlockNotFoundError({ blockNumber: 0n }))).toBe(true);
    expect(isTransient(new Error('Block could not be found.'))).toBe(true);
    expect(isTransient(new Error('block is out of range'))).toBe(true);
    expect(isTransient(new Error('header not found'))).toBe(true);
    expect(
      isTransient(new HttpRequestError({ url: 'https://rpc.test', status: 503, details: 'Service Unavailable' })),
    ).toBe(true);
    const range = new InvalidParamsRpcError(new Error('block range greater than 100 max') as never);
    expect(isRangeError(new Error('-32602 block range greater than 100 max'))).toBe(true);
    expect(isRangeError(range) || isRangeError(new Error(String(range.details)))).toBe(true);
    expect(isTransient(new Error('-32602 block range greater than 100 max'))).toBe(false);
    expect(isTransient(new Error('execution reverted: StaleNonce()'))).toBe(false);
  });
});
