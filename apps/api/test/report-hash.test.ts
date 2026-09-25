import { describe, test, expect } from 'bun:test';
import { canonicalJson, reportHashOf, panelVerdict } from '../src/analyst/panel.ts';
import type { ScorerResult } from '../src/analyst/types.ts';

describe('canonical JSON', () => {
  test('object keys are sorted recursively, arrays keep order', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
    expect(canonicalJson([{ z: 1, y: 2 }, { a: [3, 1, 2] }])).toBe('[{"y":2,"z":1},{"a":[3,1,2]}]');
  });

  test('key order of the input does not change the output', () => {
    const a = canonicalJson({ x: 1, m: { b: 2, a: 1 }, arr: [1, 2] });
    const b = canonicalJson({ arr: [1, 2], m: { a: 1, b: 2 }, x: 1 });
    expect(a).toBe(b);
  });

  test('undefined fields are dropped; strings/numbers/bools/null preserved', () => {
    expect(canonicalJson({ a: undefined, b: null, c: 's', d: 0, e: false }))
      .toBe('{"b":null,"c":"s","d":0,"e":false}');
  });
});

describe('report hashing', () => {
  const preimage = canonicalJson({
    raise: '0xabc', createdAt: 1800000000, riskScoreBps: 6000, veto: true,
    findings: [{ severity: 'critical', title: 't', detail: 'd' }],
    metrics: { backerCount: 20 },
    panel: [{ scorer: 'heuristic', riskScoreBps: 6000, veto: true, rationale: 'r' }],
  });

  test('fixed vector', () => {
    expect(preimage).toBe(
      '{"createdAt":1800000000,"findings":[{"detail":"d","severity":"critical","title":"t"}],' +
      '"metrics":{"backerCount":20},"panel":[{"rationale":"r","riskScoreBps":6000,"scorer":"heuristic","veto":true}],' +
      '"raise":"0xabc","riskScoreBps":6000,"veto":true}',
    );
    expect(reportHashOf(preimage)).toBe('0xc3713174b9c5075ec134a0456cf73df9133e9766abcb665a1e5616317a238070');
  });

  test('keccak256 of the empty string (sanity)', () => {
    expect(reportHashOf('')).toBe('0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470');
  });
});

describe('panel verdict', () => {
  const r = (riskScoreBps: number, veto: boolean): ScorerResult => ({ riskScoreBps, veto, rationale: '', findings: [] });

  test('risk = median, veto = strict majority', () => {
    expect(panelVerdict([r(1000, false)])).toEqual({ riskScoreBps: 1000, veto: false });
    expect(panelVerdict([r(6000, true)])).toEqual({ riskScoreBps: 6000, veto: true });
    // 1 of 2 vetoes is NOT a strict majority
    expect(panelVerdict([r(2000, false), r(9000, true)])).toEqual({ riskScoreBps: 5500, veto: false });
    // 2 of 3 vetoes is a strict majority
    expect(panelVerdict([r(2000, true), r(5000, true), r(9000, false)])).toEqual({ riskScoreBps: 5000, veto: true });
    // odd median
    expect(panelVerdict([r(1000, false), r(3000, false), r(9000, true)])).toEqual({ riskScoreBps: 3000, veto: false });
  });

  test('empty panel throws', () => {
    expect(() => panelVerdict([])).toThrow();
  });
});
