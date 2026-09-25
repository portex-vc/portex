import type { Ctx } from '../lib/context';

export interface ScenarioResult {
  id: string;
  title: string;
  /** One-paragraph verdict for the index. */
  verdict: string;
  /** Short metric string for the summary table. */
  headline: string;
  skipped?: boolean;
  failed?: boolean;
  durationMs?: number;
}

export interface Scenario {
  id: string;
  title: string;
  run: (ctx: Ctx) => Promise<ScenarioResult>;
}

import { s1 } from './s1';
import { s2 } from './s2';
import { s3 } from './s3';
import { s4 } from './s4';
import { s5 } from './s5';
import { s6 } from './s6';
import { s7 } from './s7';
import { s8 } from './s8';

export const SCENARIOS: Scenario[] = [s1, s2, s3, s4, s5, s6, s7, s8];
