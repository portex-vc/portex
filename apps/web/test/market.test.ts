import { describe, expect, test } from "bun:test";
import {
  defaultInterval,
  executionPrice,
  fillCandles,
  minimumReceived,
  parseSlippage,
  priceImpactBps,
  scaled,
  type Candle,
} from "../src/lib/market-math";

const c = (time: number, close: string, venue: Candle["venue"] = "pool", open = close): Candle => ({
  time,
  open,
  high: close,
  low: open,
  close,
  volume: "1",
  trades: 1,
  venue,
});

describe("market chart data", () => {
  test("empty buckets carry the previous close forward, up to now", () => {
    const bars = fillCandles([c(0, "1"), c(180, "2")], 60, 300);
    expect(bars.map((b) => [b.time, b.close, b.filled])).toEqual([
      [0, 1, false],
      [60, 1, true],
      [120, 1, true],
      [180, 2, false],
      [240, 2, true],
      [300, 2, true],
    ]);
    expect(bars[1]).toMatchObject({ open: 1, high: 1, low: 1, volume: 0 });
  });
  test("the listing bucket keeps both venues and fills only after the pool candle", () => {
    const bars = fillCandles([c(0, "1", "stage2"), c(120, "1.5", "stage2"), c(120, "1.6", "pool")], 60, 180);
    expect(bars.map((b) => [b.time, b.venue, b.filled])).toEqual([
      [0, "stage2", false],
      [60, "stage2", true],
      [120, "stage2", false],
      [120, "pool", false],
      [180, "pool", true],
    ]);
  });
  test("filling is bounded to the most recent buckets", () => {
    const bars = fillCandles([c(0, "1"), c(60 * 10_000, "2")], 60, 60 * 10_000, 100);
    expect(bars.length).toBe(2 + 100);
    expect(bars.filter((b) => b.filled).every((b) => b.time >= 60 * 9_900)).toBe(true);
  });
  test("default interval follows the length of the history", () => {
    const now = 100 * 86400;
    expect(defaultInterval(null, now)).toBe("1h");
    expect(defaultInterval(now - 40 * 86400, now)).toBe("1d");
    expect(defaultInterval(now - 10 * 86400, now)).toBe("4h");
    expect(defaultInterval(now - 2 * 86400, now)).toBe("1h");
    expect(defaultInterval(now - 12 * 3600, now)).toBe("15m");
    expect(defaultInterval(now - 3600, now)).toBe("5m");
  });
});

describe("swap arithmetic", () => {
  test("decimal prices scale exactly", () => {
    expect(scaled("0.1")).toBe(10n ** 17n);
    expect(scaled("123.456789", 6)).toBe(123_456_789n);
    expect(scaled("0.000000000000000001")).toBe(1n);
    expect(scaled("2")).toBe(2n * 10n ** 18n);
    expect(scaled("nonsense")).toBe(0n);
  });
  test("slippage is 0.01%–5% with two decimals", () => {
    expect(parseSlippage("1")).toBe(100);
    expect(parseSlippage("0.5")).toBe(50);
    expect(parseSlippage("0.01")).toBe(1);
    expect(parseSlippage("5")).toBe(500);
    expect(parseSlippage("5.01")).toBeNull();
    expect(parseSlippage("0")).toBeNull();
    expect(parseSlippage("0.001")).toBeNull();
    expect(parseSlippage("")).toBeNull();
    expect(parseSlippage("-1")).toBeNull();
  });
  test("minimum received floors under the tolerance", () => {
    expect(minimumReceived(1000n, 100)).toBe(990n);
    expect(minimumReceived(999n, 100)).toBe(989n);
    expect(minimumReceived(0n, 100)).toBe(0n);
  });
  test("price impact excludes the 1% fee, for buys and sells", () => {
    const price = 10n ** 17n; // 0.1 USDG per token
    // 100 USDG buys 990 tokens at the current price after the fee: no impact.
    expect(priceImpactBps(true, 100_000_000n, 990n * 10n ** 18n, price)).toBe(0);
    // Receiving 1% fewer tokens than that is 1% of impact.
    expect(priceImpactBps(true, 100_000_000n, 980_100n * 10n ** 15n, price)).toBe(100);
    // Selling 1000 tokens returns 99 USDG after the fee at 0.1; 94.05 is 5% of impact.
    expect(priceImpactBps(false, 1000n * 10n ** 18n, 94_050_000n, price)).toBe(500);
    expect(priceImpactBps(true, 0n, 1n, price)).toBeNull();
    expect(priceImpactBps(true, 1n, 1n, 0n)).toBeNull();
  });
  test("execution price is USDG per token in both directions", () => {
    expect(executionPrice(true, 50_000_000n, 500n * 10n ** 18n)).toBe(10n ** 17n);
    expect(executionPrice(false, 500n * 10n ** 18n, 50_000_000n)).toBe(10n ** 17n);
    expect(executionPrice(true, 1n, 0n)).toBe(0n);
  });
});
