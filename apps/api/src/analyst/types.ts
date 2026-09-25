/** Analyst panel types (Portex v1 design §5.6 / §7). */

export interface Finding {
  severity: 'info' | 'warn' | 'critical';
  title: string;
  detail: string;
}

export interface ScorerInput {
  raise: string;                 // checksummed address
  builder: string;               // checksummed address
  /** Current backers with net principal > 0 (quote units, decimal strings). */
  backers: { user: string; principal: string }[];
  /** Raw deposit events for timing analysis. */
  deposits: { user: string; amount: string; timestamp: number }[];
  /** Who funded each backer's wallet with quote tokens (null = minted/self, no external funder). */
  funding: { user: string; funder: string | null }[];
  feedback: { author: string; rating: number; text: string; isBacker: boolean; createdAt: number }[];
  /** Raise timing, so thresholds scale with the raise instead of absolute seconds. */
  minIncubationSec?: number;     // RaiseConfig.minIncubation (defaults to the 30-day production default)
  startedAtSec?: number;         // raise start (chain time)
  nowSec?: number;               // analysis time (defaults to wall clock)
}

export interface ScorerResult {
  riskScoreBps: number;          // 0..10_000
  veto: boolean;
  rationale: string;
  findings: Finding[];
}

export interface Scorer {
  name: string;
  score(input: ScorerInput): Promise<ScorerResult>;
}

export interface Report {
  raise: string;
  createdAt: number;
  riskScoreBps: number;
  veto: boolean;
  findings: Finding[];
  metrics: Record<string, number | string>;
  panel: { scorer: string; riskScoreBps: number; veto: boolean; rationale: string }[];
  reportHash: string;
  uri: string;
  postedTx: string | null;
  /** The builder's signed public response to this report, if any. */
  builderResponse: { text: string; createdAt: number } | null;
}
