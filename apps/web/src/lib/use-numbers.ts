"use client";

import { useFormatter, useLocale } from "next-intl";
import { formatUnits } from "viem";

/** Locale-aware display only; transaction arithmetic always uses bigint atoms. */
export function useNumbers() {
  const locale = useLocale();
  const format = useFormatter();
  const number = (value: number, decimals = 2) => format.number(value, { maximumFractionDigits: decimals });
  const amount = (value: bigint | string | undefined | null, decimals: number, precision: number) => {
    if (value == null) return "—";
    const raw = formatUnits(BigInt(value), decimals);
    const [whole, fraction = ""] = raw.split(".");
    const integer = new Intl.NumberFormat(locale, {
      maximumFractionDigits: 0,
    }).format(BigInt(whole));
    const separator = new Intl.NumberFormat(locale).formatToParts(1.1).find((p) => p.type === "decimal")?.value ?? ".";
    const cut = fraction.slice(0, precision).padEnd(precision, "0");
    return cut ? `${integer}${separator}${cut}` : integer;
  };
  const durationOf = (seconds: number) => {
    const safe = Math.max(0, Math.floor(seconds));
    const unit = safe >= 86400 ? "day" : safe >= 3600 ? "hour" : safe >= 60 ? "minute" : "second";
    const size = unit === "day" ? 86400 : unit === "hour" ? 3600 : unit === "minute" ? 60 : 1;
    return format.number(safe / size, {
      style: "unit",
      unit,
      unitDisplay: "short",
      maximumFractionDigits: 1,
    });
  };
  return {
    number,
    quote: (v: bigint | string | undefined | null) => amount(v, 6, 2),
    token: (v: bigint | string | undefined | null) => amount(v, 18, 4),
    price: (v: bigint | string | undefined | null) =>
      v == null ? "—" : format.number(Number(formatUnits(BigInt(v), 18)), { maximumSignificantDigits: 6 }),
    pct: (bps: number) => format.number(bps / 10000, { style: "percent", maximumFractionDigits: 2 }),
    date: (seconds: number) =>
      format.dateTime(new Date(seconds * 1000), {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        timeZone: "UTC",
        timeZoneName: "short",
      }),
    /** Calendar day only ("Jun 14"), for ranges where the time of day is noise. */
    day: (seconds: number) =>
      format.dateTime(new Date(seconds * 1000), { month: "short", day: "numeric", timeZone: "UTC" }),
    signedPct: (bps: number) =>
      format.number(bps / 10000, { style: "percent", maximumFractionDigits: 2, signDisplay: "always" }),
    /** "15–60 days" when both ends are whole days, else "10 min–60 days". */
    durationRange: (from: number, to: number) =>
      from % 86400 === 0 && to % 86400 === 0 && from > 0
        ? `${format.number(from / 86400, { maximumFractionDigits: 0 })}–${durationOf(to)}`
        : `${durationOf(from)}–${durationOf(to)}`,
    /** A schedule length: "5 years" when it is whole years, else a duration ("7 days"). */
    period: (seconds: number) => {
      const years = seconds / 31_536_000;
      if (years >= 1 && Number.isInteger(years))
        return format.number(years, { style: "unit", unit: "year", unitDisplay: "long" });
      const safe = Math.max(0, Math.floor(seconds));
      const unit = safe >= 86400 ? "day" : safe >= 3600 ? "hour" : safe >= 60 ? "minute" : "second";
      const size = unit === "day" ? 86400 : unit === "hour" ? 3600 : unit === "minute" ? 60 : 1;
      return format.number(safe / size, { style: "unit", unit, unitDisplay: "long", maximumFractionDigits: 1 });
    },
    duration: durationOf,
  };
}
