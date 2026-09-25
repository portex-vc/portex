/**
 * Admin roles and the registry's parameter rules, as pure functions (unit-tested).
 * Every role comes from chain or API reads of the connected address; nothing here is a local flag.
 */

export type AdminRole = "curator" | "attester" | "council" | "apiAdmin";
export const ADMIN_ROLES: readonly AdminRole[] = ["curator", "attester", "council", "apiAdmin"];

const DAY = 86_400n;
/** Registry constants (PortexRegistryV31): stage lengths ≤ 365 d, treasury schedule ≤ 3650 d. */
export const MAX_STAGE_LENGTH = 365n * DAY;
export const MAX_TREASURY_VESTING = 3650n * DAY;
export const MAX_VETO = 2n * DAY;
export const MAX_VETO_TOTAL = 7n * DAY;
export const SCALE = 10n ** 18n;

export function sameAddress(a?: string | null, b?: string | null): boolean {
  return Boolean(a && b && a.toLowerCase() === b.toLowerCase());
}

interface VersionLike {
  name: string;
  version: string;
  deprecated?: boolean;
  implementations: { attester: string; council: string };
}

/** The newest published version of each template (the one new raises pin their attester and council from). */
export function latestVersions<T extends VersionLike>(templates: readonly T[]): T[] {
  const byName = new Map<string, T>();
  for (const t of templates) {
    const current = byName.get(t.name);
    if (!current || BigInt(t.version) > BigInt(current.version)) byName.set(t.name, t);
  }
  return [...byName.values()];
}

/**
 * Roles held by `address`:
 * - curator: `PortexRegistryV31.curator()`;
 * - attester / council: the latest version's pinned implementations, or any raise's `modules()`;
 * - apiAdmin: `/v2/config` `admins` (the API's ADMIN_ADDRESSES).
 */
export function detectRoles(input: {
  address?: string | null;
  curator?: string | null;
  templates?: readonly VersionLike[];
  admins?: readonly string[] | null;
  raiseModules?: readonly { attester: string; council: string }[];
}): AdminRole[] {
  const { address } = input;
  if (!address) return [];
  const latest = latestVersions(input.templates ?? []);
  const modules = input.raiseModules ?? [];
  const roles: AdminRole[] = [];
  if (sameAddress(address, input.curator)) roles.push("curator");
  if ([...latest.map((t) => t.implementations), ...modules].some((m) => sameAddress(address, m.attester)))
    roles.push("attester");
  if ([...latest.map((t) => t.implementations), ...modules].some((m) => sameAddress(address, m.council)))
    roles.push("council");
  if ((input.admins ?? []).some((a) => sameAddress(address, a))) roles.push("apiAdmin");
  return roles;
}

/* ---------- Protocol parameters (V.Parameters) ---------- */

export interface ProtocolParameters {
  kappaMax: bigint;
  budgetCeilingMax: bigint;
  vetoMax: bigint;
  vetoTotal: bigint;
  vetoCooldown: bigint;
  voting: bigint;
  dispute: bigint;
  execution: bigint;
  proposalInterval: bigint;
  minimumBackers: number;
  tradeFeeBps: number;
  surchargeBps: number;
  stage1Min: bigint;
  stage1Max: bigint;
  stage2Min: bigint;
  stage2Max: bigint;
  treasuryVesting: bigint;
}
export type ParameterKey = keyof ProtocolParameters;

export const DURATION_KEYS = [
  "stage1Min",
  "stage1Max",
  "stage2Min",
  "stage2Max",
  "vetoMax",
  "vetoTotal",
  "vetoCooldown",
  "voting",
  "dispute",
  "execution",
  "proposalInterval",
  "treasuryVesting",
] as const satisfies readonly ParameterKey[];
export const FIXED_KEYS = ["minimumBackers", "tradeFeeBps", "surchargeBps"] as const satisfies readonly ParameterKey[];
export const FIXED_VALUES = { minimumBackers: 10, tradeFeeBps: 100, surchargeBps: 0 } as const;

/** Editor layout: groups in display order. */
export const PARAMETER_GROUPS: { key: string; fields: ParameterKey[] }[] = [
  { key: "stages", fields: ["stage1Min", "stage1Max", "stage2Min", "stage2Max"] },
  { key: "veto", fields: ["vetoMax", "vetoTotal", "vetoCooldown"] },
  { key: "governance", fields: ["voting", "dispute", "execution", "proposalInterval"] },
  { key: "treasury", fields: ["treasuryVesting"] },
  { key: "market", fields: ["kappaMax", "budgetCeilingMax"] },
  { key: "fixed", fields: ["minimumBackers", "tradeFeeBps", "surchargeBps"] },
];

const PARAMETER_ORDER: ParameterKey[] = [
  "kappaMax",
  "budgetCeilingMax",
  "vetoMax",
  "vetoTotal",
  "vetoCooldown",
  "voting",
  "dispute",
  "execution",
  "proposalInterval",
  "minimumBackers",
  "tradeFeeBps",
  "surchargeBps",
  "stage1Min",
  "stage1Max",
  "stage2Min",
  "stage2Max",
  "treasuryVesting",
];

/**
 * Normalize a struct as returned by viem (uint64 → bigint, uint16 → number) or by the API (decimal strings).
 * Returns null when a field is missing (an older ABI or API without the governed timings).
 */
export function toParameters(raw: unknown): ProtocolParameters | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const out: Partial<Record<ParameterKey, bigint | number>> = {};
  for (const key of PARAMETER_ORDER) {
    const v = r[key];
    if (v === undefined || v === null || v === "") return null;
    try {
      out[key] = (FIXED_KEYS as readonly string[]).includes(key) ? Number(v) : BigInt(v as string | number | bigint);
    } catch {
      return null;
    }
  }
  return out as ProtocolParameters;
}

export interface ParameterError {
  field: ParameterKey;
  key: string;
}

/** Mirrors `PortexRegistryV31._validateParameters` exactly, one message per offending field. */
export function validateParameters(p: ProtocolParameters): ParameterError[] {
  const errors: ParameterError[] = [];
  const add = (field: ParameterKey, key: string) => {
    if (!errors.some((e) => e.field === field)) errors.push({ field, key });
  };
  // Fixed terms
  if (p.kappaMax < (SCALE * 3n) / 2n) add("kappaMax", "kappaMin");
  if (p.budgetCeilingMax > SCALE) add("budgetCeilingMax", "budgetMax");
  if (p.minimumBackers !== FIXED_VALUES.minimumBackers) add("minimumBackers", "fixed");
  if (p.tradeFeeBps !== FIXED_VALUES.tradeFeeBps) add("tradeFeeBps", "fixed");
  if (p.surchargeBps !== FIXED_VALUES.surchargeBps) add("surchargeBps", "fixed");
  // Stage lengths
  if (p.stage1Min === 0n) add("stage1Min", "positive");
  else if (p.stage1Min > p.stage1Max) add("stage1Min", "minAboveMax");
  if (p.stage1Max > MAX_STAGE_LENGTH) add("stage1Max", "stageCap");
  if (p.stage2Min === 0n) add("stage2Min", "positive");
  else if (p.stage2Min > p.stage2Max) add("stage2Min", "minAboveMax");
  if (p.stage2Max > MAX_STAGE_LENGTH) add("stage2Max", "stageCap");
  // Veto timers
  if (p.vetoMax === 0n) add("vetoMax", "positive");
  else if (p.vetoMax > MAX_VETO) add("vetoMax", "vetoMaxCap");
  if (p.vetoTotal < p.vetoMax) add("vetoTotal", "vetoTotalBelowMax");
  else if (p.vetoTotal > MAX_VETO_TOTAL) add("vetoTotal", "vetoTotalCap");
  else if (p.vetoTotal > p.stage1Max) add("vetoTotal", "vetoTotalStage1");
  if (p.vetoCooldown === 0n) add("vetoCooldown", "positive");
  // Governance timers
  for (const key of ["voting", "dispute", "execution", "proposalInterval"] as const)
    if (p[key] === 0n) add(key, "positive");
  if (p.voting + p.dispute + p.execution > p.stage2Min) add("voting", "governanceFit");
  // Treasury
  if (p.treasuryVesting === 0n) add("treasuryVesting", "positive");
  else if (p.treasuryVesting > MAX_TREASURY_VESTING) add("treasuryVesting", "vestingCap");
  return errors;
}

/** Fields whose value differs, in display order. */
export function diffParameters(current: ProtocolParameters, next: ProtocolParameters): ParameterKey[] {
  return PARAMETER_GROUPS.flatMap((g) => g.fields).filter((k) => String(current[k]) !== String(next[k]));
}

/** The struct in ABI field order for `setProtocolParameters`. */
export function parametersArg(p: ProtocolParameters) {
  return Object.fromEntries(PARAMETER_ORDER.map((k) => [k, p[k]])) as unknown as ProtocolParameters;
}

/* ---------- Human units ---------- */

export type DurationUnit = "minute" | "hour" | "day";
export const UNIT_SECONDS: Record<DurationUnit, bigint> = { minute: 60n, hour: 3600n, day: DAY };

/** The largest unit that expresses `seconds` exactly (minutes as the floor). */
export function bestUnit(seconds: bigint): DurationUnit {
  if (seconds > 0n && seconds % DAY === 0n) return "day";
  if (seconds > 0n && seconds % 3600n === 0n) return "hour";
  return "minute";
}

/** "1.5" hours → 5400n. Null when not a non-negative number or not a whole number of seconds. */
export function parseDuration(value: string, unit: DurationUnit): bigint | null {
  const v = value.trim();
  if (!/^\d+(\.\d+)?$/.test(v)) return null;
  const [whole, fraction = ""] = v.split(".");
  if (fraction.length > 9) return null;
  const scaled = BigInt(whole + fraction.padEnd(9, "0")) * UNIT_SECONDS[unit];
  return scaled % 1_000_000_000n === 0n ? scaled / 1_000_000_000n : null;
}

/** 5400n in hours → "1.5"; null when the value has no exact decimal form in that unit (10 min in days). */
export function formatDurationValue(seconds: bigint, unit: DurationUnit): string | null {
  const size = UNIT_SECONDS[unit];
  const whole = seconds / size;
  const rest = seconds % size;
  if (rest === 0n) return whole.toString();
  const scaled = rest * 1_000_000_000n;
  if (scaled % size !== 0n) return null;
  const fraction = (scaled / size).toString().padStart(9, "0").replace(/0+$/, "");
  return `${whole}.${fraction}`;
}

/** Decimal string → 18-decimal fixed point ("2" → 2e18); `shift` 16 for percentages ("30" → 0.3e18). */
export function parseFixed(value: string, shift = 18): bigint | null {
  const v = value.trim();
  if (!/^\d+(\.\d+)?$/.test(v)) return null;
  const [whole, fraction = ""] = v.split(".");
  if (fraction.length > shift) return null;
  return BigInt(whole + fraction.padEnd(shift, "0"));
}

export function formatFixed(value: bigint, shift = 18): string {
  const base = 10n ** BigInt(shift);
  const whole = value / base;
  const rest = value % base;
  if (rest === 0n) return whole.toString();
  return `${whole}.${rest.toString().padStart(shift, "0").replace(/0+$/, "")}`;
}

/* ---------- Vetoes (RaiseCore.veto / clearVeto) ---------- */

export interface VetoEvent {
  vetoUntil: number;
  cumulativeDelay: bigint;
  timestamp: number;
}

export interface VetoState {
  /** Cumulative delay consumed (s.vetoUsed). */
  used: bigint;
  remaining: bigint;
  total: bigint;
  /** s.cooldownUntil, reconstructed from the latest VetoChanged event (0 when none). */
  cooldownUntil: number;
  /** Absolute horizon start + stage1Max, or null when the pinned Stage 1 maximum is unknown. */
  hardEnd: number | null;
  active: boolean;
}

/** Rebuild the veto budget and cooldown from `VetoChanged` events (newest first or any order). */
export function vetoState(input: {
  events: readonly VetoEvent[];
  vetoTotal: bigint;
  vetoCooldown: bigint;
  stage1Max?: bigint | null;
  start: number;
  vetoUntil: number;
  now: number;
}): VetoState {
  const latest = [...input.events].sort((a, b) => b.timestamp - a.timestamp)[0];
  const used = latest ? latest.cumulativeDelay : 0n;
  const cooldown = Number(input.vetoCooldown);
  const cooldownUntil = latest ? (latest.vetoUntil > 0 ? latest.vetoUntil : latest.timestamp) + cooldown : 0;
  return {
    used,
    remaining: input.vetoTotal > used ? input.vetoTotal - used : 0n,
    total: input.vetoTotal,
    cooldownUntil,
    hardEnd: input.stage1Max != null ? input.start + Number(input.stage1Max) : null,
    active: input.vetoUntil > input.now,
  };
}

export type VetoBlock =
  | { key: "notStage1" }
  | { key: "cooldown"; until: number }
  | { key: "zero" }
  | { key: "aboveMax"; max: bigint }
  | { key: "horizon" }
  | { key: "budget"; remaining: bigint };

/** Mirrors `RaiseCore.veto`: Stage 1, after the cooldown, 0 < delay ≤ vetoMax, before the horizon, within budget. */
export function vetoBlock(input: {
  phase: string;
  state: VetoState;
  vetoMax: bigint;
  delay: bigint | null;
  now: number;
}): VetoBlock | null {
  const { state, now } = input;
  if (input.phase !== "Stage1") return { key: "notStage1" };
  if (now < state.cooldownUntil) return { key: "cooldown", until: state.cooldownUntil };
  if (!input.delay || input.delay <= 0n) return { key: "zero" };
  if (input.delay > input.vetoMax) return { key: "aboveMax", max: input.vetoMax };
  if (state.hardEnd !== null && now >= state.hardEnd) return { key: "horizon" };
  const until = state.hardEnd !== null ? Math.min(now + Number(input.delay), state.hardEnd) : now + Number(input.delay);
  if (state.used + BigInt(until - now) > state.total) return { key: "budget", remaining: state.remaining };
  return null;
}

/** The longest delay the attester could request right now (0 when none). */
export function maxVetoNow(input: { phase: string; state: VetoState; vetoMax: bigint; now: number }): bigint {
  const { state, now } = input;
  if (input.phase !== "Stage1" || now < state.cooldownUntil) return 0n;
  if (state.hardEnd !== null) {
    const left = BigInt(state.hardEnd - now);
    if (left <= 0n) return 0n;
    // The applied delay stops at the horizon, so when the horizon is nearer than the budget any delay fits.
    if (left <= state.remaining) return input.vetoMax;
  }
  return input.vetoMax < state.remaining ? input.vetoMax : state.remaining;
}
