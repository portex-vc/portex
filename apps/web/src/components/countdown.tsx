"use client";

import { useNow } from "@/lib/hooks";
import { useNumbers } from "@/lib/use-numbers";
import { useTranslations } from "next-intl";

/** Live countdown to a unix timestamp; renders `dueLabel` once reached. */
export function Countdown({
  to,
  dueLabel,
  prefix,
}: {
  to: number | null | undefined;
  dueLabel?: string;
  prefix?: string;
}) {
  const t = useTranslations("common");
  const n = useNumbers();
  const now = useNow();
  if (to === null || to === undefined || to === 0) return <span>—</span>;
  const remaining = Math.floor(to - now);
  if (remaining <= 0) return <span className="text-success">{dueLabel ?? t("dueNow")}</span>;
  return (
    <span className="tabular-nums">
      {prefix}
      {n.duration(remaining)}
    </span>
  );
}
