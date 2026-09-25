"use client";

import { Countdown } from "@/components/countdown";
import { Reveal } from "@/components/motion/reveal";
import type { RaiseSummary } from "@/lib/api";
import { spotlight } from "@/lib/spotlight";
import { displayStage, nextTransition, STAGE_TONE } from "@/lib/stages";
import { useNumbers } from "@/lib/use-numbers";
import { cn } from "@/lib/utils";
import { ArrowUpRight } from "lucide-react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { ProjectAvatar } from "./project-avatar";
import { Sparkline } from "./sparkline";

/** Change of the book price against the Stage 1 price, in basis points. */
function changeBps(r: RaiseSummary) {
  if (!r.bookPrice || !r.curvePrice || BigInt(r.curvePrice) === 0n) return null;
  return Number(((BigInt(r.bookPrice) - BigInt(r.curvePrice)) * 10000n) / BigInt(r.curvePrice));
}

/**
 * Project card (DESIGN_V2 §6): identity, one stage-specific instrument, and the few facts that
 * decide whether to open it. The whole card is the link; hover lifts it and a soft spotlight
 * follows the cursor.
 */
export function RaiseCard({ r, index = 0, showType = false }: { r: RaiseSummary; index?: number; showType?: boolean }) {
  const n = useNumbers();
  const t = useTranslations();
  const c = useTranslations("card");
  const stage = displayStage(r.phase);
  const tone = STAGE_TONE[stage];
  const sold = BigInt(r.allocation) > 0n ? Number((BigInt(r.sold) * 10000n) / BigInt(r.allocation)) : 0;
  const change = changeBps(r);
  const deadline = nextTransition(r).at;
  const name = r.profile.name || r.name;
  const pending = r.phase === "ListingPending";

  return (
    <Reveal index={index} className="h-full min-w-0">
      <Link
        href={`/raise/${r.address}`}
        data-testid="raise-card"
        onPointerMove={spotlight}
        className="surface-1 card-interactive group flex h-full min-w-0 flex-col p-5 focus-visible:outline-offset-4"
      >
        <div className="flex items-start gap-3.5">
          <ProjectAvatar symbol={r.symbol} profile={r.profile} />
          <div className="min-w-0 flex-1 pt-0.5">
            <div className="flex items-baseline gap-2">
              <h3 className="truncate text-[0.9375rem] font-medium tracking-[-0.01em] text-fg">{name}</h3>
              <span className="shrink-0 font-mono text-[0.6875rem] text-fg-3">{r.symbol}</span>
            </div>
            <p className="mt-1 line-clamp-2 min-h-[2.5rem] text-[0.8125rem] leading-5 text-fg-2">
              {r.profile.tagline || r.description}
            </p>
          </div>
          <ArrowUpRight
            aria-hidden
            className="mt-0.5 size-4 shrink-0 -translate-x-1 translate-y-1 text-fg-3 opacity-0 transition-[opacity,transform] duration-200 ease-out group-hover:translate-x-0 group-hover:translate-y-0 group-hover:opacity-100"
          />
        </div>

        <div className="mt-5 flex items-center gap-2 text-xs">
          <span className={cn("inline-flex items-center gap-1.5 font-medium", tone.text)}>
            <span aria-hidden className={cn("size-1.5 rounded-full", tone.dot)} />
            {t(`stages.${stage}.short`)}
          </span>
          {stage === "Dissolved" ? null : (
            <span className="truncate text-fg-3">
              {pending ? <span className="text-fg-2">{t("v31.listingAvailable")}</span> : t(`stages.${stage}.name`)}
            </span>
          )}
          {showType ? (
            <span className="ml-auto text-2xs text-fg-3">
              {t(`types.${r.template === "BUDGET_LAUNCH" ? "milestone" : "sealed"}.title`)}
            </span>
          ) : null}
        </div>

        {/* Stage instrument */}
        <div className="mt-3 flex min-h-[5.25rem] flex-col justify-end">
          {r.phase === "Stage1" ? (
            <>
              <div className="flex items-baseline justify-between gap-3">
                <p className="t-figure text-fg">
                  {n.quote(r.E)} <span className="text-xs tracking-normal text-fg-3">{r.quote.symbol}</span>
                </p>
                <p className="num text-xs text-fg-3">
                  {t("v31.curvePrice")} <span className="text-fg-2">{n.price(r.curvePrice)}</span>
                </p>
              </div>
              <div className="mt-3 h-[3px] overflow-hidden rounded-full bg-fg/[0.07]">
                <div
                  className="h-full rounded-full bg-fg transition-[width] duration-700 ease-out"
                  style={{ width: `${Math.min(sold / 100, 100)}%` }}
                />
              </div>
              <p className="num mt-2 text-xs text-fg-3">{c("sold", { value: n.pct(sold) })}</p>
            </>
          ) : stage === "Stage2" ? (
            <>
              <div className="flex items-end justify-between gap-3">
                <p className="t-figure text-fg">
                  {n.price(r.bookPrice)} <span className="text-xs tracking-normal text-fg-3">{r.quote.symbol}</span>
                </p>
                {change !== null ? (
                  <p className={cn("num pb-0.5 text-xs", change >= 0 ? "text-positive" : "text-negative")}>
                    {c("vsStage1", { value: n.signedPct(change) })}
                  </p>
                ) : null}
              </div>
              <Sparkline raise={r.address} baseline={r.curvePrice} className="mt-2" height={40} />
            </>
          ) : r.phase === "Stage3" ? (
            <>
              <p className="text-xs text-fg-3">{t("v31.listingPrice")}</p>
              <p className="t-figure mt-1 text-fg">
                {n.price(r.bookPrice)} <span className="text-xs tracking-normal text-fg-3">{r.quote.symbol}</span>
              </p>
              {r.deadlines.listedAt ? (
                <p className="num mt-1 text-xs text-fg-3">{c("listed", { date: n.date(r.deadlines.listedAt) })}</p>
              ) : null}
            </>
          ) : (
            <>
              <p className="text-xs text-fg-3">{t("v31.outcome")}</p>
              <p className="mt-1 text-lg font-medium tracking-tight text-fg">{t("v31.refundTitle")}</p>
              <p className="mt-1 text-xs text-fg-3">{t("v31.claimPerPosition")}</p>
            </>
          )}
        </div>

        <div className="mt-5 flex flex-wrap items-center gap-x-3 gap-y-1 whitespace-nowrap border-t border-fg/[0.07] pt-3.5 text-xs text-fg-3">
          <span className="num">{c("backers", { count: r.backers })}</span>
          {stage !== "Dissolved" && stage !== "Stage3" ? (
            <>
              <span aria-hidden className="text-fg/20">
                ·
              </span>
              <span className="num">
                {t("common.escrow")} <span className="text-fg-2">{n.quote(r.E)}</span>
              </span>
            </>
          ) : null}
          <span className="ml-auto flex items-center gap-3">
            <Risk r={r} />
            {deadline && (r.phase === "Stage1" || r.phase === "Stage2") ? (
              <span className="num text-fg-2">
                <Countdown to={deadline} dueLabel={r.phase === "Stage1" ? t("v31.closeStage1") : undefined} />
              </span>
            ) : null}
          </span>
        </div>
      </Link>
    </Reveal>
  );
}

function Risk({ r }: { r: RaiseSummary }) {
  const t = useTranslations("common");
  const n = useNumbers();
  if (r.vetoActive)
    return (
      <span className="inline-flex items-center gap-1.5 text-negative">
        <span aria-hidden className="size-1.5 rounded-full bg-negative" />
        {t("vetoActive")}
      </span>
    );
  if (r.riskScoreBps === null) return null;
  const bps = r.riskScoreBps;
  const dot = bps < 2500 ? "bg-positive" : bps < 5000 ? "bg-fg-3" : bps < 7500 ? "bg-risk" : "bg-negative";
  return (
    <span className="num inline-flex items-center gap-1.5" title={t("risk")}>
      <span aria-hidden className={cn("size-1.5 rounded-full", dot)} />
      {t("riskValue", { value: n.pct(bps) })}
    </span>
  );
}
