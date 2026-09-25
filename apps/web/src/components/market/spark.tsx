"use client";

import { cn } from "@/lib/utils";
import { useId } from "react";

/** 30-day price line for the markets list: green when the window closed higher, red when lower. Pure SVG. */
export function Spark({ values, className }: { values: string[]; className?: string }) {
  const id = useId().replace(/:/g, "");
  const W = 112;
  const H = 32;
  const pts = values.map(Number).filter((x) => Number.isFinite(x) && x > 0);
  if (pts.length < 2) return <div className={cn("h-8 w-28", className)} aria-hidden />;
  const lo = Math.min(...pts);
  const hi = Math.max(...pts);
  const pad = (hi - lo) * 0.15 || hi * 0.02;
  const y = (v: number) => H - 3 - ((v - (lo - pad)) / (hi + pad - (lo - pad))) * (H - 6);
  const x = (i: number) => (i / (pts.length - 1)) * (W - 3);
  const line = pts.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(" ");
  const down = pts.at(-1)! < pts[0];
  const tone = down ? "var(--negative)" : "var(--positive)";
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className={cn("block h-8 w-28 overflow-visible", className)} aria-hidden>
      <defs>
        <linearGradient id={`${id}-a`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={`rgb(${tone})`} stopOpacity={0.14} />
          <stop offset="100%" stopColor={`rgb(${tone})`} stopOpacity={0} />
        </linearGradient>
      </defs>
      <path d={`${line} L${x(pts.length - 1)} ${H} L0 ${H} Z`} fill={`url(#${id}-a)`} />
      <path
        d={line}
        fill="none"
        stroke={`rgb(${tone})`}
        strokeWidth={1.25}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <circle cx={x(pts.length - 1)} cy={y(pts.at(-1)!)} r={2} fill={`rgb(${tone})`} />
    </svg>
  );
}
