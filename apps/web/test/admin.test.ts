import { describe, expect, test } from "bun:test";
import {
  bestUnit,
  detectRoles,
  diffParameters,
  formatDurationValue,
  latestVersions,
  maxVetoNow,
  parseDuration,
  parseFixed,
  toParameters,
  validateParameters,
  vetoBlock,
  vetoState,
  type ProtocolParameters,
} from "../src/lib/admin";

const DAY = 86_400n;
const CURATOR = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const ATTESTER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const COUNCIL = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";
const BACKER = "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65";
const OLD_ATTESTER = "0x90F79bf6EB2c4f870365E785982E1f101E93b906";

/** PortexRegistryV31 production defaults (TypesV31.productionParameters). */
const production: ProtocolParameters = {
  kappaMax: 2n * 10n ** 18n,
  budgetCeilingMax: 3n * 10n ** 17n,
  vetoMax: 2n * DAY,
  vetoTotal: 7n * DAY,
  vetoCooldown: 1n * DAY,
  voting: 3n * DAY,
  dispute: 7n * DAY,
  execution: 2n * DAY,
  proposalInterval: 1n * DAY,
  minimumBackers: 10,
  tradeFeeBps: 100,
  surchargeBps: 0,
  stage1Min: 15n * DAY,
  stage1Max: 60n * DAY,
  stage2Min: 35n * DAY,
  stage2Max: 70n * DAY,
  treasuryVesting: 1825n * DAY,
};
const errorsOf = (patch: Partial<ProtocolParameters>) =>
  validateParameters({ ...production, ...patch }).map((e) => `${e.field}:${e.key}`);

describe("role detection", () => {
  const templates = [
    { name: "ESCROW_LAUNCH", version: "1", implementations: { attester: OLD_ATTESTER, council: COUNCIL } },
    { name: "ESCROW_LAUNCH", version: "2", implementations: { attester: ATTESTER, council: COUNCIL } },
    { name: "BUDGET_LAUNCH", version: "1", implementations: { attester: ATTESTER, council: COUNCIL } },
  ];

  test("each local account gets exactly its roles, case-insensitively", () => {
    const base = { curator: CURATOR, templates, admins: [CURATOR.toLowerCase()] };
    expect(detectRoles({ ...base, address: CURATOR.toLowerCase() })).toEqual(["curator", "apiAdmin"]);
    expect(detectRoles({ ...base, address: ATTESTER })).toEqual(["attester"]);
    expect(detectRoles({ ...base, address: COUNCIL })).toEqual(["council"]);
    expect(detectRoles({ ...base, address: BACKER })).toEqual([]);
    expect(detectRoles({ ...base, address: undefined })).toEqual([]);
  });

  test("attester and council come from the latest version, or from a raise's own modules", () => {
    expect(latestVersions(templates).map((t) => `${t.name}@${t.version}`)).toEqual([
      "ESCROW_LAUNCH@2",
      "BUDGET_LAUNCH@1",
    ]);
    // A superseded version's attester is no longer an attester for new raises...
    expect(detectRoles({ address: OLD_ATTESTER, templates })).toEqual([]);
    // ...but still is for a live raise that pinned it.
    expect(
      detectRoles({ address: OLD_ATTESTER, templates, raiseModules: [{ attester: OLD_ATTESTER, council: COUNCIL }] }),
    ).toEqual(["attester"]);
  });

  test("missing reads grant nothing", () => {
    expect(detectRoles({ address: CURATOR })).toEqual([]);
    expect(detectRoles({ address: CURATOR, curator: null, admins: null })).toEqual([]);
  });
});

describe("parameter validator mirrors PortexRegistryV31._validateParameters", () => {
  test("production defaults and the testnet profile are valid", () => {
    expect(validateParameters(production)).toEqual([]);
    const testnet = {
      ...production,
      stage1Min: 600n,
      stage2Min: 1800n,
      vetoMax: 600n,
      vetoTotal: 1800n,
      vetoCooldown: 600n,
      voting: 600n,
      dispute: 600n,
      execution: 600n,
      proposalInterval: 600n,
      treasuryVesting: 7n * DAY,
    };
    expect(validateParameters(testnet)).toEqual([]);
  });

  test("fixed terms", () => {
    expect(errorsOf({ kappaMax: 1499999999999999999n })).toEqual(["kappaMax:kappaMin"]);
    expect(errorsOf({ kappaMax: 15n * 10n ** 17n })).toEqual([]);
    expect(errorsOf({ budgetCeilingMax: 10n ** 18n + 1n })).toEqual(["budgetCeilingMax:budgetMax"]);
    expect(errorsOf({ minimumBackers: 9 })).toEqual(["minimumBackers:fixed"]);
    expect(errorsOf({ tradeFeeBps: 50 })).toEqual(["tradeFeeBps:fixed"]);
    expect(errorsOf({ surchargeBps: 1 })).toEqual(["surchargeBps:fixed"]);
  });

  test("veto timers", () => {
    expect(errorsOf({ vetoMax: 0n })).toEqual(["vetoMax:positive"]);
    expect(errorsOf({ vetoMax: 2n * DAY + 1n })).toEqual(["vetoMax:vetoMaxCap"]);
    expect(errorsOf({ vetoMax: 2n * DAY, vetoTotal: DAY })).toEqual(["vetoTotal:vetoTotalBelowMax"]);
    expect(errorsOf({ vetoTotal: 7n * DAY + 1n })).toEqual(["vetoTotal:vetoTotalCap"]);
    expect(errorsOf({ stage1Max: 5n * DAY, stage1Min: 5n * DAY })).toEqual(["vetoTotal:vetoTotalStage1"]);
    expect(errorsOf({ vetoCooldown: 0n })).toEqual(["vetoCooldown:positive"]);
  });

  test("governance timers must be positive and fit in the shortest Stage 2", () => {
    for (const key of ["voting", "dispute", "execution", "proposalInterval"] as const)
      expect(errorsOf({ [key]: 0n })).toContain(`${key}:positive`);
    // 3 + 7 + 2 = 12 days fits 35; 20 + 10 + 6 = 36 does not.
    expect(errorsOf({ voting: 20n * DAY, dispute: 10n * DAY, execution: 6n * DAY })).toEqual(["voting:governanceFit"]);
    expect(errorsOf({ voting: 20n * DAY, dispute: 10n * DAY, execution: 5n * DAY })).toEqual([]);
  });

  test("stage lengths and treasury schedule", () => {
    expect(errorsOf({ stage1Min: 0n })).toEqual(["stage1Min:positive"]);
    expect(errorsOf({ stage1Min: 61n * DAY })).toEqual(["stage1Min:minAboveMax"]);
    expect(errorsOf({ stage1Max: 366n * DAY })).toEqual(["stage1Max:stageCap"]);
    expect(errorsOf({ stage1Max: 365n * DAY })).toEqual([]);
    expect(errorsOf({ stage2Min: 71n * DAY })).toEqual(["stage2Min:minAboveMax"]);
    expect(errorsOf({ stage2Max: 366n * DAY })).toEqual(["stage2Max:stageCap"]);
    expect(errorsOf({ treasuryVesting: 0n })).toEqual(["treasuryVesting:positive"]);
    expect(errorsOf({ treasuryVesting: 3651n * DAY })).toEqual(["treasuryVesting:vestingCap"]);
    expect(errorsOf({ treasuryVesting: 3650n * DAY })).toEqual([]);
  });

  test("diff lists only changed fields", () => {
    expect(diffParameters(production, { ...production, stage1Max: 30n * DAY, vetoMax: DAY })).toEqual([
      "stage1Max",
      "vetoMax",
    ]);
    expect(diffParameters(production, production)).toEqual([]);
  });

  test("normalizes viem and API shapes; older shapes without timings are unknown", () => {
    const api = Object.fromEntries(Object.entries(production).map(([k, v]) => [k, String(v)]));
    expect(toParameters(api)).toEqual(production);
    const { stage1Min: _omit, ...legacy } = api;
    expect(toParameters(legacy)).toBeNull();
  });
});

describe("human units", () => {
  test("durations round-trip exactly or not at all", () => {
    expect(parseDuration("1.5", "hour")).toBe(5400n);
    expect(parseDuration("10", "minute")).toBe(600n);
    expect(parseDuration("0.1", "minute")).toBe(6n);
    expect(parseDuration("0.01", "minute")).toBeNull();
    expect(parseDuration("-1", "day")).toBeNull();
    expect(parseDuration("abc", "day")).toBeNull();
    expect(bestUnit(2n * DAY)).toBe("day");
    expect(bestUnit(5400n)).toBe("minute");
    expect(bestUnit(7200n)).toBe("hour");
    expect(formatDurationValue(5400n, "hour")).toBe("1.5");
    expect(formatDurationValue(600n, "day")).toBeNull();
    expect(parseFixed("2")).toBe(2n * 10n ** 18n);
    expect(parseFixed("30", 16)).toBe(3n * 10n ** 17n);
  });
});

describe("veto limits mirror RaiseCore.veto", () => {
  const start = 1_000_000;
  const params = { vetoTotal: 7n * DAY, vetoCooldown: DAY, stage1Max: 60n * DAY, start };
  const at = start + Number(10n * DAY);

  test("fresh raise: full budget, no cooldown", () => {
    const state = vetoState({ ...params, events: [], vetoUntil: 0, now: at });
    expect(state).toMatchObject({ used: 0n, remaining: 7n * DAY, cooldownUntil: 0, active: false });
    expect(maxVetoNow({ phase: "Stage1", state, vetoMax: 2n * DAY, now: at })).toBe(2n * DAY);
    expect(vetoBlock({ phase: "Stage1", state, vetoMax: 2n * DAY, delay: DAY, now: at })).toBeNull();
    expect(vetoBlock({ phase: "Stage1", state, vetoMax: 2n * DAY, delay: 0n, now: at })?.key).toBe("zero");
    expect(vetoBlock({ phase: "Stage1", state, vetoMax: 2n * DAY, delay: 3n * DAY, now: at })?.key).toBe("aboveMax");
    expect(vetoBlock({ phase: "Stage2", state, vetoMax: 2n * DAY, delay: DAY, now: at })?.key).toBe("notStage1");
  });

  test("after a veto: budget used, cooldown runs from the veto's end; a clear restarts the cooldown", () => {
    const vetoUntil = at + Number(2n * DAY);
    const events = [{ vetoUntil, cumulativeDelay: 2n * DAY, timestamp: at }];
    const during = vetoState({ ...params, events, vetoUntil, now: at + 60 });
    expect(during).toMatchObject({ used: 2n * DAY, remaining: 5n * DAY, active: true });
    expect(during.cooldownUntil).toBe(vetoUntil + Number(DAY));
    expect(vetoBlock({ phase: "Stage1", state: during, vetoMax: 2n * DAY, delay: DAY, now: at + 60 })?.key).toBe(
      "cooldown",
    );
    const cleared = [...events, { vetoUntil: 0, cumulativeDelay: 2n * DAY, timestamp: at + 3600 }];
    const after = vetoState({ ...params, events: cleared, vetoUntil: 0, now: at + 3601 });
    expect(after).toMatchObject({ used: 2n * DAY, active: false, cooldownUntil: at + 3600 + Number(DAY) });
  });

  test("the cumulative budget and the Stage 1 horizon bound the delay", () => {
    const events = [{ vetoUntil: at - Number(2n * DAY), cumulativeDelay: 6n * DAY, timestamp: at - Number(3n * DAY) }];
    const state = vetoState({ ...params, events, vetoUntil: 0, now: at });
    expect(maxVetoNow({ phase: "Stage1", state, vetoMax: 2n * DAY, now: at })).toBe(DAY);
    expect(vetoBlock({ phase: "Stage1", state, vetoMax: 2n * DAY, delay: 2n * DAY, now: at })).toEqual({
      key: "budget",
      remaining: DAY,
    });
    const late = start + Number(60n * DAY);
    const horizon = vetoState({ ...params, events: [], vetoUntil: 0, now: late });
    expect(vetoBlock({ phase: "Stage1", state: horizon, vetoMax: 2n * DAY, delay: DAY, now: late })?.key).toBe(
      "horizon",
    );
    // An hour before the horizon, any delay up to vetoMax is accepted: it is capped at the horizon.
    const near = late - 3600;
    const nearState = vetoState({ ...params, events: [], vetoUntil: 0, now: near });
    expect(maxVetoNow({ phase: "Stage1", state: nearState, vetoMax: 2n * DAY, now: near })).toBe(2n * DAY);
    expect(vetoBlock({ phase: "Stage1", state: nearState, vetoMax: 2n * DAY, delay: 2n * DAY, now: near })).toBeNull();
  });
});
