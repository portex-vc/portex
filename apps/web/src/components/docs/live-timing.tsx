"use client";

import { TestnetTimingNote, useTestnetTiming } from "@/components/testnet-timing";
import { useApiConfig } from "@/lib/hooks";
import { env } from "@/lib/env";
import { cn } from "@/lib/utils";
import { useLocale, useTranslations } from "next-intl";
import { DAY, PRODUCTION, RANGE, TIMINGS, type Param, type Timing } from "./timings";

const unitOf = (seconds: number) =>
  seconds % DAY === 0
    ? (["day", DAY] as const)
    : seconds % 3600 === 0
      ? (["hour", 3600] as const)
      : seconds % 60 === 0
        ? (["minute", 60] as const)
        : (["second", 1] as const);

/** A whole number of the largest fitting unit ("10 minutes", "1,825 days"), and ranges ("15–60 days"). */
export function useDuration() {
  const locale = useLocale();
  const format = (unit: string) => new Intl.NumberFormat(locale, { style: "unit", unit, unitDisplay: "long" });
  const one = (seconds: number) => {
    const [unit, size] = unitOf(seconds);
    return format(unit).format(seconds / size);
  };
  const range = (from: number, to: number) => {
    const [a, sa] = unitOf(from);
    const [b, sb] = unitOf(to);
    return a === b ? format(a).formatRange(from / sa, to / sb) : `${one(from)} – ${one(to)}`;
  };
  return { one, range };
}

/**
 * The governed timings a new launch on this network pins: the newest non-deprecated Escrow Launch version's
 * parameters from `/v2/config`, read live so they stay true when the curator publishes new values.
 */
export function useNetworkTimings() {
  const { data } = useApiConfig();
  const current = (data?.templates ?? [])
    .filter((t) => t.name === "ESCROW_LAUNCH" && !t.deprecated)
    .sort((a, b) => Number(BigInt(b.version) - BigInt(a.version)))[0];
  const raw = current?.parameters as unknown as Partial<Record<Param, string | number>> | undefined;
  const values = raw
    ? (Object.fromEntries(Object.keys(PRODUCTION).map((k) => [k, Number(raw[k as Param] ?? NaN)])) as Record<
        Param,
        number
      >)
    : null;
  return { values, testnet: env.chainId === 1952 };
}

/** Production and this network's value of one timing, formatted, and whether this network's is shorter. */
export function useTiming(key: Timing) {
  const { values, testnet } = useNetworkTimings();
  const d = useDuration();
  const range = RANGE[key];
  const show = (v: Record<Param, number>) => (range ? d.range(v[range[0]], v[range[1]]) : d.one(v[key as Param]));
  const production = show(PRODUCTION);
  if (!values) return { production, value: null, shorter: false, testnet };
  const params = range ?? [key as Param];
  if (params.some((p) => !Number.isFinite(values[p]))) return { production, value: null, shorter: false, testnet };
  const shorter = params.some((p) => values[p] < PRODUCTION[p]);
  return { production, value: show(values), shorter, testnet };
}

/**
 * This network's value right where the docs state a production timing, only when it is shorter:
 * inline as a parenthesis in a sentence, or as a second line under a figure.
 */
export function LiveTiming({
  k,
  block = false,
  why = true,
  className,
}: {
  k: Timing;
  block?: boolean;
  /** Inline only: say why the value differs (the first annotation of a sentence does; later ones stay short). */
  why?: boolean;
  className?: string;
}) {
  const t = useTranslations("docs.live");
  const locale = useLocale();
  const { value, shorter, testnet } = useTiming(k);
  if (!shorter || !value) return null;
  const where = t(testnet ? "testnet" : "here");
  if (block)
    return (
      <span className={cn("block text-xs leading-5 text-fg-2", className)} data-testid={`live-timing-${k}`}>
        {t("block", { where, value })}
      </span>
    );
  return (
    <span className={cn("text-fg-3", className)} data-testid={`live-timing-${k}`}>
      {/* Full-width Chinese parentheses carry their own spacing. */}
      {locale.startsWith("zh") ? "" : " "}
      {t(why ? "inline" : "inlineShort", { where, value })}
    </span>
  );
}

/** Under the stage figure: the shared testnet footnote (with its explanation popover) when timings are shortened. */
export function StepperNote({ note }: { note: string }) {
  const { shortened } = useTestnetTiming();
  if (shortened) return <TestnetTimingNote variant="footnote" />;
  return <span className="block">{note}</span>;
}

/** Production defaults beside this network's current values, with the reason they differ. */
export function TimingsTable() {
  const t = useTranslations("docs.live");
  const { values, testnet } = useNetworkTimings();
  const where = t(testnet ? "testnet" : "here");
  const rows = TIMINGS.map((key) => ({ key, label: t(`rows.${key}`) }));
  return (
    <div className="my-6" data-testid="docs-timings">
      <div className="hidden overflow-hidden rounded-[12px] border border-fg/[0.08] sm:block">
        <table className="w-full text-left text-sm">
          <thead className="bg-fg/[0.025] text-xs text-fg-3">
            <tr>
              <th scope="col" className="px-4 py-2.5 font-normal">
                {t("parameter")}
              </th>
              <th scope="col" className="px-4 py-2.5 font-normal">
                {t("production")}
              </th>
              <th scope="col" className="px-4 py-2.5 font-normal">
                {t("current", { where })}
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ key, label }) => (
              <TimingRow key={key} k={key} label={label} loading={!values} />
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex flex-col divide-y divide-fg/[0.07] rounded-[12px] border border-fg/[0.08] sm:hidden">
        {rows.map(({ key, label }) => (
          <TimingCard key={key} k={key} label={label} loading={!values} where={where} />
        ))}
      </div>
    </div>
  );
}

function Current({ k, loading }: { k: Timing; loading: boolean }) {
  const t = useTranslations("docs.live");
  const { value, shorter } = useTiming(k);
  if (loading) return <span className="skeleton inline-block h-4 w-24 align-middle" />;
  if (!value) return <span className="text-fg-3">—</span>;
  return (
    <span className={cn("num", shorter ? "text-fg" : "text-fg-3")}>
      {value}
      {shorter ? <span className="block text-xs text-fg-3">{t("shortened")}</span> : null}
    </span>
  );
}

function TimingRow({ k, label, loading }: { k: Timing; label: string; loading: boolean }) {
  const { production } = useTiming(k);
  return (
    <tr className="border-t border-fg/[0.07] align-top">
      <th scope="row" className="w-[34%] px-4 py-3 font-medium text-fg">
        {label}
      </th>
      <td className="num px-4 py-3 text-fg-2">{production}</td>
      <td className="px-4 py-3" data-testid={`timing-current-${k}`}>
        <Current k={k} loading={loading} />
      </td>
    </tr>
  );
}

function TimingCard({ k, label, loading, where }: { k: Timing; label: string; loading: boolean; where: string }) {
  const t = useTranslations("docs.live");
  const { production } = useTiming(k);
  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-1 px-4 py-3.5 text-sm">
      <dt className="col-span-2 font-medium text-fg">{label}</dt>
      <dd className="text-fg-2">
        <span className="block text-xs text-fg-3">{t("production")}</span>
        <span className="num">{production}</span>
      </dd>
      <dd>
        <span className="block text-xs text-fg-3">{t("current", { where })}</span>
        <Current k={k} loading={loading} />
      </dd>
    </dl>
  );
}
