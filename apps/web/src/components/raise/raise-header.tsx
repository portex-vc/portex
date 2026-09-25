"use client";

import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { RaiseDetail } from "@/lib/api";
import { displayStage, STAGE_TONE, stageLabel } from "@/lib/stages";
import { useNumbers } from "@/lib/use-numbers";
import { cn } from "@/lib/utils";
import { XLogo } from "@/components/brand/x-logo";
import { useTradeHref } from "@/lib/trade-link";
import { ArrowLeftRight, BookOpen, Check, ChevronLeft, Github, Globe, Link2 } from "lucide-react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useState } from "react";
import { ProjectAvatar } from "./project-avatar";
import { TypeBadge } from "./type-badge";

function profileUrl(field: string, value: string) {
  const raw = value?.trim();
  if (!raw) return null;
  if (/^https?:\/\//i.test(raw))
    return field === "twitter" ? raw.replace(/^https?:\/\/(www\.|mobile\.)?twitter\.com\b/i, "https://x.com") : raw;
  if (/^[\w@./-]+$/.test(raw) && (field === "twitter" || field === "github"))
    return `https://${field === "twitter" ? "x.com" : "github.com"}/${raw.replace(/^@/, "")}`;
  return null;
}

const ICONS = { website: Globe, twitter: XLogo, github: Github, docs: BookOpen } as const;

/**
 * Project header (DESIGN_V2 §6): identity on the left, links on the right, then one key number for
 * the current stage set largest, with the supporting figures beside it — no box around them.
 */
export function RaiseHeader({ detail: r }: { detail: RaiseDetail }) {
  const n = useNumbers();
  const t = useTranslations();
  const v = useTranslations("v31");
  const c = useTranslations("common");
  const fields = useTranslations("builderConsole.fields");
  const [copied, setCopied] = useState(false);
  const trade = useTradeHref(r);
  const stage = displayStage(r.phase);
  const tone = STAGE_TONE[stage];
  const pending = r.phase === "ListingPending";
  const name = r.profile.name || r.name;
  const change =
    r.bookPrice && BigInt(r.curvePrice) > 0n
      ? Number(((BigInt(r.bookPrice) - BigInt(r.curvePrice)) * 10000n) / BigInt(r.curvePrice))
      : null;
  const sold = BigInt(r.allocation) > 0n ? Number((BigInt(r.sold) * 10000n) / BigInt(r.allocation)) : 0;

  const key: { label: string; value: string; unit?: string; tone?: string; sub?: React.ReactNode } =
    r.phase === "Stage1"
      ? {
          label: c("raised"),
          value: n.quote(r.E),
          unit: r.quote.symbol,
          sub: <span className="text-fg-3">{t("card.sold", { value: n.pct(sold) })}</span>,
        }
      : stage === "Stage2"
        ? {
            label: c("bookPrice"),
            value: n.price(r.bookPrice),
            unit: r.quote.symbol,
            sub:
              change !== null ? (
                <span className={change >= 0 ? "text-positive" : "text-negative"}>
                  {t("card.vsStage1", { value: n.signedPct(change) })}
                </span>
              ) : null,
          }
        : r.phase === "Stage3"
          ? {
              label: v("listingPrice"),
              value: n.price(r.bookPrice),
              unit: r.quote.symbol,
              sub: r.deadlines.listedAt ? (
                <span className="text-fg-3">{t("card.listed", { date: n.date(r.deadlines.listedAt) })}</span>
              ) : null,
            }
          : {
              label: v("outcome"),
              value: v("refundTitle"),
              sub: <span className="text-fg-3">{v("claimPerPosition")}</span>,
            };

  const secondary: [string, string, string?, string?][] = [
    ...(r.phase === "Stage1"
      ? ([
          [v("curvePrice"), n.price(r.curvePrice), r.quote.symbol],
          [v("targetPriceShort"), n.price(r.targetPrice), r.quote.symbol],
        ] as [string, string, string][])
      : []),
    ...(stage === "Stage2"
      ? ([
          [c("escrow"), n.quote(r.E), r.quote.symbol, "text-protected"],
          [v("reserve"), n.quote(r.R), r.quote.symbol],
        ] as [string, string, string, string?][])
      : []),
    ...(r.phase === "Stage3" && r.listingRecord
      ? ([[v("poolQuote"), n.quote(r.listingRecord.usedQuote), r.quote.symbol]] as [string, string, string][])
      : []),
    ...(r.phase === "Dissolved" && r.backers === 0
      ? []
      : ([[c("backers"), n.number(r.backers, 0)]] as [string, string][])),
  ];

  const links = (["website", "twitter", "github", "docs"] as const)
    .map((f) => [f, profileUrl(f, r.profile[f] ?? "")] as const)
    .filter(([, href]) => href);

  return (
    <header className="flex flex-col gap-8">
      <Link
        href="/#raises"
        className="-mb-2 inline-flex w-fit items-center gap-1 text-xs text-fg-3 transition-colors hover:text-fg"
      >
        <ChevronLeft className="size-3.5" aria-hidden />
        {t("nav.raises")}
      </Link>
      <div className="flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 items-start gap-4">
          <ProjectAvatar symbol={r.symbol} profile={r.profile} size="lg" />
          <div className="min-w-0">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <h1 className="t-title break-words">{name}</h1>
              <span className="font-mono text-sm text-fg-3">{r.symbol}</span>
            </div>
            {r.profile.tagline ? <p className="mt-1.5 text-[0.9375rem] text-fg-2">{r.profile.tagline}</p> : null}
            <div className="mt-3.5 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs">
              <span data-testid="stage-badge" className={cn("inline-flex items-center gap-1.5 font-medium", tone.text)}>
                <span aria-hidden className={cn("size-1.5 rounded-full", tone.dot)} />
                {stageLabel(t, stage)}
                {pending ? <span className="font-normal text-fg-2"> · {v("listingAvailable")}</span> : null}
              </span>
              <TypeBadge template={r.template} />
              <RiskLine r={r} />
            </div>
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-1 sm:flex-nowrap sm:pt-1">
          {trade ? (
            <Button asChild size="sm" className="group mr-1.5 gap-1.5 px-3.5" data-testid="trade-link">
              <Link href={trade}>
                <ArrowLeftRight className="!size-3.5 transition-transform duration-200 ease-out group-hover:translate-x-0.5" />
                {t("raise.trade")}
              </Link>
            </Button>
          ) : null}
          {links.map(([field, href]) => {
            const Icon = ICONS[field];
            return (
              <Tooltip key={field}>
                <TooltipTrigger asChild>
                  <Button asChild variant="ghost" size="icon-sm">
                    <a href={href!} target="_blank" rel="noreferrer" aria-label={fields(field)}>
                      <Icon className={field === "twitter" ? "!size-3.5" : undefined} />
                    </a>
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{fields(field)}</TooltipContent>
              </Tooltip>
            );
          })}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="outline"
                size="icon-sm"
                aria-label={c(copied ? "copied" : "copy")}
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(window.location.href.split("#")[0]);
                    setCopied(true);
                    window.setTimeout(() => setCopied(false), 1400);
                  } catch {
                    setCopied(false);
                  }
                }}
              >
                {copied ? <Check className="text-positive" /> : <Link2 />}
              </Button>
            </TooltipTrigger>
            <TooltipContent>{c(copied ? "copied" : "copy")}</TooltipContent>
          </Tooltip>
        </div>
      </div>

      <dl className="grid grid-cols-2 gap-x-8 gap-y-6 md:flex md:flex-wrap md:items-end md:gap-x-0">
        <div className="col-span-2 min-w-0 md:pr-10">
          <dt className="text-xs text-fg-3">{key.label}</dt>
          <dd className="mt-1.5 flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className={cn(key.unit ? "t-figure-xl" : "t-figure-lg", "text-fg")}>
              {key.value}
              {key.unit ? <span className="ml-2 text-sm tracking-normal text-fg-3">{key.unit}</span> : null}
            </span>
            {key.sub ? <span className="num text-sm">{key.sub}</span> : null}
          </dd>
        </div>
        {secondary.map(([label, value, unit, toneClass]) => (
          <div key={label} className="min-w-0 md:border-l md:border-fg/[0.08] md:px-8">
            <dt className="text-xs text-fg-3">{label}</dt>
            <dd className={cn("t-figure mt-1.5", toneClass ?? "text-fg")}>
              {value}
              {unit ? <span className="ml-1.5 text-xs tracking-normal text-fg-3">{unit}</span> : null}
            </dd>
          </div>
        ))}
      </dl>
    </header>
  );
}

function RiskLine({ r }: { r: RaiseDetail }) {
  const c = useTranslations("common");
  const n = useNumbers();
  if (r.vetoActive)
    return (
      <span className="inline-flex items-center gap-1.5 font-medium text-negative">
        <span aria-hidden className="size-1.5 rounded-full bg-negative" />
        {c("vetoActive")}
      </span>
    );
  if (r.riskScoreBps === null) return <span className="text-fg-3">{c("notAnalysed")}</span>;
  const bps = r.riskScoreBps;
  const dot = bps < 2500 ? "bg-positive" : bps < 5000 ? "bg-fg-3" : bps < 7500 ? "bg-risk" : "bg-negative";
  return (
    <span className="num inline-flex items-center gap-1.5 text-fg-2">
      <span aria-hidden className={cn("size-1.5 rounded-full", dot)} />
      {c("riskValue", { value: n.pct(bps) })}
    </span>
  );
}
