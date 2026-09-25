"use client";

import { ProjectAvatar } from "@/components/raise/project-avatar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { MarketRow } from "@/lib/market";
import { STAGE_TONE, stageLabel } from "@/lib/stages";
import { cn } from "@/lib/utils";
import { ArrowUpRight, ChevronLeft } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import Link from "next/link";
import { ChangeFigure, useMarketFormat } from "./markets-table";

/** Identity, the live pool price as the one key number, and the supporting market figures (DESIGN_V2 §6). */
export function MarketHeader({ market: m, quoteSymbol }: { market: MarketRow; quoteSymbol: string }) {
  const t = useTranslations("markets.page");
  const tAll = useTranslations();
  const f = useMarketFormat();
  const format = useFormatter();
  const tone = STAGE_TONE.Stage3;
  const figures: [string, string, string?, string?][] = [
    [t("volume24h"), f.usd(m.volume24h), quoteSymbol],
    [t("liquidity"), f.usd(m.liquidity), quoteSymbol, t("liquidityHint")],
    [t("fdv"), f.usd(m.fdv), quoteSymbol, t("fdvHint")],
    [t("trades"), format.number(m.tradeCount)],
  ];
  return (
    <header className="flex flex-col gap-8" data-testid="market-header">
      <div className="-mb-2 flex items-center justify-between gap-3 text-xs">
        <Link href="/markets" className="inline-flex items-center gap-1 text-fg-3 transition-colors hover:text-fg">
          <ChevronLeft className="size-3.5" aria-hidden />
          {t("back")}
        </Link>
        <Link
          href={`/raise/${m.address}`}
          data-testid="project-link"
          className="inline-flex items-center gap-1 text-fg-2 transition-colors hover:text-fg"
        >
          {t("projectPage")}
          <ArrowUpRight className="size-3.5" aria-hidden />
        </Link>
      </div>
      <div className="flex min-w-0 items-start gap-4">
        <ProjectAvatar symbol={m.symbol} profile={m.profile} size="lg" />
        <div className="min-w-0">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h1 className="t-title break-words">{m.profile.name || m.name}</h1>
            <span className="font-mono text-sm text-fg-3">{m.symbol}</span>
          </div>
          {m.profile.tagline ? <p className="mt-1.5 text-[0.9375rem] text-fg-2">{m.profile.tagline}</p> : null}
          <p className={cn("mt-3.5 inline-flex items-center gap-1.5 text-xs font-medium", tone.text)}>
            <span aria-hidden className={cn("size-1.5 rounded-full", tone.dot)} />
            {stageLabel(tAll, "Stage3")}
            {m.listedAt ? (
              <span className="font-normal text-fg-3">
                {" · "}
                {t("listed", {
                  date: format.dateTime(new Date(m.listedAt * 1000), {
                    month: "short",
                    day: "numeric",
                    year: "numeric",
                    timeZone: "UTC",
                  }),
                })}
              </span>
            ) : null}
          </p>
        </div>
      </div>
      <dl className="grid grid-cols-2 gap-x-8 gap-y-6 md:flex md:flex-wrap md:items-end md:gap-x-0">
        <div className="col-span-2 min-w-0 md:pr-10">
          <dt className="text-xs text-fg-3">{t("price")}</dt>
          <dd className="mt-1.5 flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="t-figure-xl text-fg" data-testid="market-price">
              {f.price(m.price)}
              <span className="ml-2 text-sm tracking-normal text-fg-3">{quoteSymbol}</span>
            </span>
            <span className="text-sm">
              <ChangeFigure bps={m.change24hBps} /> <span className="text-fg-3">{t("change24h")}</span>
            </span>
          </dd>
        </div>
        {figures.map(([label, value, unit, hint]) => (
          <div key={label} className="min-w-0 md:border-l md:border-fg/[0.08] md:px-8">
            <dt className="text-xs text-fg-3">
              {hint ? (
                <Tooltip>
                  <TooltipTrigger className="cursor-help underline decoration-fg/20 decoration-dotted underline-offset-4">
                    {label}
                  </TooltipTrigger>
                  <TooltipContent className="max-w-64">{hint}</TooltipContent>
                </Tooltip>
              ) : (
                label
              )}
            </dt>
            <dd className="t-figure mt-1.5 text-fg">
              {value}
              {unit ? <span className="ml-1.5 text-xs tracking-normal text-fg-3">{unit}</span> : null}
            </dd>
          </div>
        ))}
      </dl>
    </header>
  );
}
