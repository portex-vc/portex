"use client";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useApiConfig } from "@/lib/hooks";
import { isShortened, PRODUCTION_TIMINGS, testnetTimingsOf, toTimings, type Timings } from "@/lib/testnet-timing";
import { useNumbers } from "@/lib/use-numbers";
import { cn } from "@/lib/utils";
import { Info, Timer } from "lucide-react";
import { useTranslations } from "next-intl";

type Pinned = Parameters<typeof isShortened>[0];

/**
 * Whether the timings on screen are shortened for testing. With `pinned` (a raise's or version's own
 * parameters) that set decides; otherwise the deployment's current templates from `/v2/config` do.
 */
export function useTestnetTiming(pinned?: Pinned) {
  const { data: config } = useApiConfig();
  const deployment = testnetTimingsOf(config?.templates);
  if (pinned && pinned.stage1Min !== undefined && pinned.stage1Min !== null)
    return { shortened: isShortened(pinned), timings: toTimings(pinned) ?? deployment.timings };
  return deployment;
}

function useRange() {
  return useNumbers().durationRange;
}

/** Production stage ranges as the explanation and the hint quote them. */
function useProductionRanges() {
  const range = useRange();
  return {
    stage1: range(PRODUCTION_TIMINGS.stage1Min, PRODUCTION_TIMINGS.stage1Max),
    stage2: range(PRODUCTION_TIMINGS.stage2Min, PRODUCTION_TIMINGS.stage2Max),
  };
}

/** The one explanation: a sentence, then this testnet's pinned timings next to production's. */
function Explanation({ timings }: { timings: Timings | null }) {
  const t = useTranslations("testnet");
  const n = useNumbers();
  const range = useRange();
  const production = useProductionRanges();
  const d = (s: number) => n.duration(s);
  const rows: [string, (x: Timings) => string][] = [
    [t("rows.stage1"), (x) => range(x.stage1Min, x.stage1Max)],
    [t("rows.stage2"), (x) => range(x.stage2Min, x.stage2Max)],
    [t("rows.votes"), (x) => [x.voting, x.dispute, x.execution].map(d).join(" · ")],
    [t("rows.veto"), (x) => t("vetoValue", { max: d(x.vetoMax), total: d(x.vetoTotal) })],
    [t("rows.treasury"), (x) => d(x.treasuryVesting)],
  ];
  return (
    <div className="space-y-3" data-testid="testnet-timing-explanation">
      <p className="flex items-center gap-2 text-sm font-medium text-fg">
        <Timer className="size-3.5 text-fg-3" aria-hidden />
        {t("title")}
      </p>
      <p className="text-xs leading-relaxed text-fg-2">{t("explanation", production)}</p>
      <table className="w-full text-2xs">
        <thead>
          <tr className="text-left text-fg-3">
            <th className="pb-1.5 font-normal" />
            <th className="pb-1.5 pl-3 font-normal">{t("here")}</th>
            <th className="pb-1.5 pl-3 font-normal">{t("production")}</th>
          </tr>
        </thead>
        <tbody className="num">
          {rows.map(([label, value]) => (
            <tr key={label} className="border-t border-fg/[0.06]">
              <th scope="row" className="py-1.5 pr-2 text-left font-normal text-fg-3">
                {label}
              </th>
              <td className="py-1.5 pl-3 text-fg">{timings ? value(timings) : "—"}</td>
              <td className="py-1.5 pl-3 text-fg-2">{value(PRODUCTION_TIMINGS)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ExplanationPopover({
  timings,
  children,
  align = "end",
}: {
  timings: Timings | null;
  children: React.ReactNode;
  align?: "start" | "center" | "end";
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent align={align} className="w-[min(24rem,calc(100vw-2rem))] p-4">
        <Explanation timings={timings} />
      </PopoverContent>
    </Popover>
  );
}

/**
 * Quiet marker where shortened testnet timings appear, one per view:
 * - `marker`: a small dashed "Testnet timing" chip (stage timeline, governance);
 * - `hint`: one line beside stage-length bounds, "Shortened for testnet · production: …";
 * - `footnote`: under production copy, when projects on the same screen run shortened timings.
 * Each opens the same explanation on click or tap. Renders nothing on a production-timed deployment.
 */
export function TestnetTimingNote({
  pinned,
  variant = "marker",
  className,
  align,
}: {
  pinned?: Pinned;
  variant?: "marker" | "hint" | "footnote";
  className?: string;
  align?: "start" | "center" | "end";
}) {
  const t = useTranslations("testnet");
  const production = useProductionRanges();
  const { shortened, timings } = useTestnetTiming(pinned);
  if (!shortened) return null;
  const trigger =
    variant === "marker" ? (
      <button
        type="button"
        data-testid="testnet-timing"
        className={cn(
          "inline-flex h-6 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border border-dashed border-fg/[0.16] px-2 text-2xs text-fg-3 transition-colors duration-150 hover:border-fg/30 hover:text-fg-2 data-[state=open]:border-fg/30 data-[state=open]:text-fg-2",
          className,
        )}
      >
        <Timer className="size-3" aria-hidden />
        {t("marker")}
      </button>
    ) : (
      <button
        type="button"
        aria-label={t("title")}
        data-testid={`testnet-timing-${variant}`}
        className="inline-flex size-5 shrink-0 items-center justify-center rounded-full text-fg-3 transition-colors hover:bg-fg/[0.06] hover:text-fg-2 data-[state=open]:text-fg-2"
      >
        <Info className="size-3.5" aria-hidden />
      </button>
    );
  const popover = (
    <ExplanationPopover timings={timings} align={align ?? (variant === "marker" ? "end" : "start")}>
      {trigger}
    </ExplanationPopover>
  );
  if (variant === "marker") return popover;
  return (
    <p className={cn("flex items-start gap-1.5 text-xs leading-relaxed text-fg-3", className)}>
      <Timer className="mt-[3px] size-3 shrink-0" aria-hidden />
      <span>{variant === "hint" ? t("hint", production) : t("footnote")}</span>
      {popover}
    </p>
  );
}

/**
 * Small diagonal corner ribbon on a template card whose pinned timings are shortened for testing.
 * The card must be `relative` with its corner free; the ribbon clips to the card's radius.
 */
export function TestnetRibbon({ pinned, className }: { pinned?: Pinned; className?: string }) {
  const t = useTranslations("testnet");
  const production = useProductionRanges();
  if (!isShortened(pinned)) return null;
  return (
    <span
      className={cn(
        "pointer-events-none absolute right-0 top-0 z-10 size-[7.5rem] overflow-hidden rounded-tr-[inherit]",
        className,
      )}
      data-testid="testnet-ribbon"
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="pointer-events-auto absolute right-[-3rem] top-[2.625rem] block w-[12.5rem] rotate-45 cursor-help border-y border-fg/[0.1] bg-surface-3 py-[3px] text-center text-[0.5625rem] font-medium uppercase leading-[0.875rem] tracking-[0.12em] text-fg-2 shadow-[0_1px_2px_rgb(0_0_0/0.12)]">
            {t("ribbon")}
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="max-w-[18rem]">
          {t("explanation", production)}
        </TooltipContent>
      </Tooltip>
    </span>
  );
}
