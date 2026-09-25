/** Tempo config (config/tempos.json) plus `--set a.b=value` overrides. */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Fate } from './state';

export type Range = [number, number];
export interface FundingProfile {
  nativeMin: string;
  nativeTopUp: string;
  builderNativeTopUp: string;
  nativeMaxPerDay: string;
  funderReserve: string;
}

export interface MockConfig {
  tickSeconds: number;
  warpSeconds: number;
  concurrency: number;
  maxActiveProjects: number;
  gas: { maxGasPriceGwei: number; localMaxGasPriceGwei: number; priceMultiplier: number };
  funding: { testnet: FundingProfile; local: FundingProfile; usdgTarget: Record<string, number> };
  bootstrap: { launches: number; spacingMinutes: number; fates: Fate[]; tradeMultiplier: number };
  steady: {
    stage1Minutes: Range;
    stage2Minutes: Range;
    launchEveryMinutes: Range;
    launchBatch: Range;
    dissolveShare: number;
    tradeMultiplier: number;
  };
  /** Keep every stage populated: minimum projects in Stage 1 and Stage 2, and how gaps get filled. */
  occupancy: {
    stage1Min: number;
    stage2Min: number;
    /** Stage 3 keeps at least this many listed projects; an empty Stage 3 gets a fast-track graduate. */
    stage3Min: number;
    maxGapFillsPerHour: number;
    /** A Stage 2 gap is filled by a launch with a short Stage 1 (floored at the registry minimum) and a long Stage 2. */
    gapStage1Minutes: Range;
    gapStage2Minutes: Range;
    /** Projects leaving (or about to enter) a stage within this window count as leaving (or already in). */
    lookaheadMinutes: number;
    /** No extra gap-filling launch when the regular launch is due within this many minutes anyway. */
    gapLeadMinutes: number;
  };
  /** Per-market daily trading volume target (each Stage 2 book and Stage 3 pool draws one). */
  volume: {
    dailyUsdg: Range;
    medianDailyUsdg: number;
    /** Starting multiplier on trade sizes; each market then self-calibrates toward its target hourly. */
    initialBoost: number;
  };
  stage1: { fillBy: Range; partialFill: Range; exitChancePerHour: number; maxExits: number };
  stage2: {
    quietTradesPerHour: number;
    burstTradesPerHour: number;
    burstChancePerHour: number;
    burstMinutes: Range;
    sizeSigma: number;
    whaleMultiplier: number;
    exitChancePerHour: number;
    maxExits: number;
  };
  stage3: {
    quietSwapsPerHour: number;
    burstSwapsPerHour: number;
    sizeSigma: number;
    whaleMultiplier: number;
    rewardClaimChancePerHour: number;
  };
  governance: {
    budgetDrawShareOfCapital: number;
    maxDraws: number;
    treasuryDelayMinutes: number;
    maxTreasuryProposals: number;
    treasurySpendShareOfCap: number;
    yesChance: number;
    votesPerTick: number;
    maxTokenVoters: number;
  };
  rollover: { chancePerHour: number; claimChancePerTick: number };
  offchain: { feedbackPerProject: Range; feedbackChancePerHour: number };
  ai: {
    enabled: boolean;
    maxCallsPerHour: number;
    concurrency: number;
    timeoutMs: number;
    retries: number;
    maxTokens: number;
    temperature: number;
    /** How long a tick waits for an AI answer before moving on (the job keeps running). */
    waitMs: number;
    warpWaitMs: number;
    reviewersPerRaise: Range;
    backConviction: number;
    exitConviction: number;
    rereviewMinutes: number;
    /** Personas' total deposits in a user's raise stay below this share of its Stage 1 sell-out cost. */
    externalCapShare: number;
    /** Also call the permissionless lifecycle steps (advance, list, finalize, execute) on user raises. */
    externalKeeper: boolean;
    sentimentEveryMinutes: number;
    discoverEveryTicks: number;
  };
}

export const DEFAULT_CONFIG_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '../config/tempos.json');

function setPath(target: Record<string, any>, path: string, raw: string) {
  const keys = path.split('.');
  let node = target;
  for (const key of keys.slice(0, -1)) {
    if (!node[key] || typeof node[key] !== 'object') throw new Error(`--set: unknown config path ${path}`);
    node = node[key];
  }
  const last = keys[keys.length - 1];
  if (!(last in node)) throw new Error(`--set: unknown config path ${path}`);
  let value: unknown = raw;
  try {
    value = JSON.parse(raw);
  } catch {
    /* plain string */
  }
  if (typeof value !== typeof node[last] || Array.isArray(value) !== Array.isArray(node[last]))
    throw new Error(`--set: ${path} expects ${Array.isArray(node[last]) ? 'an array' : typeof node[last]}`);
  node[last] = value;
}

export function loadConfig(path = DEFAULT_CONFIG_PATH, overrides: string[] = []): MockConfig {
  const config = JSON.parse(readFileSync(path, 'utf8')) as MockConfig & { $comment?: string };
  delete config.$comment;
  for (const entry of overrides) {
    const eq = entry.indexOf('=');
    if (eq <= 0) throw new Error(`--set expects path=value, got ${entry}`);
    setPath(config as never, entry.slice(0, eq), entry.slice(eq + 1));
  }
  return config;
}
