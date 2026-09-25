import { expect, test } from "bun:test";
import {
  currentTemplates,
  isShortened,
  PRODUCTION_TIMINGS,
  testnetTimingsOf,
  toTimings,
} from "../src/lib/testnet-timing";

const DAY = 86_400;
/** TimingProfiles.testnet(): minutes-scale timings on the same contracts. */
const testnet = {
  stage1Min: "600",
  stage1Max: String(60 * DAY),
  stage2Min: "1800",
  stage2Max: String(70 * DAY),
  vetoMax: "600",
  vetoTotal: "1800",
  voting: "600",
  dispute: "600",
  execution: "600",
  treasuryVesting: String(7 * DAY),
};
const production = Object.fromEntries(Object.entries(PRODUCTION_TIMINGS).map(([k, v]) => [k, String(v)]));
const template = (name: string, version: string, parameters: object, deprecated = false) => ({
  name,
  version,
  deprecated,
  parameters,
});

test("shortened means a pinned Stage 1 minimum under one day", () => {
  expect(isShortened(testnet)).toBe(true);
  expect(isShortened(production)).toBe(false);
  expect(isShortened({ stage1Min: DAY - 1 })).toBe(true);
  expect(isShortened({ stage1Min: DAY })).toBe(false);
  // Unknown or malformed timings never show a testnet marker.
  expect(isShortened({})).toBe(false);
  expect(isShortened(null)).toBe(false);
  expect(isShortened({ stage1Min: "" })).toBe(false);
  expect(isShortened({ stage1Min: 0 })).toBe(false);
});

test("deployment detection reads the current, non-deprecated version of each template", () => {
  expect(testnetTimingsOf([template("ESCROW_LAUNCH", "1", production)])).toEqual({ shortened: false, timings: null });
  const live = testnetTimingsOf([template("ESCROW_LAUNCH", "1", production), template("ESCROW_LAUNCH", "2", testnet)]);
  expect(live.shortened).toBe(true);
  expect(live.timings?.stage2Min).toBe(1800);
  // A superseded or deprecated testnet version does not mark a production deployment.
  expect(
    testnetTimingsOf([template("ESCROW_LAUNCH", "1", testnet), template("ESCROW_LAUNCH", "2", production)]).shortened,
  ).toBe(false);
  expect(
    testnetTimingsOf([template("ESCROW_LAUNCH", "1", production), template("ESCROW_LAUNCH", "2", testnet, true)])
      .shortened,
  ).toBe(false);
  expect(testnetTimingsOf(undefined).shortened).toBe(false);
  expect(currentTemplates([template("A", "9", production), template("A", "10", production)])[0].version).toBe("10");
});

test("timings parse from API strings; an older API without the governed timings yields none", () => {
  expect(toTimings(testnet)).toMatchObject({ stage1Min: 600, treasuryVesting: 7 * DAY });
  const { stage1Min: _omit, ...legacy } = testnet;
  expect(toTimings(legacy)).toBeNull();
  expect(PRODUCTION_TIMINGS).toMatchObject({ stage1Min: 15 * DAY, stage2Max: 70 * DAY, treasuryVesting: 1825 * DAY });
});
