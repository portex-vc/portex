"use client";

import { cn } from "@/lib/utils";
import { animate, useReducedMotion } from "motion/react";
import { useEffect, useRef, useState } from "react";

/**
 * Animates between numeric values (tween on the number itself, not the glyphs) and briefly
 * tints gains/losses only when explicitly requested. Counts have no directional colour.
 * `format` receives the interpolated value; keep the same decimals as the resting value.
 */
export function NumberTicker({
  value,
  format,
  className,
  duration = 0.6,
  colorChange = false,
}: {
  value: number;
  format: (n: number) => string;
  className?: string;
  duration?: number;
  colorChange?: boolean;
}) {
  const reduce = useReducedMotion();
  const [display, setDisplay] = useState(value);
  const [flash, setFlash] = useState<"up" | "down" | null>(null);
  const prev = useRef(value);

  useEffect(() => {
    const from = prev.current;
    prev.current = value;
    if (from === value) return;
    if (reduce) {
      setDisplay(value);
      return;
    }
    if (colorChange) setFlash(value > from ? "up" : "down");
    const controls = animate(from, value, {
      duration,
      ease: [0.2, 0.8, 0.2, 1],
      onUpdate: (v) => setDisplay(v),
      onComplete: () => setDisplay(value),
    });
    const t = setTimeout(() => setFlash(null), 900);
    return () => {
      controls.stop();
      clearTimeout(t);
    };
  }, [value, duration, reduce, colorChange]);

  return (
    <span
      className={cn("num ticker", flash === "up" && "text-positive", flash === "down" && "text-negative", className)}
    >
      {format(display)}
    </span>
  );
}
