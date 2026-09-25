"use client";

import { NativeSelect } from "@/components/figures";
import { ProjectAvatar } from "@/components/raise/project-avatar";
import { EmptyState, ErrorState } from "@/components/states";
import { Button } from "@/components/ui/button";
import { liveRouter, useMarkets, type MarketRow } from "@/lib/market";
import { cn } from "@/lib/utils";
import { ArrowDown, ArrowUp, ChevronsUpDown } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import Link from "next/link";
import { useState } from "react";
import { Spark } from "./spark";

type SortKey = "name" | "price" | "change" | "volume" | "liquidity" | "fdv";
const VALUE: Record<SortKey, (m: MarketRow) => number | string> = {
  name: (m) => (m.profile.name || m.name).toLowerCase(),
  price: (m) => Number(m.price),
  change: (m) => m.change24hBps,
  volume: (m) => Number(m.volume24h),
  liquidity: (m) => Number(m.liquidity),
  fdv: (m) => Number(m.fdv),
};

export function useMarketFormat() {
  const format = useFormatter();
  return {
    price: (value: string | number) => format.number(Number(value), { maximumSignificantDigits: 6 }),
    usd: (value: string | number) =>
      format.number(Number(value), { maximumFractionDigits: Math.abs(Number(value)) >= 1000 ? 0 : 2 }),
    change: (bps: number) =>
      format.number(bps / 10000, { style: "percent", maximumFractionDigits: 2, signDisplay: "exceptZero" }),
  };
}

export function ChangeFigure({ bps, className }: { bps: number; className?: string }) {
  const f = useMarketFormat();
  return (
    <span className={cn("num", bps > 0 ? "text-positive" : bps < 0 ? "text-negative" : "text-fg-3", className)}>
      {f.change(bps)}
    </span>
  );
}

/** Graduated projects and their pools: sortable on desktop, stacked on phones. */
export function MarketsTable() {
  const t = useTranslations("markets");
  const f = useMarketFormat();
  const { data, isLoading, isError, error, refetch } = useMarkets();
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: "volume", desc: true });
  if (isError && !data) return <ErrorState error={error} retry={() => refetch()} />;
  const rows = [...(data?.markets ?? [])].sort((a, b) => {
    const x = VALUE[sort.key](a),
      y = VALUE[sort.key](b);
    const order = typeof x === "string" ? x.localeCompare(String(y)) : x - (y as number);
    return (sort.desc ? -order : order) || Number(b.liquidity) - Number(a.liquidity);
  });
  const totals = {
    volume: rows.reduce((s, m) => s + Number(m.volume24h), 0),
    liquidity: rows.reduce((s, m) => s + Number(m.liquidity), 0),
  };
  const quoteSymbol = "USDG";
  const header = (key: SortKey, label: string, align: "left" | "right" = "right") => {
    const active = sort.key === key;
    const Icon = active ? (sort.desc ? ArrowDown : ArrowUp) : ChevronsUpDown;
    return (
      <th
        scope="col"
        aria-sort={active ? (sort.desc ? "descending" : "ascending") : "none"}
        className={cn("py-3 font-normal", align === "right" ? "pr-4 text-right" : "pl-1 pr-4 text-left")}
      >
        <button
          type="button"
          data-testid={`sort-${key}`}
          onClick={() => setSort({ key, desc: active ? !sort.desc : key !== "name" })}
          className={cn(
            "inline-flex items-center gap-1 transition-colors hover:text-fg",
            active ? "text-fg-2" : "text-fg-3",
            align === "right" && "flex-row-reverse",
          )}
        >
          {label}
          <Icon className={cn("size-3", !active && "opacity-50")} aria-hidden />
        </button>
      </th>
    );
  };

  return (
    <div className="space-y-8">
      <dl className="grid grid-cols-2 gap-y-6 border-y border-fg/[0.07] py-6 sm:grid-cols-3">
        {(
          [
            [t("summary.markets"), isLoading ? null : String(rows.length), ""],
            [t("summary.volume"), isLoading ? null : f.usd(totals.volume), quoteSymbol],
            [t("summary.liquidity"), isLoading ? null : f.usd(totals.liquidity), quoteSymbol],
          ] as const
        ).map(([label, value, unit], i) => (
          <div key={label} className={cn("min-w-0", i > 0 && "sm:border-l sm:border-fg/[0.08] sm:pl-8")}>
            <dt className="text-xs text-fg-3">{label}</dt>
            <dd className="t-figure mt-1.5">
              {value === null ? <span className="skeleton inline-block h-6 w-20 align-middle" /> : value}
              {unit && value !== null ? <span className="ml-1.5 text-xs tracking-normal text-fg-3">{unit}</span> : null}
            </dd>
          </div>
        ))}
      </dl>

      {data && !liveRouter(data.router) ? (
        <p className="text-sm text-fg-2" data-testid="trading-disabled">
          {t("tradingDisabled")}
        </p>
      ) : null}

      {isLoading ? (
        <div className="space-y-2" aria-busy data-testid="markets-loading">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="flex items-center gap-4 py-3">
              <div className="skeleton size-10 rounded-[11px]" />
              <div className="flex-1 space-y-2">
                <div className="skeleton h-4 w-40" />
                <div className="skeleton h-3 w-16" />
              </div>
              <div className="skeleton hidden h-4 w-24 md:block" />
              <div className="skeleton hidden h-4 w-20 md:block" />
              <div className="skeleton h-8 w-28" />
            </div>
          ))}
        </div>
      ) : !rows.length ? (
        <EmptyState
          title={t("empty.title")}
          detail={t("empty.detail")}
          action={
            <Button asChild variant="outline" size="sm">
              <Link href="/#raises">{t("empty.action")}</Link>
            </Button>
          }
        />
      ) : (
        <>
          <div className="hidden md:block">
            <table className="w-full text-sm" data-testid="markets-table">
              <thead className="border-b border-fg/[0.07] text-xs">
                <tr>
                  {header("name", t("columns.project"), "left")}
                  {header("price", t("columns.price"))}
                  {header("change", t("columns.change"))}
                  {header("volume", t("columns.volume"))}
                  {header("liquidity", t("columns.liquidity"))}
                  {header("fdv", t("columns.fdv"))}
                  <th scope="col" className="py-3 text-right text-xs font-normal text-fg-3">
                    {t("columns.trend")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((m) => (
                  <tr
                    key={m.address}
                    data-testid="market-row"
                    className="group relative border-b border-fg/[0.06] transition-colors hover:bg-fg/[0.025]"
                  >
                    <td className="py-4 pl-1 pr-4">
                      <Link
                        href={`/markets/${m.address}`}
                        className="flex items-center gap-3 after:absolute after:inset-0 focus-visible:outline-none focus-visible:after:rounded-[10px] focus-visible:after:ring-2 focus-visible:after:ring-fg/25"
                      >
                        <ProjectAvatar symbol={m.symbol} profile={m.profile} />
                        <span className="min-w-0">
                          <span className="block truncate font-medium">{m.profile.name || m.name}</span>
                          <span className="block font-mono text-xs text-fg-3">{m.symbol}</span>
                        </span>
                      </Link>
                    </td>
                    <td className="num py-4 pr-4 text-right">
                      {f.price(m.price)}
                      <span className="ml-1 text-xs text-fg-3">{quoteSymbol}</span>
                    </td>
                    <td className="py-4 pr-4 text-right">
                      <ChangeFigure bps={m.change24hBps} />
                    </td>
                    <td className="num py-4 pr-4 text-right">{f.usd(m.volume24h)}</td>
                    <td className="num py-4 pr-4 text-right">{f.usd(m.liquidity)}</td>
                    <td className="num py-4 pr-4 text-right">{f.usd(m.fdv)}</td>
                    <td className="py-4">
                      <Spark values={m.spark} className="ml-auto" />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-3 text-2xs text-fg-3">{t("columnsNote", { unit: quoteSymbol })}</p>
          </div>
          <label className="flex items-center justify-between gap-3 md:hidden">
            <span className="text-xs text-fg-3">{t("sortBy")}</span>
            <NativeSelect
              className="w-44"
              data-testid="markets-sort"
              value={sort.key}
              onChange={(e) => {
                const key = e.target.value as SortKey;
                setSort({ key, desc: key !== "name" });
              }}
            >
              {(["volume", "change", "liquidity", "fdv", "price", "name"] as const).map((key) => (
                <option key={key} value={key}>
                  {t(`columns.${key === "name" ? "project" : key === "change" ? "changeLong" : key}`)}
                </option>
              ))}
            </NativeSelect>
          </label>
          <ul className="flex flex-col gap-3 md:hidden" data-testid="markets-cards">
            {rows.map((m) => (
              <li key={m.address}>
                <Link
                  href={`/markets/${m.address}`}
                  data-testid="market-card"
                  className="surface-1 card-interactive flex flex-col gap-4 p-4"
                >
                  <div className="flex items-center gap-3">
                    <ProjectAvatar symbol={m.symbol} profile={m.profile} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">{m.profile.name || m.name}</span>
                      <span className="block font-mono text-xs text-fg-3">{m.symbol}</span>
                    </span>
                    <span className="text-right">
                      <span className="num block font-medium">
                        {f.price(m.price)} <span className="text-xs font-normal text-fg-3">{quoteSymbol}</span>
                      </span>
                      <ChangeFigure bps={m.change24hBps} className="text-xs" />
                    </span>
                  </div>
                  <div className="flex items-end justify-between gap-4">
                    <dl className="grid grid-cols-3 gap-x-4 text-xs">
                      {(
                        [
                          [t("columns.volume"), m.volume24h],
                          [t("columns.liquidity"), m.liquidity],
                          [t("columns.fdv"), m.fdv],
                        ] as const
                      ).map(([label, value]) => (
                        <div key={label} className="min-w-0">
                          <dt className="truncate text-fg-3">{label}</dt>
                          <dd className="num mt-0.5 text-fg-2">{f.usd(value)}</dd>
                        </div>
                      ))}
                    </dl>
                    <Spark values={m.spark} className="w-20 shrink-0" />
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
