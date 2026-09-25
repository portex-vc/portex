"use client";

import { Countdown } from "@/components/countdown";
import { TestnetTimingNote, useTestnetTiming } from "@/components/testnet-timing";
import type { RaiseDetail } from "@/lib/api";
import { useNow } from "@/lib/hooks";
import { displayStage, STAGE_TONE, type DisplayStage } from "@/lib/stages";
import { useNumbers } from "@/lib/use-numbers";
import { cn } from "@/lib/utils";
import { CornerDownRight } from "lucide-react";
import { useTranslations } from "next-intl";

type Main = "Stage1" | "Stage2" | "Stage3";

/**
 * Project stage progress (DESIGN_V2 §6): one slim track per stage. Done stages are solid, the
 * current stage fills with elapsed time and carries a live head, future stages are faint.
 * Dissolution is a neutral fork under Stage 1 (a normal outcome, never styled as an error).
 * Conditions follow as plain facts, not boxed chips.
 */
export function StageTimeline({ detail: r }: { detail: RaiseDetail }) {
  const t = useTranslations();
  const v = useTranslations("v31");
  const n = useNumbers();
  const now = useNow();
  const current = displayStage(r.phase);
  const dissolved = r.phase === "Dissolved";
  const byTeam = dissolved && r.dissolvedBy === "builder";
  const order: Main[] = ["Stage1", "Stage2", "Stage3"];
  const index = dissolved ? 0 : order.indexOf(current as Main);
  const d = r.deadlines;

  const windows: Record<Main, [number, number] | null> = {
    Stage1: [d.start, Math.max(d.stage1End, d.vetoUntil)],
    Stage2: d.stage2Start ? [d.stage2Start, d.stage2End] : null,
    Stage3: d.listedAt ? [d.listedAt, d.listedAt] : null,
  };
  const fraction = (stage: Main) => {
    const w = windows[stage];
    if (!w || !now) return 0;
    if (w[1] <= w[0]) return 1;
    return Math.min(1, Math.max(0, (now - w[0]) / (w[1] - w[0])));
  };

  const testnet = useTestnetTiming(r.governance.config.parameters);
  const conditions: [string, React.ReactNode][] =
    r.phase === "Stage1"
      ? [
          [
            v("targetSold"),
            n.pct(BigInt(r.allocation) > 0n ? Number((BigInt(r.sold) * 10000n) / BigInt(r.allocation)) : 0),
          ],
          [
            v("minimumBackers"),
            `${n.number(r.backers, 0)} / ${n.number(r.governance.config.parameters.minimumBackers, 0)}`,
          ],
          [t("common.deadline"), n.date(d.stage1End)],
          [v("veto"), r.vetoActive ? n.date(d.vetoUntil) : v("noVeto")],
        ]
      : r.phase === "Stage2" || r.phase === "ListingPending"
        ? [
            [v("timeRemaining"), <Countdown key="c" to={d.stage2End} dueLabel={v("listingAvailable")} />],
            [
              v("listingPreview"),
              r.listingPreview && "price" in r.listingPreview
                ? `${n.price(r.listingPreview.price)} ${r.quote.symbol}`
                : v("previewAtDeadline"),
            ],
          ]
        : [];

  return (
    <section data-testid="stage-timeline" aria-label={t("raise.lifecycle")} className="flex flex-col gap-5">
      <div role="group" data-testid="lifecycle-graph" data-mode="raise" className="grid gap-4 sm:grid-cols-3 sm:gap-4">
        {order.map((stage, i) => {
          const state = dissolved
            ? i === 0
              ? "closed"
              : "future"
            : i < index
              ? "done"
              : i === index
                ? "current"
                : "future";
          const tone = STAGE_TONE[stage as DisplayStage];
          const w = windows[stage];
          const pct = state === "done" ? 1 : state === "current" ? (stage === "Stage3" ? 1 : fraction(stage)) : 0;
          return (
            <div
              key={stage}
              data-testid={`lifecycle-node-${stage}`}
              data-state={state === "closed" ? "done" : state}
              aria-current={state === "current" ? "step" : undefined}
              className="flex min-w-0 gap-3.5 sm:block"
              style={{ "--p": state === "closed" ? 1 : pct } as React.CSSProperties}
            >
              {/* One track per stage: vertical beside the label on phones, horizontal above it from sm. */}
              <div className="relative w-[3px] shrink-0 self-stretch rounded-full bg-fg/[0.07] sm:h-[3px] sm:w-auto">
                <div
                  className={cn(
                    "absolute inset-x-0 top-0 h-[calc(var(--p)*100%)] rounded-full transition-[width,height] duration-700 ease-out sm:inset-x-auto sm:inset-y-0 sm:left-0 sm:h-auto sm:w-[calc(var(--p)*100%)]",
                    state === "closed" || state === "done" ? "bg-fg/35" : "bg-fg",
                  )}
                />
                {state === "current" && stage !== "Stage3" ? (
                  <span
                    aria-hidden
                    className="absolute left-1/2 top-[calc(var(--p)*100%)] size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-fg ring-4 ring-fg/10 sm:left-[calc(var(--p)*100%)] sm:top-1/2"
                  />
                ) : null}
              </div>
              <div className="min-w-0 flex-1 pb-1 sm:pb-0">
                <div className="flex items-center gap-2 sm:mt-3">
                  <span
                    aria-hidden
                    className={cn(
                      "size-1.5 rounded-full",
                      state === "future" ? "bg-fg/20" : state === "closed" ? "bg-fg-3" : tone.dot,
                    )}
                  />
                  <p
                    className={cn(
                      "truncate text-sm",
                      state === "current" ? "font-medium text-fg" : state === "future" ? "text-fg-3" : "text-fg-2",
                    )}
                  >
                    <span className={state === "current" ? "text-fg-2" : undefined}>
                      {t(`stages.${stage}.short`)} ·{" "}
                    </span>
                    {t(`stages.${stage}.name`)}
                  </p>
                </div>
                <p className="num mt-1 truncate pl-3.5 text-xs text-fg-3">
                  {state === "current" && r.phase === "ListingPending" ? (
                    <span data-testid="lifecycle-listing-pending" className="font-medium text-fg">
                      {t("v31.listingAvailable")}
                    </span>
                  ) : state === "current" && stage !== "Stage3" && w ? (
                    <span data-testid="lifecycle-countdown">
                      {t("common.deadline")} {n.date(w[1])} ·{" "}
                      <span className="text-fg-2">
                        <Countdown to={w[1]} />
                      </span>
                    </span>
                  ) : (state === "done" || state === "closed" || (state === "current" && stage === "Stage3")) && w ? (
                    stage === "Stage3" ? (
                      t("card.listed", { date: n.date(w[0]) })
                    ) : (
                      <span title={`${n.date(w[0])} – ${n.date(w[1])}`}>{`${n.day(w[0])} – ${n.day(w[1])}`}</span>
                    )
                  ) : (
                    t(`stages.${stage}.path`)
                  )}
                </p>
                {stage === "Stage1" && (r.phase === "Stage1" || dissolved) ? (
                  <p
                    data-testid="lifecycle-node-Dissolved"
                    data-state={dissolved ? "current" : "future"}
                    className={cn(
                      "mt-2 flex items-center gap-1.5 pl-0.5 text-xs",
                      dissolved ? "font-medium text-fg-2" : "text-fg-3",
                    )}
                  >
                    <CornerDownRight className="size-3.5 shrink-0" aria-hidden />
                    {t("stages.Dissolved.path")}
                  </p>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>

      {dissolved || conditions.length || testnet.shortened ? (
        <div
          className={cn(
            "flex flex-wrap items-start justify-between gap-x-6 gap-y-3",
            !dissolved && conditions.length ? "border-t border-fg/[0.07] pt-4" : null,
          )}
        >
          {dissolved ? (
            <p className="flex min-w-0 flex-1 items-start gap-2 text-sm text-fg-2" data-testid="dissolution-note">
              <span aria-hidden className="mt-1.5 size-1.5 shrink-0 rounded-full bg-fg-3" />
              <span>
                {r.dissolvedAt
                  ? v(byTeam ? "dissolvedByTeam" : "dissolvedAtDeadline", { date: n.date(r.dissolvedAt) })
                  : null}{" "}
                {v("refundExplanation")}
              </span>
            </p>
          ) : conditions.length ? (
            <dl className="flex min-w-0 flex-1 flex-wrap items-center gap-x-6 gap-y-2 text-xs">
              <dt className="micro w-full sm:w-auto">{v("conditions")}</dt>
              {conditions.map(([label, value]) => (
                <div key={label} className="flex items-baseline gap-2">
                  <dt className="text-fg-3">{label}</dt>
                  <dd className="num text-fg">{value}</dd>
                </div>
              ))}
            </dl>
          ) : null}
          {/* One marker for every date and duration in this view, where testnet timings are shortened. */}
          <TestnetTimingNote pinned={r.governance.config.parameters} className="ml-auto" />
        </div>
      ) : null}
    </section>
  );
}
