"use client";

import { cn } from "@/lib/utils";
import { useCallback, useEffect, useRef, useState } from "react";
import styles from "./logo.module.css";

/*
  Portex brand marks.

  The mark is ONE continuous line of constant width with bevelled corners (verified against the
  original artwork: a single stroked polyline reproduces the traced shape, IoU 0.97). Drawing it as a
  stroke instead of a filled outline is what lets the brand move: it can draw itself, a sheen can
  travel along it, and it doubles as the loader. The order of points is the drawing order: the
  crossbar first, the outer bowl closing into the stem last.
*/
export const MARK_POINTS: [number, number][] = [
  [14, 187.5],
  [111, 143.5],
  [111, 77],
  [13, 33.5],
  [13, 275],
  [62, 275],
  [62, 11.5],
  [160, 56],
  [160, 165.5],
  [62, 210],
];
export const MARK_PATH = MARK_POINTS.map(([x, y], i) => `${i ? "L" : "M"}${x} ${y}`).join(" ");
export const MARK_LENGTH = MARK_POINTS.slice(1).reduce(
  (sum, [x, y], i) => sum + Math.hypot(x - MARK_POINTS[i][0], y - MARK_POINTS[i][1]),
  0,
);
export const MARK_STROKE = 19;
const VIEW_W = 174;
const VIEW_H = 289;

/* Wordmark, traced from the original artwork; split per letter so it can be revealed in sequence. */
const LETTERS = [
  // p
  "M10.0 175.5 L3.5 175.0 L3.5 32.0 L5.0 30.5 L20.0 30.5 L23.0 39.5 L33.0 33.5 L47.0 29.5 L62.0 28.5 L74.0 30.5 L86.5 39.0 L91.5 50.0 L92.5 104.0 L90.5 115.0 L83.0 126.5 L68.0 133.5 L47.0 134.5 L24.0 131.5 L23.5 173.0 L10.0 175.5 Z M60.5 118.0 L66.0 116.5 L69.5 113.0 L72.5 105.0 L72.5 56.0 L68.0 47.5 L60.0 44.5 L51.0 44.5 L39.0 47.5 L23.5 57.0 L23.5 115.0 L43.0 118.5 L60.5 118.0 Z",
  // o
  "M168.0 134.5 L145.0 133.5 L131.0 128.5 L120.5 119.0 L114.5 106.0 L113.5 66.0 L116.5 51.0 L127.0 37.5 L146.0 29.5 L164.0 28.5 L184.0 32.5 L196.5 41.0 L204.5 56.0 L205.5 103.0 L203.5 111.0 L197.5 121.0 L190.0 127.5 L182.0 131.5 L168.0 134.5 Z M168.5 118.0 L178.0 114.5 L182.5 110.0 L185.5 103.0 L185.5 60.0 L181.5 52.0 L174.0 46.5 L166.0 44.5 L153.0 44.5 L142.0 48.5 L134.5 58.0 L133.5 101.0 L136.5 109.0 L145.0 116.5 L152.0 118.5 L168.5 118.0 Z",
  // r
  "M251.0 132.5 L231.5 132.0 L231.5 31.0 L248.0 30.5 L249.5 33.0 L249.5 44.0 L251.0 44.5 L261.0 37.5 L281.0 29.5 L283.5 45.0 L251.5 63.0 L251.0 132.5 Z",
  // t
  "M340.0 134.5 L321.0 133.5 L311.0 128.5 L307.5 124.0 L305.5 118.0 L305.5 46.0 L285.5 45.0 L286.0 30.5 L305.5 30.0 L306.0 5.5 L325.5 4.0 L326.0 30.5 L356.5 31.0 L355.0 45.5 L325.5 46.0 L325.5 114.0 L328.0 117.5 L334.0 119.5 L354.0 116.5 L357.5 130.0 L340.0 134.5 Z",
  // e
  "M427.0 134.5 L409.0 134.5 L394.0 131.5 L386.0 127.5 L378.5 120.0 L373.5 109.0 L373.5 55.0 L378.5 44.0 L386.0 36.5 L399.0 30.5 L421.0 28.5 L438.0 31.5 L448.5 38.0 L453.5 43.0 L457.5 51.0 L459.5 60.0 L459.0 88.5 L392.5 89.0 L393.5 108.0 L398.0 114.5 L404.0 117.5 L433.0 118.5 L451.0 114.5 L455.5 116.0 L457.0 128.5 L427.0 134.5 Z M440.5 73.0 L439.5 57.0 L437.5 52.0 L432.0 46.5 L420.0 43.5 L407.0 44.5 L400.0 47.5 L393.5 56.0 L393.0 73.5 L440.5 73.0 Z",
  // x
  "M565.0 132.5 L545.0 132.5 L518.0 95.5 L491.0 132.5 L470.5 132.0 L506.5 82.0 L472.5 34.0 L472.0 30.5 L491.0 30.5 L518.0 67.5 L545.0 30.5 L564.5 31.0 L529.5 82.0 L565.5 131.0 L565.0 132.5 Z",
];

type MarkProps = { className?: string; size?: number; title?: string };

function MarkSvg({ size = 24, title, className, children }: MarkProps & { children: React.ReactNode }) {
  return (
    <svg
      viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
      width={size * (VIEW_W / VIEW_H)}
      height={size}
      fill="none"
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      className={cn("shrink-0 overflow-visible", className)}
    >
      {children}
    </svg>
  );
}

const strokeProps = {
  stroke: "currentColor",
  strokeWidth: MARK_STROKE,
  strokeLinejoin: "bevel" as const,
  strokeLinecap: "butt" as const,
};

/** The static mark. */
export function Mark({ className, size = 24, title = "Portex" }: MarkProps) {
  return (
    <MarkSvg size={size} title={title} className={className}>
      <path d={MARK_PATH} {...strokeProps} />
    </MarkSvg>
  );
}

/**
 * The mark drawing itself as its single line. `play` restarts it; `delay` in ms.
 * Under reduced motion it renders complete.
 */
export function DrawnMark({
  className,
  size = 24,
  title = "Portex",
  duration = 1150,
  delay = 0,
}: MarkProps & { duration?: number; delay?: number }) {
  return (
    <MarkSvg size={size} title={title} className={className}>
      <path
        d={MARK_PATH}
        {...strokeProps}
        className={styles.draw}
        style={
          {
            "--len": MARK_LENGTH,
            "--dur": `${duration}ms`,
            "--delay": `${delay}ms`,
          } as React.CSSProperties
        }
      />
    </MarkSvg>
  );
}

/**
 * Loader: the mark as a faint track with a teal segment running along it. Use for route loading,
 * pending transactions and first data loads.
 */
export function MarkLoader({ className, size = 28, label }: MarkProps & { label?: string }) {
  return (
    <span role="status" aria-live="polite" className={cn("inline-flex flex-col items-center gap-3", className)}>
      <MarkSvg size={size}>
        <path d={MARK_PATH} {...strokeProps} className="text-fg/10" />
        <path
          d={MARK_PATH}
          {...strokeProps}
          className={cn("text-protected", styles.run)}
          style={{ "--len": MARK_LENGTH } as React.CSSProperties}
        />
      </MarkSvg>
      {label ? <span className="text-xs text-fg-3">{label}</span> : <span className="sr-only">Loading</span>}
    </span>
  );
}

function Wordmark({ className, height = 16, reveal }: { className?: string; height?: number; reveal?: number }) {
  return (
    <svg
      viewBox="0 0 570 180"
      width={height * (570 / 180)}
      height={height}
      fill="currentColor"
      fillRule="evenodd"
      aria-hidden="true"
      className={cn("shrink-0 overflow-visible", className)}
    >
      {LETTERS.map((d, i) => (
        <path
          key={i}
          d={d}
          className={reveal !== undefined ? styles.letter : undefined}
          style={reveal !== undefined ? ({ "--i": i, "--delay": `${reveal}ms` } as React.CSSProperties) : undefined}
        />
      ))}
    </svg>
  );
}

/** Mark + wordmark lockup, sized by the mark's height. */
export function Logo({ className, size = 26 }: { className?: string; size?: number }) {
  return (
    <span className={cn("inline-flex items-center gap-[0.22em] text-fg", className)} style={{ fontSize: size }}>
      <Mark size={size} />
      <Wordmark height={size * 0.6} className="translate-y-[0.06em]" />
    </span>
  );
}

/** The lockup drawing itself: the line first, then the letters rise in sequence. */
export function DrawnLogo({ className, size = 56, delay = 0 }: { className?: string; size?: number; delay?: number }) {
  return (
    <span className={cn("inline-flex items-center gap-[0.22em] text-fg", className)} style={{ fontSize: size }}>
      <DrawnMark size={size} delay={delay} />
      <Wordmark height={size * 0.6} className="translate-y-[0.06em]" reveal={delay + 780} />
    </span>
  );
}

/**
 * Header lockup. On hover one short teal segment travels along the mark's line once — a quiet
 * signature that the whole brand is a single continuous line.
 */
export function SheenLogo({ className, size = 22 }: { className?: string; size?: number }) {
  const [run, setRun] = useState(0);
  const busy = useRef(false);
  const start = useCallback(() => {
    if (busy.current) return;
    busy.current = true;
    setRun((r) => r + 1);
  }, []);
  useEffect(() => {
    if (!run) return;
    const id = window.setTimeout(() => (busy.current = false), 950);
    return () => window.clearTimeout(id);
  }, [run]);
  return (
    <span
      className={cn("inline-flex items-center gap-[0.22em] text-fg", className)}
      style={{ fontSize: size }}
      onMouseEnter={start}
      onFocus={start}
    >
      <MarkSvg size={size}>
        <path d={MARK_PATH} {...strokeProps} />
        {run ? (
          <path
            key={run}
            d={MARK_PATH}
            {...strokeProps}
            className={cn("text-protected", styles.sheen)}
            style={{ "--len": MARK_LENGTH } as React.CSSProperties}
          />
        ) : null}
      </MarkSvg>
      <Wordmark height={size * 0.6} className="translate-y-[0.06em]" />
    </span>
  );
}

/** Square monogram for empty states and placeholders. */
export function MarkTile({ className, size = 40 }: { className?: string; size?: number }) {
  return (
    <span
      className={cn("inline-flex items-center justify-center rounded-lg bg-fg text-bg", className)}
      style={{ width: size, height: size }}
    >
      <Mark size={size * 0.56} title="" />
    </span>
  );
}
