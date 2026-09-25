import { isAddress, parseUnits, zeroAddress, type Address } from "viem";
import type { ApiConfig } from "./api";
import { curveCost } from "./quotes";
export interface FormState {
  templateName: "ESCROW_LAUNCH" | "BUDGET_LAUNCH";
  name: string;
  symbol: string;
  description: string;
  website: string;
  /** Uploaded project image (the upload's `uri`) and its display URL; empty when none. */
  image: string;
  imageUrl: string;
  supply: string;
  targetMode: "price" | "valuation";
  targetPrice: string;
  targetValuation: string;
  stage1Days: string;
  stage2Weeks: string;
  builders: string;
  budgetCeiling: string;
}
export const DEFAULT_FORM: FormState = {
  templateName: "ESCROW_LAUNCH",
  name: "",
  symbol: "",
  description: "",
  website: "",
  image: "",
  imageUrl: "",
  supply: "1000000",
  targetMode: "valuation",
  targetPrice: "0.1",
  targetValuation: "100000",
  stage1Days: "30",
  stage2Weeks: "7",
  builders: "",
  budgetCeiling: "30",
};
export const STEPS = ["type", "basics", "capital", "schedule", "rules", "review"] as const;
export type Field = keyof FormState;
export function decimal(value: string, decimals = 18): bigint {
  if (!/^\d+(\.\d+)?$/.test(value) || (value.split(".")[1]?.length ?? 0) > decimals) return -1n;
  try {
    return parseUnits(value, decimals);
  } catch {
    return -1n;
  }
}
export function priceOf(f: FormState): bigint {
  if (f.targetMode === "price") return decimal(f.targetPrice);
  const supply = decimal(f.supply),
    valuation = decimal(f.targetValuation);
  return supply > 0n && valuation > 0n ? (valuation * 10n ** 18n + supply - 1n) / supply : -1n;
}
export const builderAddresses = (f: FormState) => f.builders.split(/[\s,]+/).filter(Boolean);
export interface CreationError {
  field: Field;
  key: string;
  step: number;
}
export interface StageBounds {
  stage1Min: number;
  stage1Max: number;
  stage2Min: number;
  stage2Max: number;
}
/**
 * Stage-length bounds for a new launch, in seconds. Governed timings are pinned into each template
 * version, so the version's parameters win; older APIs expose deployment-wide `stageBounds` instead.
 * Returns null when neither is known (the factory still enforces the bounds on-chain).
 */
export function stageBoundsFor(config?: ApiConfig, templateName?: FormState["templateName"]): StageBounds | null {
  const version = config?.templates.find((t) => (!templateName || t.name === templateName) && !t.deprecated);
  const p = version?.parameters;
  const pinned =
    p && [p.stage1Min, p.stage1Max, p.stage2Min, p.stage2Max].every((x) => x !== undefined && Number(x) > 0);
  const source = pinned ? p : config?.stageBounds;
  if (!source) return null;
  return {
    stage1Min: Number(source.stage1Min),
    stage1Max: Number(source.stage1Max),
    stage2Min: Number(source.stage2Min),
    stage2Max: Number(source.stage2Max),
  };
}
export function scheduleUnits(config?: ApiConfig, templateName?: FormState["templateName"]) {
  const bounds = stageBoundsFor(config, templateName);
  return {
    stage1: bounds && bounds.stage1Min < 86400 ? 3600 : 86400,
    stage2: bounds && bounds.stage2Min < 604800 ? 3600 : 604800,
  };
}
export function stageSeconds(value: string, unit: number): number {
  if (!/^\d+(\.\d+)?$/.test(value)) return NaN;
  const scaled = decimal(value, 18) * BigInt(unit);
  if (scaled < 0n || scaled % 10n ** 18n !== 0n) return NaN;
  return Number(scaled / 10n ** 18n);
}
export function validateCreation(f: FormState, config?: ApiConfig): CreationError[] {
  const errors: CreationError[] = [];
  const add = (field: Field, key: string, step: number) => errors.push({ field, key, step });
  if (!f.name.trim()) add("name", "required", 1);
  if (!f.symbol.trim()) add("symbol", "required", 1);
  if (f.description.length > 2000) add("description", "descriptionError", 1);
  if (f.website && !/^https?:\/\/\S+$/.test(f.website)) add("website", "websiteError", 1);
  const supply = decimal(f.supply),
    price = priceOf(f);
  if (supply < 50n || supply > 10n ** 30n || supply % 10n !== 0n) add("supply", "supplyError", 2);
  const priceField = f.targetMode === "price" ? "targetPrice" : "targetValuation";
  if (price <= 0n || price > 10n ** 36n || (supply > 0n && (price * supply) / 10n ** 18n < 100000n * 10n ** 18n))
    add(priceField, "valuationError", 2);
  if (
    supply >= 50n &&
    supply <= 10n ** 30n &&
    price > 0n &&
    curveCost(price, supply / 5n, 0n, supply / 5n) > 10n ** 30n / 2n
  )
    add(priceField, "quoteBoundError", 2);
  const units = scheduleUnits(config, f.templateName);
  const bounds = stageBoundsFor(config, f.templateName) ?? {
    stage1Min: 15 * 86400,
    stage1Max: 60 * 86400,
    stage2Min: 35 * 86400,
    stage2Max: 70 * 86400,
  };
  const stage1 = stageSeconds(f.stage1Days, units.stage1);
  const stage2 = stageSeconds(f.stage2Weeks, units.stage2);
  if (!Number.isSafeInteger(stage1) || stage1 < Number(bounds.stage1Min) || stage1 > Number(bounds.stage1Max))
    add("stage1Days", "stage1Error", 3);
  if (!Number.isSafeInteger(stage2) || stage2 < Number(bounds.stage2Min) || stage2 > Number(bounds.stage2Max))
    add("stage2Weeks", "stage2Error", 3);
  const tv = config?.templates.find((t) => t.name === f.templateName && !t.deprecated);
  const ceiling = decimal(f.budgetCeiling, 16);
  if (
    f.templateName === "BUDGET_LAUNCH" &&
    (ceiling < 0n || ceiling > BigInt(tv?.parameters.budgetCeilingMax ?? "300000000000000000"))
  )
    add("budgetCeiling", "budgetError", 4);
  if (tv && BigInt(tv.parameters.kappaMax) < 1500000000000000000n) add("templateName", "templateError", 0);
  const addresses = config?.addresses;
  const builders = builderAddresses(f);
  if (
    builders.length > 32 ||
    builders.some(
      (x) =>
        !isAddress(x) ||
        [zeroAddress, addresses?.quote, addresses?.factory].some((a) => a?.toLowerCase() === x.toLowerCase()),
    )
  )
    add("builders", "buildersError", 4);
  return errors;
}
export function creationConfig(f: FormState, quote: Address, config?: ApiConfig) {
  return {
    quote,
    // The factory always creates the launch's own governed treasury; this field is ignored on-chain.
    treasury: zeroAddress as Address,
    supply: decimal(f.supply),
    targetPrice: priceOf(f),
    budgetCeiling: f.templateName === "BUDGET_LAUNCH" ? decimal(f.budgetCeiling, 16) : 0n,
    stage1Length: BigInt(stageSeconds(f.stage1Days, scheduleUnits(config, f.templateName).stage1)),
    stage2Length: BigInt(stageSeconds(f.stage2Weeks, scheduleUnits(config, f.templateName).stage2)),
    builders: builderAddresses(f) as Address[],
  };
}
