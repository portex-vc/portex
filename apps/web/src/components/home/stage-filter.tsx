"use client";

import { stageCounts, STAGE_TONE, type DisplayStage } from "@/lib/stages";
import { useNumbers } from "@/lib/use-numbers";
import { cn } from "@/lib/utils";
import { ChevronRight, CornerDownRight } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import { useTranslations } from "next-intl";

/**
 * Home filter (DESIGN_V2 §6): the three stages in order with the refund fork set apart, as one
 * segmented control. The selection slides between options on the layout spring.
 */
export function StageFilter({
  counts,
  total,
  selected,
  onSelect,
}: {
  counts: Record<string, number>;
  total: number;
  selected: string;
  onSelect: (id: string) => void;
}) {
  const t = useTranslations();
  const n = useNumbers();
  const reduce = useReducedMotion();
  const c = stageCounts(counts);

  const option = (id: "all" | DisplayStage, label: React.ReactNode, count: number, icon?: React.ReactNode) => {
    const on = selected === id;
    return (
      <button
        key={id}
        type="button"
        onClick={() => onSelect(on && id !== "all" ? "all" : id)}
        aria-pressed={on}
        data-testid={id === "all" ? "stage-filter-all" : `lifecycle-node-${id}`}
        data-state={on ? "current" : "idle"}
        className={cn(
          "relative inline-flex h-8 shrink-0 items-center gap-2 whitespace-nowrap rounded-[9px] px-3 text-[0.8125rem] transition-colors duration-150",
          on ? "text-fg" : "text-fg-2 hover:text-fg",
        )}
      >
        {on ? (
          <motion.span
            layoutId="stage-filter-pill"
            aria-hidden
            className="absolute inset-0 -z-10 rounded-[9px] bg-surface-1 shadow-[0_1px_2px_rgb(0_0_0/0.12)] ring-1 ring-fg/[0.09]"
            transition={reduce ? { duration: 0 } : { type: "spring", stiffness: 520, damping: 42 }}
          />
        ) : null}
        {icon}
        {label}
        <span className={cn("num text-xs", on ? "text-fg-2" : "text-fg-3")}>{n.number(count, 0)}</span>
      </button>
    );
  };

  const stage = (id: "Stage1" | "Stage2" | "Stage3") =>
    option(
      id,
      <span>
        <span className="text-fg-3">{t(`stages.${id}.short`)} · </span>
        {t(`stages.${id}.name`)}
      </span>,
      c[id],
      <span aria-hidden className={cn("size-1.5 rounded-full", STAGE_TONE[id].dot)} />,
    );

  return (
    <div
      data-testid="lifecycle-graph"
      data-mode="counts"
      role="group"
      aria-label={t("home.pipeline")}
      className="scroll-thin -mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0"
    >
      <div className="isolate inline-flex items-center gap-0.5 rounded-xl bg-fg/[0.045] p-1">
        {option("all", t("common.all"), total)}
        <span aria-hidden className="mx-1 h-4 w-px bg-fg/[0.1]" />
        {stage("Stage1")}
        <ChevronRight aria-hidden className="size-3.5 shrink-0 text-fg/25" />
        {stage("Stage2")}
        <ChevronRight aria-hidden className="size-3.5 shrink-0 text-fg/25" />
        {stage("Stage3")}
        <span aria-hidden className="mx-1 h-4 w-px bg-fg/[0.1]" />
        {option(
          "Dissolved",
          t("stages.Dissolved.short"),
          c.Dissolved,
          <CornerDownRight aria-hidden className="size-3.5 text-fg-3" />,
        )}
      </div>
    </div>
  );
}
