"use client";

import { useTranslations } from "next-intl";
import { useId } from "react";
import styles from "./mechanism-visual.module.css";

/**
 * One backer's position, in the brand's line language (DESIGN_V2 §6). Illustrative, not data.
 *
 * - The backer buys in partway through Stage 1 (marked). Their cost is the protected line (teal): flat from the
 *   buy-in until listing.
 * - Market value (solid) follows the price of their tokens: the rising Stage 1 curve (earlier backers paid less,
 *   later ones pay more), the steeper dampened Stage 2 path
 *   converging on the market price, then the open market (hatched on the mark's slant: open-market risk).
 * - Exit value (dashed) is what they could actually take out. Through Stage 1 it equals the protected line (exit
 *   at cost, whatever the price does). In Stage 2 it lifts off gradually (the protected exit releases profit in
 *   proportion to elapsed time) and meets market value at listing.
 */
const W = 560;
const H = 300;
const B1 = 168; // Stage 1 → Stage 2
const B2 = 392; // Stage 2 → Stage 3
const BUY = 56; // the backer's buy-in, a third of the way through Stage 1
const S1_START = 262; // the first backer's price: the curve's lowest point
const S1_END = 222; // Stage 1 curve at its deadline
const MARKET = 116; // price the Stage 2 book converges on: steeper than Stage 1, not a cliff

type Pt = [number, number];

// Stage 1: the price rises with every deposit, so earlier backers paid less and later ones pay more.
const stage1 = (x: number) => S1_START - (S1_START - S1_END) * (0.8 * (x / B1) + 0.2 * (x / B1) ** 2);
const COST = stage1(BUY); // price at the buy-in = the protected level
// Stage 2 book price: a gentle S from the Stage 1 slope to the open market's trend; exactly the market at listing.
const book = (t: number) => S1_END + (MARKET - S1_END) * (t - (0.3 * Math.sin(2 * Math.PI * t)) / (2 * Math.PI));
// Protected exit in Stage 2 (PS §3, λ = t): cost plus the elapsed share of the gain, so the gap to market value
// closes in proportion to time and vanishes at listing.
const exitAt = (t: number) => COST + t * (book(t) - COST);

const sample = (from: number, to: number, f: (x: number) => number, n = 24): Pt[] =>
  Array.from({ length: n + 1 }, (_, i) => {
    const x = from + ((to - from) * i) / n;
    return [x, f(x)];
  });

/**
 * Catmull-Rom through the points as cubic Béziers, rounded so server and client render identically. Returns one
 * path per `[from, to)` point-index range, so a single curve can be styled in pieces without a corner at the seams.
 */
function smooth(points: Pt[], cuts: number[] = []): string[] {
  const r = (v: number) => Math.round(v * 10) / 10;
  const bounds = [0, ...cuts, points.length - 1];
  return bounds.slice(0, -1).map((from, k) => {
    let d = `M${r(points[from][0])} ${r(points[from][1])}`;
    for (let i = from; i < bounds[k + 1]; i++) {
      const p0 = points[i - 1] ?? points[i];
      const p1 = points[i];
      const p2 = points[i + 1];
      const p3 = points[i + 2] ?? p2;
      const c1: Pt = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
      const c2: Pt = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
      d += ` C${r(c1[0])} ${r(c1[1])}, ${r(c2[0])} ${r(c2[1])}, ${r(p2[0])} ${r(p2[1])}`;
    }
    return d;
  });
}

const stage2 = (x: number) => (x - B1) / (B2 - B1);
// Stage 3: the open market swings both ways around a rising trend.
const trend = (x: number) => MARKET - 58 * ((x - B2) / (W - B2));
const swings = [-9, 16, -22, 13, -21, 8, -15, 0];
const OPEN: Pt[] = swings.map((dy, i) => {
  const x = B2 + ((W - B2) * (i + 1)) / swings.length;
  return [x, trend(x) + dy];
});
const TAIL = OPEN[OPEN.length - 1];
// One curve from the first backer to the open market, cut where its styling changes.
const LINE: Pt[] = [...sample(0, B1, stage1, 12), ...sample(B1, B2, (x) => book(stage2(x))).slice(1), ...OPEN];
const [VALUE, MARKET_PATH] = smooth(LINE, [LINE.length - OPEN.length - 1]);
// Exit value: the protected line through Stage 1, lifting off in Stage 2; from listing on it is the price itself,
// so Stage 3 reuses the price path exactly and the two lines overlap.
const [EXIT_PROTECTED] = smooth([[BUY, COST], [B1, COST], ...sample(B1, B2, (x) => exitAt(stage2(x)), 16).slice(1)]);
const EXIT = `${EXIT_PROTECTED} ${MARKET_PATH}`;

export function MechanismVisual() {
  const t = useTranslations();
  const id = useId().replace(/:/g, "");
  const stages = [
    ["Stage1", B1],
    ["Stage2", B2 - B1],
    ["Stage3", W - B2],
  ] as const;
  return (
    <figure
      role="img"
      aria-label={t("home.visual.caption")}
      className="flex flex-col gap-4"
      data-testid="mechanism-visual"
    >
      <div aria-hidden className="grid" style={{ gridTemplateColumns: stages.map(([, w]) => `${w}fr`).join(" ") }}>
        {stages.map(([stage], i) => (
          <div key={stage} className={i ? "border-l border-fg/[0.08] pl-3" : "pr-3"}>
            <p className="num text-[0.6875rem] font-medium text-fg-2">{t(`stages.${stage}.short`)}</p>
            <p className="truncate text-[0.6875rem] text-fg-3">{t(`stages.${stage}.name`)}</p>
          </div>
        ))}
      </div>
      <div aria-hidden className="relative">
        <svg viewBox={`0 0 ${W} ${H}`} className="block h-auto w-full overflow-visible">
          <defs>
            {/* the mark's slant (~24°) as a hatch: open-market risk */}
            <pattern
              id={`${id}-hatch`}
              width="7"
              height="7"
              patternUnits="userSpaceOnUse"
              patternTransform="rotate(-66)"
            >
              <line x1="0" y1="0" x2="0" y2="7" className="stroke-fg/[0.07]" strokeWidth="1.2" />
            </pattern>
            <linearGradient id={`${id}-floor`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" className={styles.floorTop} />
              <stop offset="100%" className={styles.floorBottom} />
            </linearGradient>
            <clipPath id={`${id}-reveal`}>
              <rect x={-6} y={-20} width={W + 12} height={H + 40} className={styles.sweep} />
            </clipPath>
          </defs>

          {/* the frame: stage boundaries and baseline */}
          {[B1, B2].map((x) => (
            <line key={x} x1={x} x2={x} y1={0} y2={H} className="stroke-fg/[0.08]" strokeWidth={1} />
          ))}
          <line x1={0} x2={W} y1={H - 0.5} y2={H - 0.5} className="stroke-fg/[0.08]" strokeWidth={1} />

          {/* Everything that happens over time is revealed by one left-to-right sweep, which stops at the
              buy-in and at listing: nothing exists to the right of the moment being drawn. */}
          <g clipPath={`url(#${id}-reveal)`}>
            <rect x={B2} y={0} width={W - B2} height={H} fill={`url(#${id}-hatch)`} />
            {/* protected: this backer's cost, from the buy-in until listing */}
            <rect x={BUY} y={COST} width={B2 - BUY} height={H - COST - 1} fill={`url(#${id}-floor)`} />
            <line
              x1={BUY}
              x2={B2}
              y1={COST}
              y2={COST}
              className={`stroke-protected ${styles.glow}`}
              strokeWidth={2.25}
            />
            {/* the price, from the first backer on; from the buy-in it is the market value of this backer's tokens */}
            <path d={VALUE} fill="none" className="stroke-fg" strokeWidth={1.75} strokeLinejoin="round" />
            <path d={MARKET_PATH} fill="none" className="stroke-fg" strokeWidth={1.75} strokeLinejoin="round" />
            {/* what this backer can exit with */}
            <path
              d={EXIT}
              fill="none"
              className="stroke-info"
              strokeWidth={1.6}
              strokeDasharray="4 4"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </g>
          <circle cx={B2} cy={COST} r={4} className={`fill-bg stroke-protected ${styles.popListing}`} strokeWidth={2} />
          <circle cx={B2} cy={MARKET} r={3} className={`fill-fg ${styles.popListing}`} />
          <circle cx={TAIL[0]} cy={TAIL[1]} r={3} className={`fill-fg ${styles.popTail}`} />

          {/* the buy-in */}
          <circle cx={BUY} cy={COST} r={4.5} className={`fill-bg stroke-fg ${styles.popBuy}`} strokeWidth={2} />
        </svg>
        <span
          className={`pointer-events-none absolute -translate-x-1/2 -translate-y-full whitespace-nowrap pb-2 text-[0.6875rem] font-medium text-fg ${styles.fadeLabel}`}
          style={{ left: `${(BUY / W) * 100}%`, top: `${(COST / H) * 100}%` }}
          data-testid="mechanism-buy-in"
        >
          {t("home.visual.buyIn")}
        </span>
      </div>
      <figcaption aria-hidden className="flex flex-wrap items-center gap-x-5 gap-y-1.5 text-[0.6875rem] text-fg-3">
        <span className="inline-flex items-center gap-2">
          <span className="h-[2px] w-4 rounded-full bg-protected" />
          {t("home.visual.protected")}
        </span>
        <span className="inline-flex items-center gap-2">
          <span className="h-[2px] w-4 rounded-full bg-fg" />
          {t("home.visual.value")}
        </span>
        <span className="inline-flex items-center gap-2">
          <svg width="16" height="2" aria-hidden className="overflow-visible">
            <line x1="0" x2="16" y1="1" y2="1" className="stroke-info" strokeWidth={1.6} strokeDasharray="4 4" />
          </svg>
          {t("home.visual.exit")}
        </span>
      </figcaption>
    </figure>
  );
}
