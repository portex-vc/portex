/**
 * Shortened testnet timings: detection and the numbers the explanation compares.
 * Detection reads the pinned version parameters; nothing is keyed on the chain id, so a production
 * deployment (Stage 1 minimum ≥ 1 day) never shows a testnet marker.
 */

export const DAY = 86_400;

/** `TypesV31.productionParameters()`: the governed defaults every production deployment starts from. */
export const PRODUCTION_TIMINGS = {
  stage1Min: 15 * DAY,
  stage1Max: 60 * DAY,
  stage2Min: 35 * DAY,
  stage2Max: 70 * DAY,
  vetoMax: 2 * DAY,
  vetoTotal: 7 * DAY,
  voting: 3 * DAY,
  dispute: 7 * DAY,
  execution: 2 * DAY,
  treasuryVesting: 1825 * DAY,
} as const;

export type Timings = Record<keyof typeof PRODUCTION_TIMINGS, number>;

type RawTimings = Partial<Record<keyof typeof PRODUCTION_TIMINGS, string | number | bigint | null | undefined>>;

/** A version or raise runs shortened timings when its pinned Stage 1 minimum is under one day. */
export function isShortened(params?: RawTimings | null): boolean {
  const min = params?.stage1Min;
  if (min === undefined || min === null || min === "") return false;
  const seconds = Number(min);
  return Number.isFinite(seconds) && seconds > 0 && seconds < DAY;
}

/** The timings of a pinned parameter set, or null when the governed timings are absent (older API). */
export function toTimings(params?: RawTimings | null): Timings | null {
  if (!params) return null;
  const out = {} as Timings;
  for (const key of Object.keys(PRODUCTION_TIMINGS) as (keyof Timings)[]) {
    const value = params[key];
    if (value === undefined || value === null || value === "") return null;
    out[key] = Number(value);
  }
  return out;
}

interface TemplateLike {
  name: string;
  version: string | number;
  deprecated?: boolean;
  parameters: RawTimings;
}

/** The newest non-deprecated version of each template: what a new launch pins. */
export function currentTemplates<T extends TemplateLike>(templates: readonly T[] = []): T[] {
  const byName = new Map<string, T>();
  for (const t of templates) {
    if (t.deprecated) continue;
    const seen = byName.get(t.name);
    if (!seen || BigInt(t.version) > BigInt(seen.version)) byName.set(t.name, t);
  }
  return [...byName.values()];
}

/** Deployment-level detection from `/v2/config`: shortened when a current template pins shortened timings. */
export function testnetTimingsOf(templates?: readonly TemplateLike[]): { shortened: boolean; timings: Timings | null } {
  const current = currentTemplates(templates ?? []);
  const short = current.find((t) => isShortened(t.parameters));
  return { shortened: Boolean(short), timings: short ? toTimings(short.parameters) : null };
}
