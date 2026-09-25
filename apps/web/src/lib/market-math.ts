/** Pure secondary-market arithmetic: chart bars, default interval, slippage and price impact. No I/O. */

export const INTERVALS = ["1m", "5m", "15m", "1h", "4h", "1d"] as const;
export type Interval = (typeof INTERVALS)[number];
export const INTERVAL_SECONDS: Record<Interval, number> = {
  "1m": 60,
  "5m": 300,
  "15m": 900,
  "1h": 3600,
  "4h": 14400,
  "1d": 86400,
};
/** The pool fee of every Portex listing (1%), in basis points. */
export const POOL_FEE_BPS = 100;

export interface Candle {
  time: number;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
  trades: number;
  venue: "stage2" | "pool";
}

// ------------------------------------------------------------------------------------------ chart data

export interface Bar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  venue: Candle["venue"];
  /** Carried forward over an empty bucket: no trades. */
  filled: boolean;
}

/**
 * The API omits empty buckets; carry the previous close forward so time is continuous, up to `now`.
 * Only the most recent `cap` buckets are filled, so a fine interval over a long history stays bounded.
 */
export function fillCandles(candles: Candle[], seconds: number, now?: number, cap = 1500): Bar[] {
  const bars: Bar[] = candles.map((c) => ({
    time: c.time,
    open: Number(c.open),
    high: Number(c.high),
    low: Number(c.low),
    close: Number(c.close),
    volume: Number(c.volume),
    venue: c.venue,
    filled: false,
  }));
  if (!bars.length) return bars;
  const end = Math.max(bars.at(-1)!.time, now === undefined ? 0 : Math.floor(now / seconds) * seconds);
  const floor = end - cap * seconds;
  const out: Bar[] = [];
  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    out.push(bar);
    const next = i + 1 < bars.length ? bars[i + 1].time : end + seconds;
    // A listing bucket may carry a Stage 2 and a pool candle at the same time; fill after the later one only.
    for (let t = Math.max(bar.time + seconds, floor); t < next; t += seconds) {
      out.push({
        time: t,
        open: bar.close,
        high: bar.close,
        low: bar.close,
        close: bar.close,
        volume: 0,
        venue: bar.venue,
        filled: true,
      });
    }
  }
  return out;
}

/** The finest interval that shows the whole history in a readable number of bars. */
export function defaultInterval(firstTime: number | null | undefined, now: number): Interval {
  if (!firstTime || !now) return "1h";
  const span = now - firstTime;
  return span > 30 * 86400 ? "1d" : span > 6 * 86400 ? "4h" : span > 36 * 3600 ? "1h" : span > 6 * 3600 ? "15m" : "5m";
}

// ------------------------------------------------------------------------------------------ swap arithmetic

/** Decimal string (USDG per token) to a 1e18-scaled integer, without floating point. */
export function scaled(value: string, decimals = 18): bigint {
  const match = /^(-?)(\d*)(?:\.(\d*))?$/.exec(value.trim());
  if (!match) return 0n;
  const [, sign, whole, fraction = ""] = match;
  const units =
    BigInt(whole || "0") * 10n ** BigInt(decimals) +
    BigInt((fraction + "0".repeat(decimals)).slice(0, decimals) || "0");
  return sign ? -units : units;
}

/** Slippage in percent ("1", "0.5") to basis points; 0.01%–5% with at most two decimals. */
export function parseSlippage(percent: string): number | null {
  if (!/^\d+(\.\d{1,2})?$/.test(percent.trim())) return null;
  const bps = Math.round(Number(percent) * 100);
  return bps >= 1 && bps <= 500 ? bps : null;
}

/** Minimum output under the slippage bound, floored. */
export function minimumReceived(quote: bigint, slippageBps: number): bigint {
  return (quote * BigInt(10000 - slippageBps)) / 10000n;
}

/**
 * Price impact of a quote in basis points, excluding the 1% pool fee: how much less the trade returns than the same
 * amount would at the current pool price. `priceE18` is USDG per whole token, 1e18-scaled.
 */
export function priceImpactBps(buy: boolean, amountIn: bigint, amountOut: bigint, priceE18: bigint): number | null {
  if (amountIn <= 0n || amountOut <= 0n || priceE18 <= 0n) return null;
  const afterFee = (amountIn * BigInt(10000 - POOL_FEE_BPS)) / 10000n;
  // Buy: USDG (6 dp) in, tokens (18 dp) out. Sell: tokens in, USDG out.
  const ideal = buy ? (afterFee * 10n ** 30n) / priceE18 : (afterFee * priceE18) / 10n ** 30n;
  if (ideal <= 0n) return null;
  const impact = Number(((ideal - amountOut) * 10000n) / ideal);
  return Math.max(0, impact);
}

/** Average execution price of a quote, 1e18-scaled USDG per token. */
export function executionPrice(buy: boolean, amountIn: bigint, amountOut: bigint): bigint {
  const [quote, tokens] = buy ? [amountIn, amountOut] : [amountOut, amountIn];
  return tokens > 0n ? (quote * 10n ** 30n) / tokens : 0n;
}
