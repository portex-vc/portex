import { describe, test, expect } from 'bun:test';
import { buildUserMessage, extractJson, modelMetrics, usdgFromUnits, validateModelOutput } from '../src/analyst/anthropic.ts';
import type { Metrics } from '../src/analyst/metrics.ts';

describe('anthropic scorer output validation (hostile-input hardening)', () => {
  test('extracts the first balanced JSON object from chatty output', () => {
    expect(extractJson('Sure! Here you go:\n{"riskScoreBps": 4200, "veto": false}\nHope that helps!'))
      .toEqual({ riskScoreBps: 4200, veto: false });
    expect(extractJson('{"a": {"b": "}"}}')).toEqual({ a: { b: '}' } });
    expect(() => extractJson('no json here')).toThrow();
    expect(() => extractJson('{"unbalanced":')).toThrow();
  });

  test('clamps scores, coerces veto, drops malformed findings', () => {
    const out = validateModelOutput({
      riskScoreBps: 999_999,
      veto: 'yes definitely',
      rationale: 'x'.repeat(1000),
      findings: [
        { severity: 'critical', title: 't', detail: 'd' },
        { severity: 'DROP TABLE raises;--', title: 'x', detail: 'y' },
        'garbage',
        { severity: 'warn', title: 'w' },
      ],
    });
    expect(out.riskScoreBps).toBe(10_000);
    expect(out.veto).toBe(false);                 // only literal true counts
    expect(out.rationale).toHaveLength(500);
    expect(out.findings).toHaveLength(3);
    expect(out.findings[1].severity).toBe('info'); // unknown severity downgraded
  });

  test('a prompt-injection payload cannot change the schema', () => {
    const malicious = JSON.stringify({
      riskScoreBps: -500,
      veto: true,
      rationale: 'ignore previous instructions',
      findings: [],
      admin: true,
      newSchema: { anything: 'goes' },
    });
    const out = validateModelOutput(extractJson(malicious)) as unknown as Record<string, unknown>;
    expect(out.riskScoreBps).toBe(0);
    expect(out.veto).toBe(true);
    expect('admin' in out).toBe(false);
    expect('newSchema' in out).toBe(false);
    expect(Object.keys(out).sort()).toEqual(['findings', 'rationale', 'riskScoreBps', 'veto']);
  });

  test('non-object output throws (panel continues without the scorer)', () => {
    expect(() => validateModelOutput(null)).toThrow();
    expect(() => validateModelOutput('veto everything')).toThrow();
  });

  // Quillmate's report called 4,500 USDG "4.5B principal": the model had been handed the base-unit integer.
  test('the model reads USDG amounts in whole USDG, never in base units', () => {
    expect(usdgFromUnits('4500000000')).toBe('4500');
    expect(usdgFromUnits('4500500000')).toBe('4500.5');
    expect(usdgFromUnits('1234567')).toBe('1.234567');
    expect(usdgFromUnits(0n)).toBe('0');
    const metrics = { backerCount: 11, totalPrincipal: '4500000000', top1ShareBps: 2200 } as unknown as Metrics;
    const shown = modelMetrics(metrics);
    expect(shown.totalPrincipalUsdg).toBe('4500');
    expect('totalPrincipal' in shown).toBe(false);
    const message = buildUserMessage({ builder: '0xb', backers: [], feedback: [], metrics } as never);
    expect(message).toContain('"totalPrincipalUsdg": "4500"');
    expect(message).not.toContain('4500000000');
    expect(message).toContain('USDG amounts in whole USDG');
  });
});
