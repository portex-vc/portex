"use client";

import { Badge } from "@/components/ui/badge";
import { useNumbers } from "@/lib/use-numbers";
import { cn } from "@/lib/utils";
import { useTranslations } from "next-intl";

export function RiskChip({ riskScoreBps, vetoActive }: { riskScoreBps: number | null; vetoActive: boolean }) {
  const t = useTranslations("common");
  const n = useNumbers();
  const soft = "shrink-0 whitespace-nowrap rounded-full px-2 text-2xs";
  if (vetoActive) return <Badge className={cn(soft, "bg-negative/10 text-negative")}>{t("vetoActive")}</Badge>;
  if (riskScoreBps === null) return <Badge className={cn(soft, "bg-surface-2 text-fg-3")}>{t("notAnalysed")}</Badge>;
  const tone =
    riskScoreBps < 2500
      ? "bg-positive/10 text-positive"
      : riskScoreBps < 5000
        ? "bg-surface-3 text-fg-2"
        : riskScoreBps < 7500
          ? "bg-risk/10 text-risk"
          : "bg-negative/10 text-negative";
  return <Badge className={cn(soft, tone)}>{t("riskValue", { value: n.pct(riskScoreBps) })}</Badge>;
}
