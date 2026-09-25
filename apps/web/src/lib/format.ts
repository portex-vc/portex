import { formatUnits, parseUnits } from "viem";

export const QUOTE_DECIMALS = 6;
export const TOKEN_DECIMALS = 18;

function trimTrailingZeros(s: string): string {
  if (!s.includes(".")) return s;
  return s.replace(/\.?0+$/, "") || "0";
}

/** Format a smallest-unit integer to a human number with at most `maxDecimals` decimals. */
export function formatAmount(value: string | bigint | undefined | null, decimals: number, maxDecimals = 4): string {
  if (value === undefined || value === null) return "—";
  const raw = formatUnits(BigInt(value), decimals);
  const negative = raw.startsWith("-");
  const [int, frac = ""] = (negative ? raw.slice(1) : raw).split(".");
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const cut = frac.slice(0, maxDecimals);
  const body = trimTrailingZeros(cut ? `${grouped}.${cut}` : grouped);
  return negative ? `-${body}` : body;
}

/** Quote asset (e.g. MockUSDG), 6 decimals. */
export function formatQuote(value: string | bigint | undefined | null, maxDecimals = 2): string {
  return formatAmount(value, QUOTE_DECIMALS, maxDecimals);
}

/** Project token, 18 decimals. */
export function formatToken(value: string | bigint | undefined | null, maxDecimals = 4): string {
  return formatAmount(value, TOKEN_DECIMALS, maxDecimals);
}

/**
 * On-chain `bookPrice()`: quote smallest units per whole token
 * (per INTERFACES.md: 1_000_000 = 1.0 USDG/token for a 6-decimal quote).
 */
export function formatOnchainPrice(
  value: string | bigint | undefined | null,
  quoteDecimals = QUOTE_DECIMALS,
  maxDecimals = 6,
): string {
  return formatAmount(value, quoteDecimals, maxDecimals);
}

/** API prices: human quote-per-token scaled by 1e18 ("1000000000000000000" = 1.0). */
export function formatApiPrice(value: string | bigint | undefined | null, maxDecimals = 6): string {
  return formatAmount(value, 18, maxDecimals);
}

export function formatBps(bps: number | string | undefined | null, maxDecimals = 2): string {
  if (bps === undefined || bps === null) return "—";
  const pct = Number(bps) / 100;
  return `${trimTrailingZeros(pct.toFixed(maxDecimals))}%`;
}

/** earlyFactor and other 1e18-scaled multipliers → "1.42×". */
export function formatFactor(factor1e18: string | bigint | undefined | null, maxDecimals = 2): string {
  if (factor1e18 === undefined || factor1e18 === null) return "—";
  const num = Number(formatUnits(BigInt(factor1e18), 18));
  if (!Number.isFinite(num)) return "—";
  return `${trimTrailingZeros(num.toFixed(maxDecimals))}×`;
}

function normalizeNumberInput(input: string): string {
  const s = input.trim().replace(/,/g, "");
  if (s === "" || s === ".") return "0";
  return s;
}

export function parseQuote(input: string): bigint {
  return parseUnits(normalizeNumberInput(input), QUOTE_DECIMALS);
}

export function parseToken(input: string): bigint {
  return parseUnits(normalizeNumberInput(input), TOKEN_DECIMALS);
}

export function isValidAmountInput(input: string): boolean {
  return /^\d*\.?\d*$/.test(input.trim().replace(/,/g, ""));
}

/** "2d 4h", "3h 12m", "45s" — compact countdown/duration formatting. */
export function formatDuration(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds)) return "—";
  if (totalSeconds <= 0) return "0s";
  const s = Math.floor(totalSeconds);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

/** Seconds until `unixTs`; negative when in the past. */
