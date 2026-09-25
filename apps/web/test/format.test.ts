import { describe, expect, test } from "bun:test";
import {
  formatAmount,
  formatApiPrice,
  formatBps,
  formatDuration,
  formatFactor,
  formatOnchainPrice,
  formatQuote,
  formatToken,
  isValidAmountInput,
  parseQuote,
  parseToken,
} from "../src/lib/format";

describe("formatAmount", () => {
  test("groups thousands and trims trailing zeros", () => {
    expect(formatAmount("12345678000000000000000", 18, 4)).toBe("12,345.678");
    expect(formatAmount("1000000", 6, 2)).toBe("1");
  });
  test("handles zero and nullish", () => {
    expect(formatAmount("0", 6)).toBe("0");
    expect(formatAmount(undefined, 6)).toBe("—");
    expect(formatAmount(null, 6)).toBe("—");
  });
  test("respects maxDecimals without rounding up", () => {
    expect(formatAmount("1999999", 6, 2)).toBe("1.99");
    expect(formatAmount("1234", 6, 6)).toBe("0.001234");
  });
});

describe("quote and token formatting", () => {
  test("quote uses 6 decimals", () => {
    expect(formatQuote("50000000000")).toBe("50,000");
    expect(formatQuote("1234567")).toBe("1.23");
  });
  test("token uses 18 decimals", () => {
    expect(formatToken("2500000000000000000")).toBe("2.5");
    expect(formatToken("1")).toBe("0");
  });
});

describe("price formatting", () => {
  test("on-chain bookPrice is quote-units per whole token", () => {
    // 1.0 USDG per token for a 6-decimal quote renders as 1_000_000.
    expect(formatOnchainPrice("1000000")).toBe("1");
    expect(formatOnchainPrice("2500000")).toBe("2.5");
  });
  test("API prices are 1e18-scaled human amounts", () => {
    expect(formatApiPrice("1000000000000000000")).toBe("1");
    expect(formatApiPrice("2250000000000000000", 2)).toBe("2.25");
  });
});

describe("bps and factors", () => {
  test("bps to percent", () => {
    expect(formatBps(3000)).toBe("30%");
    expect(formatBps(5050)).toBe("50.5%");
    expect(formatBps(null)).toBe("—");
  });
  test("1e18-scaled factor", () => {
    expect(formatFactor("1000000000000000000")).toBe("1×");
    expect(formatFactor("1420000000000000000")).toBe("1.42×");
    expect(formatFactor("2000000000000000000")).toBe("2×");
  });
});

describe("parsing", () => {
  test("parseQuote/parseToken round-trip", () => {
    expect(parseQuote("50000")).toBe(50_000_000_000n);
    expect(parseToken("1.5")).toBe(1_500_000_000_000_000_000n);
  });
  test("empty input parses to zero", () => {
    expect(parseQuote("")).toBe(0n);
    expect(parseQuote(".")).toBe(0n);
  });
  test("commas are ignored", () => {
    expect(parseQuote("50,000")).toBe(50_000_000_000n);
  });
  test("input validation", () => {
    expect(isValidAmountInput("12.5")).toBe(true);
    expect(isValidAmountInput("abc")).toBe(false);
    expect(isValidAmountInput("1.2.3")).toBe(false);
    expect(isValidAmountInput("")).toBe(true);
  });
});

describe("durations", () => {
  test("compact formatting", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(45)).toBe("45s");
    expect(formatDuration(125)).toBe("2m 5s");
    expect(formatDuration(3 * 3600 + 12 * 60)).toBe("3h 12m");
    expect(formatDuration(2 * 86400 + 4 * 3600)).toBe("2d 4h");
    expect(formatDuration(-5)).toBe("0s");
  });
});
