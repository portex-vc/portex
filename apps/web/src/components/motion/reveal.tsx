"use client";

import { motion, useReducedMotion, type HTMLMotionProps } from "motion/react";

const EASE = [0.2, 0.8, 0.2, 1] as const;

/** Fade-up on mount; `index` staggers siblings by 30 ms (DESIGN_SPEC §1.5). */
export function Reveal({ index = 0, children, className, ...props }: HTMLMotionProps<"div"> & { index?: number }) {
  const reduce = useReducedMotion();
  return (
    <motion.div
      className={`motion-enter ${className ?? ""}`}
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{
        duration: reduce ? 0 : 0.25,
        ease: EASE,
        delay: reduce ? 0 : Math.min(index, 12) * 0.03,
      }}
      {...props}
    >
      {children}
    </motion.div>
  );
}

/** Cross-fade between panel contents keyed by `id` (tab switches, stage changes). */
export function Crossfade({ id, children }: { id: string; children: React.ReactNode }) {
  const reduce = useReducedMotion();
  return (
    <motion.div
      key={id}
      className="motion-enter"
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: reduce ? 0 : 0.25, ease: EASE }}
    >
      {children}
    </motion.div>
  );
}
