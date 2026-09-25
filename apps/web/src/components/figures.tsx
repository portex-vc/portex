"use client";

import { cn } from "@/lib/utils";
import { ChevronDown } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import * as React from "react";

/**
 * Shared figure primitives for the rail, drawer and tabs, so every quote, breakdown and meter
 * uses the same eyebrow labels, tabular figures and spacing.
 */

/** "total" rows are the result (emphasised, top hairline); "meta" rows are small technical references. */
export type RowTone = "total" | "meta" | "protected" | "risk";
export type Row = [label: string, value: string, tone?: RowTone];

export function QuoteTable({
  rows,
  className,
  testId,
  empty,
}: {
  rows: Row[];
  className?: string;
  testId?: string;
  empty?: React.ReactNode;
}) {
  const main = rows.filter(([, , tone]) => tone !== "meta");
  const meta = rows.filter(([, , tone]) => tone === "meta");
  return (
    <dl className={cn("text-xs", className)} data-testid={testId}>
      {!rows.length && empty ? <div className="text-fg-3">{empty}</div> : null}
      {main.map(([label, value, tone], i) => (
        <div
          key={`${label}-${i}`}
          className={cn(
            "flex items-baseline justify-between gap-4 py-1.5",
            tone === "total" && "mt-1 border-t border-hairline pt-2.5",
          )}
        >
          <dt className={cn("min-w-0", tone === "total" ? "font-medium text-fg" : "text-fg-2")}>{label}</dt>
          <dd
            className={cn(
              "num shrink-0 text-right",
              tone === "total" && "text-sm font-medium text-fg",
              tone === "protected" && "text-protected",
              tone === "risk" && "text-risk",
            )}
          >
            {value}
          </dd>
        </div>
      ))}
      {meta.length ? (
        <div className="mt-2 space-y-1 border-t border-dashed border-hairline pt-2 text-2xs text-fg-3">
          {meta.map(([label, value], i) => (
            <div key={`${label}-${i}`} className="flex items-baseline justify-between gap-4">
              <dt>{label}</dt>
              <dd className="num text-right">{value}</dd>
            </div>
          ))}
        </div>
      ) : null}
    </dl>
  );
}

/** Eyebrow label over a figure with a quiet unit. */
export function Fig({
  label,
  value,
  unit,
  tone,
  size = "md",
  className,
}: {
  label: React.ReactNode;
  value: React.ReactNode;
  unit?: string;
  tone?: "protected" | "risk" | "negative" | "positive";
  size?: "sm" | "md" | "lg";
  className?: string;
}) {
  return (
    <div className={cn("min-w-0", className)}>
      <dt className="eyebrow">{label}</dt>
      <dd
        className={cn(
          "num mt-1 font-medium tracking-tight",
          size === "lg" ? "text-2xl" : size === "md" ? "text-base" : "text-sm",
          tone === "protected" && "text-protected",
          tone === "risk" && "text-risk",
          tone === "negative" && "text-negative",
          tone === "positive" && "text-positive",
        )}
      >
        {value}
        {unit ? <span className="ml-1 text-xs font-normal tracking-normal text-fg-3">{unit}</span> : null}
      </dd>
    </div>
  );
}

/** Native select (keeps keyboard and form semantics) styled like the inputs. */
export const NativeSelect = React.forwardRef<HTMLSelectElement, React.SelectHTMLAttributes<HTMLSelectElement>>(
  ({ className, children, ...props }, ref) => (
    <span className={cn("relative block", className)}>
      <select
        ref={ref}
        {...props}
        className="num h-10 w-full appearance-none rounded-[10px] border border-fg/[0.1] bg-fg/[0.025] pl-3 pr-8 text-sm text-fg transition-colors hover:border-fg/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fg/20"
      >
        {children}
      </select>
      <ChevronDown
        aria-hidden
        className="pointer-events-none absolute right-2.5 top-1/2 size-4 -translate-y-1/2 text-fg-3"
      />
    </span>
  ),
);
NativeSelect.displayName = "NativeSelect";

/** Equal-width segmented control; the selection slides between options (DESIGN_V2 §3). */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
  testId,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
  label: string;
  testId?: (value: T) => string;
}) {
  const reduce = useReducedMotion();
  const group = React.useId();
  return (
    <div role="group" aria-label={label} className="isolate flex gap-0.5 rounded-[11px] bg-fg/[0.05] p-[3px]">
      {options.map((o) => {
        const on = value === o.value;
        return (
          <button
            key={o.value}
            type="button"
            aria-pressed={on}
            data-testid={testId?.(o.value)}
            onClick={() => onChange(o.value)}
            className={cn(
              "relative min-h-8 flex-1 rounded-[8px] px-2 py-1.5 text-[0.8125rem] font-medium transition-colors duration-150",
              on ? "text-fg" : "text-fg-3 hover:text-fg-2",
            )}
          >
            {on ? (
              <motion.span
                layoutId={`seg-${group}`}
                aria-hidden
                className="absolute inset-0 -z-10 rounded-[8px] bg-surface-1 shadow-[0_1px_2px_rgb(0_0_0/0.12)] ring-1 ring-fg/[0.08]"
                transition={reduce ? { duration: 0 } : { type: "spring", stiffness: 520, damping: 42 }}
              />
            ) : null}
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/** Horizontal meter with an optional threshold mark (quorum, approval, cap). */
export function Meter({
  label,
  value,
  caption,
  percent,
  threshold,
  tone = "fg",
  testId,
}: {
  label: string;
  value: string;
  caption?: string;
  /** 0–100 */
  percent: number;
  /** 0–100, drawn as a tick */
  threshold?: number;
  tone?: "fg" | "positive" | "negative" | "protected" | "risk";
  testId?: string;
}) {
  const bar = {
    fg: "bg-fg",
    positive: "bg-positive",
    negative: "bg-negative",
    protected: "bg-protected",
    risk: "bg-risk",
  }[tone];
  return (
    <div className="space-y-2" data-testid={testId}>
      <div className="flex items-baseline justify-between gap-3 text-xs">
        <span className="eyebrow">{label}</span>
        <span className="num text-fg">{value}</span>
      </div>
      <div className="relative h-[5px] rounded-full bg-fg/[0.07]">
        <div
          className={cn("h-full rounded-full transition-[width] duration-700 ease-out", bar)}
          style={{ width: `${Math.max(0, Math.min(percent, 100))}%` }}
        />
        {threshold !== undefined ? (
          <span
            aria-hidden
            className="absolute -top-1 h-3.5 w-px bg-fg-2"
            style={{ left: `${Math.max(0, Math.min(threshold, 100))}%` }}
          />
        ) : null}
      </div>
      {caption ? <p className="text-2xs text-fg-3">{caption}</p> : null}
    </div>
  );
}

/** Section header used inside rail cards and tab panels. */
export function CardHeading({
  eyebrow,
  title,
  aside,
  className,
}: {
  eyebrow?: string;
  title?: React.ReactNode;
  aside?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex items-start justify-between gap-3", className)}>
      <div className="min-w-0 space-y-1">
        {eyebrow ? <p className="eyebrow">{eyebrow}</p> : null}
        {title ? <h3 className="text-sm font-medium text-fg">{title}</h3> : null}
      </div>
      {aside}
    </div>
  );
}
