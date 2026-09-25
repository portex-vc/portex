import { describe, expect, test } from "bun:test";
import { displayStage, isLive, stageCounts } from "../src/lib/stages";
import { depositQuote, curveCost, minimumOutput, parseTolerance, quoteDeadline } from "../src/lib/quotes";
import { DEFAULT_FORM, validateCreation, creationConfig, priceOf, type FormState } from "../src/lib/create-form";
import { parseUnits } from "viem";
import type { ApiConfig } from "../src/lib/api";
const e18 = 10n ** 18n;
describe("v3.1 effective phases", () => {
  test("pending listing is display Stage 2 and live", () => {
    expect(displayStage("ListingPending")).toBe("Stage2");
    expect(isLive("ListingPending")).toBe(true);
    expect(isLive("Stage3")).toBe(false);
    expect(isLive("Dissolved")).toBe(false);
  });
  test("five effective phases become three stages and one failure outcome", () => {
    expect(stageCounts({ Stage1: 2, Stage2: 3, ListingPending: 4, Stage3: 5, Dissolved: 6 })).toEqual({
      Stage1: 2,
      Stage2: 7,
      Stage3: 5,
      Dissolved: 6,
    });
    expect(displayStage("Dissolved")).toBe("Dissolved");
  });
});
describe("quotes and transaction protections", () => {
  test("full sale at the valuation floor has exact rational cost", () => {
    expect(curveCost(e18 / 10n, 200000n * e18, 0n, 200000n * e18)).toBe(16666666667n);
  });
  test("purchase is maximal at native quote precision and returns change at the cap", () => {
    for (const amount of [1n, 1000000n, 9999999999n, 100000000000n]) {
      const q = depositQuote(e18 / 10n, 200000n * e18, 15000n * e18, amount);
      expect(q.debit).toBeLessThanOrEqual(amount);
      if (q.tokens < 185000n * e18)
        expect(curveCost(e18 / 10n, 200000n * e18, 15000n * e18, q.tokens + 1n)).toBeGreaterThan(amount);
      expect(q.debit + q.change).toBe(amount);
    }
  });
  test("rounds minima down without floating point loss", () => {
    expect(minimumOutput(101n, 50)).toBe(100n);
    expect(minimumOutput(10n ** 29n, 100)).toBe(99n * 10n ** 27n);
    expect(minimumOutput(17n, 0)).toBe(17n);
    expect(() => minimumOutput(1n, 101)).toThrow();
    expect(() => minimumOutput(1n, -1)).toThrow();
    expect(() => minimumOutput(1n, 0.5)).toThrow();
  });
  test("invalid tolerances and chain-clock expiration", () => {
    expect(parseTolerance("0.5")).toBe(50);
    expect(parseTolerance("0.01")).toBe(1);
    for (const x of ["NaN", "-1", "1.01", "", "0.001", "1e-2"]) expect(parseTolerance(x)).toBeNull();
    expect(quoteDeadline(1800000000)).toBe(1800000600n);
  });
});
const valid: FormState = {
  ...DEFAULT_FORM,
  name: "Test",
  symbol: "TST",
};
describe("factory validation", () => {
  test("demo schedule uses registry bounds and converts hours to exact seconds", () => {
    const apiConfig = {
      stageBounds: { stage1Min: 3600, stage1Max: 172800, stage2Min: 7200, stage2Max: 259200 },
      templates: [],
    } as unknown as ApiConfig;
    const demo = { ...valid, stage1Days: "1", stage2Weeks: "2" };
    expect(validateCreation(demo, apiConfig)).toEqual([]);
    const config = creationConfig(demo, "0x0000000000000000000000000000000000000001", apiConfig);
    expect(config.stage1Length).toBe(3600n);
    expect(config.stage2Length).toBe(7200n);
    expect(validateCreation({ ...demo, stage1Days: "48", stage2Weeks: "72" }, apiConfig)).toEqual([]);
    for (const patch of [
      { stage1Days: "0.9" },
      { stage1Days: "48.1" },
      { stage2Weeks: "1.9" },
      { stage2Weeks: "72.1" },
    ])
      expect(validateCreation({ ...demo, ...patch }, apiConfig).some((error) => error.step === 3)).toBe(true);
  });
  test("default parameters match the v3.1 factory shape", () => {
    expect(validateCreation(valid)).toEqual([]);
    const config = creationConfig(valid, "0x0000000000000000000000000000000000000001");
    expect(config.supply).toBe(parseUnits("1000000", 18));
    expect(config.targetPrice).toBe(e18 / 10n);
    expect(config.stage1Length).toBe(30n * 86400n);
    expect(config.stage2Length).toBe(49n * 86400n);
    expect(Object.keys(config).sort()).toEqual(
      [
        "quote",
        "treasury",
        "supply",
        "targetPrice",
        "budgetCeiling",
        "stage1Length",
        "stage2Length",
        "builders",
      ].sort(),
    );
  });
  test("enforces valuation floor, exact supply units and bounded schedules", () => {
    for (const patch of [
      { targetValuation: "99999.999" },
      { supply: "0.000000000000000051" },
      { supply: "1000000000001" },
      { stage1Days: "14" },
      { stage1Days: "61" },
      { stage2Weeks: "4.9" },
      { stage2Weeks: "10.1" },
      { targetMode: "price", targetPrice: "0" },
    ] as Partial<FormState>[])
      expect(validateCreation({ ...valid, ...patch }).length).toBeGreaterThan(0);
    for (const days of ["15", "60"]) expect(validateCreation({ ...valid, stage1Days: days })).toEqual([]);
    for (const weeks of ["5", "10"]) expect(validateCreation({ ...valid, stage2Weeks: weeks })).toEqual([]);
  });
  test("valuation conversion rounds up to preserve the floor", () => {
    const f = { ...valid, supply: "999999" };
    expect((priceOf(f) * parseUnits(f.supply, 18)) / e18).toBeGreaterThanOrEqual(100000n * e18);
  });
  test("builder restrictions and budget bound; the treasury is always created by the protocol", () => {
    expect(creationConfig(valid, "0x0000000000000000000000000000000000000001").treasury).toBe(
      "0x0000000000000000000000000000000000000000",
    );
    expect(validateCreation({ ...valid, builders: "0x0000000000000000000000000000000000000000" })).not.toEqual([]);
    expect(
      validateCreation({ ...valid, builders: Array(33).fill("0x0000000000000000000000000000000000000001").join(",") }),
    ).not.toEqual([]);
    expect(validateCreation({ ...valid, templateName: "BUDGET_LAUNCH", budgetCeiling: "30.01" })).not.toEqual([]);
    expect(validateCreation({ ...valid, templateName: "BUDGET_LAUNCH", budgetCeiling: "30" })).toEqual([]);
  });
});
