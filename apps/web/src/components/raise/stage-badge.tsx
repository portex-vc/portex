"use client";

import type { Phase } from "@/lib/api";
import { displayStage, stageLabel, STAGE_TONE } from "@/lib/stages";
import { cn } from "@/lib/utils";
import { useTranslations } from "next-intl";

/** Narrow table cells may pass `form="short"`; everywhere else the full stage label. */
export function StageBadge({ state, form = "full" }: { state: Phase; form?: "full" | "short" }) {
  const t = useTranslations();
  const stage = displayStage(state);
  const tone = STAGE_TONE[stage];
  return (
    <span
      data-testid="stage-badge"
      className={cn(
        "inline-flex flex-wrap items-center gap-1.5 rounded-full px-2 py-0.5 text-2xs font-medium",
        tone.bg,
        tone.text,
      )}
    >
      <span className={cn("size-1.5 rounded-full", tone.dot)} aria-hidden />
      {stageLabel(t, stage, form)}
      {state === "ListingPending" ? <span className="font-normal"> · {t("v31.listingAvailable")}</span> : null}
    </span>
  );
}
