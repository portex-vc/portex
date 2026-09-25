import type { Phase, RaiseSummary } from "./api";
export type DisplayStage = Exclude<Phase, "ListingPending">;
export function displayStage(phase: Phase): DisplayStage {
  return phase === "ListingPending" ? "Stage2" : phase;
}
export function stageLabel(t: (key: string) => string, stage: DisplayStage, form: "full" | "short" = "full"): string {
  if (form === "short") return t(`stages.${stage}.short`);
  return stage === "Dissolved"
    ? t("stages.Dissolved.name")
    : `${t(`stages.${stage}.short`)} · ${t(`stages.${stage}.name`)}`;
}
export function stageCounts(counts: Record<string, number>): Record<DisplayStage, number> {
  return {
    Stage1: counts.Stage1 ?? 0,
    Stage2: (counts.Stage2 ?? 0) + (counts.ListingPending ?? 0),
    Stage3: counts.Stage3 ?? 0,
    Dissolved: counts.Dissolved ?? 0,
  };
}
export const STAGE_TONE: Record<DisplayStage, { text: string; bg: string; ring: string; dot: string }> = {
  Stage1: { text: "text-fg-2", bg: "bg-fg-2/10", ring: "ring-fg-2/30", dot: "bg-fg-2" },
  Stage2: { text: "text-info", bg: "bg-info/10", ring: "ring-info/30", dot: "bg-info" },
  Stage3: { text: "text-positive", bg: "bg-positive/10", ring: "ring-positive/30", dot: "bg-positive" },
  // Dissolution is a normal outcome, not an error: neutral, never red.
  Dissolved: { text: "text-fg-3", bg: "bg-fg/[0.06]", ring: "ring-fg/15", dot: "bg-fg-3" },
};
export function nextTransition(r: RaiseSummary): { at: number | null; kind: "possible" | "none" } {
  const at =
    r.phase === "Stage1"
      ? Math.max(r.deadlines.stage1End, r.deadlines.vetoUntil)
      : displayStage(r.phase) === "Stage2"
        ? r.deadlines.stage2End
        : null;
  return { at, kind: at === null ? "none" : "possible" };
}
export const isLive = (phase: Phase) => phase === "Stage1" || phase === "Stage2" || phase === "ListingPending";
