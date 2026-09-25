/**
 * Stage occupancy for the launch controller (pure, unit-tested). Counts catalog projects per stage with a look-ahead
 * and names the gap the next launch should fill.
 */
import type { RaiseSnapshot } from './protocol';
import type { ProjectState } from './state';

export interface Occupancy {
  stage1: number;
  stage2: number;
  stage3: number;
  /** Projects that will list within the look-ahead (ListingPending, Stage 2 ending, fast Stage 1 graduates). */
  listingSoon: number;
}

export interface OccupancyTargets {
  stage1Min: number;
  stage2Min: number;
  stage3Min: number;
}

export type Gap = 'stage3' | 'stage2' | 'stage1' | null;

/**
 * A project leaving a stage within `lookaheadSec` no longer counts there, and a graduating project about to enter
 * the next stage already counts for it. Raises created by others and finished projects are ignored.
 */
export function countOccupancy(
  projects: ProjectState[],
  snapOf: (p: ProjectState) => RaiseSnapshot | undefined,
  now: number,
  lookaheadSec: number,
): Occupancy {
  const ahead = now + lookaheadSec;
  const o: Occupancy = { stage1: 0, stage2: 0, stage3: 0, listingSoon: 0 };
  for (const p of projects) {
    if (p.external) continue;
    const s = p.raise ? snapOf(p) : undefined;
    const phase = s?.phase ?? p.lastPhase;
    if (phase === 'Stage3') {
      o.stage3++;
      continue;
    }
    if (p.done) continue;
    if (!p.raise) {
      o.stage1++; // launch in flight
      continue;
    }
    if (!s) continue;
    if (s.phase === 'Stage1') {
      if (s.stage1End > ahead) o.stage1++;
      else if (p.fate === 'graduate') {
        if (s.stage1End + p.stage2Length > ahead) o.stage2++;
        else o.listingSoon++;
      }
    } else if (s.phase === 'Stage2') {
      if (s.stage2End > ahead) o.stage2++;
      else o.listingSoon++;
    } else if (s.phase === 'ListingPending') {
      o.listingSoon++;
    }
  }
  return o;
}

/**
 * The stage the next launch should fill, most urgent first: an empty Stage 3 with nothing about to list, then Stage 2,
 * then Stage 1.
 */
export function gapFor(o: Occupancy, t: OccupancyTargets): Gap {
  if (o.stage3 < t.stage3Min && o.listingSoon === 0) return 'stage3';
  if (o.stage2 < t.stage2Min) return 'stage2';
  if (o.stage1 < t.stage1Min) return 'stage1';
  return null;
}
