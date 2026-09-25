/** Governed timings the docs can annotate. A plain module: server components read `isTiming` too. */

export const DAY = 86_400;

/** `TypesV31.productionParameters()`: the governed defaults every production deployment starts from. */
export const PRODUCTION = {
  stage1Min: 15 * DAY,
  stage1Max: 60 * DAY,
  stage2Min: 35 * DAY,
  stage2Max: 70 * DAY,
  voting: 3 * DAY,
  dispute: 7 * DAY,
  execution: 2 * DAY,
  proposalInterval: 1 * DAY,
  vetoMax: 2 * DAY,
  vetoTotal: 7 * DAY,
  vetoCooldown: 1 * DAY,
  treasuryVesting: 1825 * DAY,
} as const;
export type Param = keyof typeof PRODUCTION;

/** What the docs can annotate: single parameters, plus the two stage-length ranges. */
export const TIMINGS = [
  "stage1",
  "stage2",
  "voting",
  "dispute",
  "execution",
  "proposalInterval",
  "vetoMax",
  "vetoTotal",
  "vetoCooldown",
  "treasuryVesting",
] as const;
export type Timing = (typeof TIMINGS)[number];
export const RANGE: Partial<Record<Timing, [Param, Param]>> = {
  stage1: ["stage1Min", "stage1Max"],
  stage2: ["stage2Min", "stage2Max"],
};
export const isTiming = (key: string): key is Timing => (TIMINGS as readonly string[]).includes(key);
