"use client";

import { usePriceHistory } from "@/lib/hooks";
import { cn } from "@/lib/utils";
import { useId } from "react";

/**
 * The dual track in miniature: the Stage 2 book price against the Stage 1 price (dashed). Pure
 * SVG; renders a quiet placeholder while loading so cards never shift.
 */
export function Sparkline({
  raise,
  baseline,
  className,
  height = 44,
}: {
  raise: string;
  baseline: string;
  className?: string;
  height?: number;
}) {
  const id = useId().replace(/:/g, "");
  const { data } = usePriceHistory(raise);
  const W = 240;
  const H = height;
  const pts = (data ?? [])
    .filter((p) => p.kind === "book" && p.price)
    .map((p) => Number(BigInt(p.price!) / 10n ** 12n) / 1e6);
  const base = Number(BigInt(baseline) / 10n ** 12n) / 1e6;
  if (pts.length < 2 || !base) {
    return <div className={cn("w-full", className)} style={{ aspectRatio: `${W} / ${H}` }} aria-hidden />;
  }
  const series = [base, ...pts];
  const lo = Math.min(...series, base);
  const hi = Math.max(...series, base);
  const pad = (hi - lo) * 0.12 || hi * 0.05;
  const y = (v: number) => H - 3 - ((v - (lo - pad)) / (hi + pad - (lo - pad))) * (H - 6);
  const x = (i: number) => (i / (series.length - 1)) * W;
  const line = series.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(" ");
  const area = `${line} L${W} ${H} L0 ${H} Z`;
  const last = series[series.length - 1];
  const up = last >= base;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className={cn("block h-auto w-full overflow-visible", className)} aria-hidden>
      <defs>
        <linearGradient id={`${id}-a`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="rgb(var(--fg))" stopOpacity={0.08} />
          <stop offset="100%" stopColor="rgb(var(--fg))" stopOpacity={0} />
        </linearGradient>
      </defs>
      <line
        x1={0}
        x2={W}
        y1={y(base)}
        y2={y(base)}
        stroke="rgb(var(--protected))"
        strokeOpacity={0.7}
        strokeWidth={1}
        strokeDasharray="2 3"
      />
      <path d={area} fill={`url(#${id}-a)`} />
      <path
        d={line}
        fill="none"
        stroke="rgb(var(--fg))"
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <circle cx={W} cy={y(last)} r={2.5} fill={up ? "rgb(var(--positive))" : "rgb(var(--negative))"} />
    </svg>
  );
}
