/** Resumable state under tools/mock/state/<chainId>/ (gitignored). Writes are atomic (tmp + rename). */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const STATE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../state');

export function stateDir(chainId: number): string {
  const dir = resolve(STATE_ROOT, String(chainId));
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function readJson<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

export function writeJsonAtomic(path: string, value: unknown, mode?: number): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(
    tmp,
    JSON.stringify(value, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2) + '\n',
    mode ? { mode } : undefined,
  );
  if (mode) chmodSync(tmp, mode);
  renameSync(tmp, path);
}

export type Fate = 'graduate' | 'dissolve-builder' | 'dissolve-deadline';
/** Where the seed wants a project to stop; the runner ignores it once the seed is done. */
export type Hold = 'Stage1' | 'Stage2' | 'ListingPending' | null;

export interface PositionRecord {
  id: string;
  owner: number;
  class: 'Backer' | 'Builder';
  /** Set once the position is fully exited, claimed, or rolled out. */
  closed?: 'exit' | 'protected' | 'claim' | 'rollover' | 'listed';
}

export interface ProposalRecord {
  id: string;
  kind: 'draw' | 'spend';
  /** Stage 2: position ids that voted; Stage 3: persona indexes that voted. */
  voters: string[];
  proposedBlock?: number;
  /** Each voter's decision (persona label to vote and one-line reason), from AI judgment or the template. */
  decisions?: Record<string, { vote: 'yes' | 'no' | 'abstain'; reason: string; source: 'ai' | 'template' }>;
  finalized?: boolean;
  executed?: boolean;
  closed?: boolean;
}

/** One persona's due-diligence decision on a raise (round 0), or a later keep-or-exit review (round > 0). */
export interface ReviewRecord {
  persona: number;
  round: number;
  dueAt: number;
  status: 'scheduled' | 'done';
  source?: 'ai' | 'template';
  verdict?: 'back' | 'pass' | 'watch';
  conviction?: number;
  amountUsdg?: number;
  rating?: number;
  feedback?: string;
  question?: string;
  /** Deposit made on this decision (quote units). */
  deposited?: string;
  acted?: boolean;
  feedbackPosted?: boolean;
  at?: number;
}

export interface ProjectState {
  ticker: string;
  /** Catalog entry behind a relaunch ("v2", "v3" after the catalog runs out); absent means `ticker`. */
  catalogTicker?: string;
  /** A raise created by someone other than the mock builders (a real user's project). */
  external?: boolean;
  name?: string;
  builder: number;
  template: 'ESCROW_LAUNCH' | 'BUDGET_LAUNCH';
  fate: Fate;
  hold?: Hold;
  stage1Length: number;
  stage2Length: number;
  /** Chain time the launch was scheduled for. */
  scheduledAt: number;
  /** Block number right before the create transaction was sent (used to recover a lost receipt). */
  createFromBlock?: number;
  createTx?: string;
  raise?: string;
  modules?: { token: string; vesting: string; governor: string; claims: string; adapter: string };
  treasury?: string;
  createdAt?: number;
  createdBlock?: number;
  /** Fraction of Stage 1 by which the sale should be sold out (graduating projects). */
  fillBy: number;
  /** Target share of the allocation a dissolving project reaches. */
  partialFill: number;
  positions: PositionRecord[];
  proposals: ProposalRecord[];
  exits: { stage1: number; stage2: number };
  image?: { uri: string; url: string };
  profileSet?: boolean;
  updatesPosted: number;
  feedbackPosted: number;
  market: {
    mood: number;
    burst: number;
    trades: number;
    swaps: number;
    sentiment?: number;
    sentimentAt?: number;
    /** Daily volume target in USDG for this project's market (drawn once). */
    dailyVolume?: number;
    /** Traded USDG so far (Stage 2 and Stage 3) and the chain time trading started. */
    volume?: number;
    volumeSince?: number;
    /** Self-calibrating size multiplier that steers realized volume toward the target, and when it last moved. */
    volumeBoost?: number;
    boostAt?: number;
  };
  reviews?: ReviewRecord[];
  /** External raises: what the personas deposited in total (quote units), capped by ai.externalCapShare. */
  externalDeposited?: string;
  listedSeen?: boolean;
  dissolvedSeen?: boolean;
  lastPhase?: string;
  /** Chain time the current phase was first observed. */
  phaseSince?: number;
  done?: boolean;
  /** Consecutive failures of the lifecycle keeper (listing retries back off). */
  keeperFailures?: number;
  nextKeeperAt?: number;
}

export interface MockState {
  version: 1;
  chainId: number;
  factory: string;
  /** Hash of block 0: tells a restarted local chain (same addresses, new history) from the old one. */
  genesis?: string;
  startedAt: string;
  rngSeed: number;
  tick: number;
  catalogCursor: number;
  tempo: {
    bootstrapStartedAt?: number;
    bootstrapLaunched: number;
    bootstrapDone: boolean;
    nextLaunchAt?: number;
    seeded?: boolean;
    /** Chain time of the last extra launch made to fill an empty stage. */
    lastGapFillAt?: number;
    /** Last chain hour an occupancy line was logged for. */
    occupancyHour?: number;
  };
  funding: { windowStart: number; nativeSpent: string; usdgMinted: string };
  approvals: Record<string, true>;
  projects: Record<string, ProjectState>;
  /** Next factory index to scan for raises created by others. */
  factoryCursor?: number;
  /** AI usage per UTC hour (counts only) and recent call times for the hourly budget. */
  ai?: { usage: Record<string, unknown>; recentCalls: number[] };
}

export function newState(chainId: number, factory: string, genesis?: string): MockState {
  return {
    version: 1,
    chainId,
    factory,
    genesis,
    startedAt: new Date().toISOString(),
    rngSeed: Math.floor(Math.random() * 2 ** 31),
    tick: 0,
    catalogCursor: 0,
    tempo: { bootstrapLaunched: 0, bootstrapDone: false },
    funding: { windowStart: 0, nativeSpent: '0', usdgMinted: '0' },
    approvals: {},
    projects: {},
  };
}

/**
 * Load the state for this deployment. A state file written against another factory or another chain history (a
 * redeploy, or a restarted local chain) is archived and a fresh state starts; wallets are kept.
 */
export function loadState(
  chainId: number,
  factory: string,
  genesis?: string,
): { state: MockState; path: string; archived?: string } {
  const path = resolve(stateDir(chainId), 'state.json');
  const current = readJson<MockState>(path);
  if (current && current.factory.toLowerCase() === factory.toLowerCase() && (!genesis || current.genesis === genesis))
    return { state: current, path };
  let archived: string | undefined;
  if (current) {
    archived = resolve(stateDir(chainId), `state.${current.factory.slice(2, 10)}.${Date.now()}.json`);
    renameSync(path, archived);
  }
  return { state: newState(chainId, factory, genesis), path, archived };
}

export function saveState(path: string, state: MockState): void {
  writeJsonAtomic(path, state);
}
