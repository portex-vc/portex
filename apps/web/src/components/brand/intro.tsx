"use client";

import { useEffect } from "react";
import { DrawnLogo } from "./logo";
import styles from "./intro.module.css";

/**
 * First-visit intro (DESIGN_V2 §4): the mark draws itself, the letters rise, and the page settles
 * in. Once per session; skipped under reduced motion and in automated browsers. The decision is
 * made by INTRO_SCRIPT (intro-script.ts) before first paint, so the page never flashes before the overlay.
 */

export function Intro() {
  useEffect(() => {
    const root = document.documentElement;
    if (root.getAttribute("data-intro") !== "play") return;
    const done = () => root.setAttribute("data-intro", "done");
    const timer = window.setTimeout(done, 2200);
    window.addEventListener("pointerdown", done, { once: true });
    window.addEventListener("keydown", done, { once: true });
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("pointerdown", done);
      window.removeEventListener("keydown", done);
    };
  }, []);
  return (
    <div className={styles.intro} aria-hidden="true">
      <DrawnLogo size={60} delay={150} />
    </div>
  );
}
