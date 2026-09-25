import { keccak256, stringToHex } from 'viem';
import type { Report, ScorerResult } from './types.ts';

/**
 * Canonical JSON: object keys sorted recursively, arrays kept in order, no whitespace.
 * Used as the preimage of reportHash so anyone can recompute it.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'bigint') return JSON.stringify(value.toString());
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
    return `{${entries.join(',')}}`;
  }
  throw new Error(`cannot canonicalize value of type ${typeof value}`);
}

/** The report fields committed to by reportHash (uri/reportHash/postedTx/builderResponse are excluded). */
export function reportPreimage(r: Omit<Report, 'reportHash' | 'uri' | 'postedTx' | 'builderResponse'>): string {
  return canonicalJson({
    raise: r.raise,
    createdAt: r.createdAt,
    riskScoreBps: r.riskScoreBps,
    veto: r.veto,
    findings: r.findings,
    metrics: r.metrics,
    panel: r.panel,
  });
}

export function reportHashOf(preimage: string): `0x${string}` {
  return keccak256(stringToHex(preimage));
}

/** Median of risk scores (rounded); veto by STRICT majority of scorers. */
export function panelVerdict(results: ScorerResult[]): { riskScoreBps: number; veto: boolean } {
  if (results.length === 0) throw new Error('panel is empty');
  const scores = results.map((r) => r.riskScoreBps).sort((a, b) => a - b);
  const mid = Math.floor(scores.length / 2);
  const median = scores.length % 2 === 1
    ? scores[mid]
    : Math.round((scores[mid - 1] + scores[mid]) / 2);
  const vetoes = results.filter((r) => r.veto).length;
  return { riskScoreBps: median, veto: vetoes > results.length / 2 };
}
