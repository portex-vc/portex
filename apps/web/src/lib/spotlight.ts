import type { PointerEvent } from "react";

/**
 * Cursor-following spotlight for `.card-interactive` surfaces (DESIGN_V2 §3): writes the pointer
 * position into CSS variables; the gradient itself lives in globals.css.
 */
export function spotlight(event: PointerEvent<HTMLElement>) {
  const el = event.currentTarget;
  const rect = el.getBoundingClientRect();
  el.style.setProperty("--mx", `${event.clientX - rect.left}px`);
  el.style.setProperty("--my", `${event.clientY - rect.top}px`);
}
