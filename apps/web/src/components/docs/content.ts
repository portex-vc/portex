/**
 * The docs' structure. Text lives in messages/*.json under `docs.s.<section>`; this file only says which blocks a
 * section has and in what order, so the three languages always share one layout.
 *
 * Inline markup in the text (see rich.tsx): `**strong**`, `` `code` ``, `[label](href)` and `{{timing}}`, where
 * timing is one of the governed parameters in live-timing.tsx and renders this network's shorter value, if any.
 */
export type Block =
  | { kind: "p"; key: string }
  | { kind: "list"; key: string }
  | { kind: "steps"; key: string }
  | { kind: "h3"; key: string }
  | { kind: "note"; key: string; tone?: "protected" }
  | { kind: "table"; key: string }
  | { kind: "related"; ids: string[] }
  | { kind: "faq"; key: string }
  | { kind: "terms"; key: string }
  | { kind: "figure"; figure: "hero" | "mechanism" | "stepper" | "boundary" | "timings" | "contracts" | "network" };

export interface Section {
  id: string;
  /** Stage sections take their title from the canonical stage names. */
  stage?: "Stage1" | "Stage2" | "Stage3";
  blocks: Block[];
}

const p = (key: string): Block => ({ kind: "p", key });
const list = (key: string): Block => ({ kind: "list", key });
const steps = (key: string): Block => ({ kind: "steps", key });
const h3 = (key: string): Block => ({ kind: "h3", key });
const related = (...ids: string[]): Block => ({ kind: "related", ids });

export const SECTIONS: Section[] = [
  {
    id: "overview",
    blocks: [
      { kind: "figure", figure: "hero" },
      p("p1"),
      p("p2"),
      list("pillars"),
      { kind: "figure", figure: "mechanism" },
    ],
  },
  {
    id: "lifecycle",
    blocks: [{ kind: "figure", figure: "stepper" }, p("p1"), p("p2"), { kind: "figure", figure: "boundary" }],
  },
  {
    id: "guideBacker",
    blocks: [
      h3("join"),
      steps("joinSteps"),
      h3("leave"),
      steps("leaveSteps"),
      h3("after"),
      steps("afterSteps"),
      related("stage1", "exits", "dissolution", "stage3"),
    ],
  },
  {
    id: "guideBuilder",
    blocks: [
      h3("launch"),
      steps("launchSteps"),
      h3("run"),
      steps("runSteps"),
      h3("end"),
      steps("endSteps"),
      related("launchTypes", "treasury", "analyst", "timings"),
    ],
  },
  {
    id: "guideTrader",
    blocks: [
      h3("book"),
      steps("bookSteps"),
      h3("pool"),
      steps("poolSteps"),
      h3("risks"),
      list("risksList"),
      related("stage2", "markets", "fees"),
    ],
  },
  {
    id: "guideAnalyst",
    blocks: [
      h3("ai"),
      list("aiList"),
      h3("api"),
      p("apiText"),
      { kind: "table", key: "endpoints" },
      p("apiNote"),
      related("analyst", "contracts"),
    ],
  },
  {
    id: "guideAdmin",
    blocks: [
      p("p1"),
      h3("curator"),
      steps("curatorSteps"),
      h3("attester"),
      steps("attesterSteps"),
      h3("council"),
      steps("councilSteps"),
      h3("limits"),
      list("limitsList"),
      related("roles", "timings", "analyst"),
    ],
  },
  {
    id: "stage1",
    stage: "Stage1",
    blocks: [
      h3("can"),
      list("canList"),
      h3("protects"),
      { kind: "note", key: "protectsNote", tone: "protected" },
      h3("ends"),
      list("endsList"),
    ],
  },
  {
    id: "stage2",
    stage: "Stage2",
    blocks: [
      h3("can"),
      list("canList"),
      h3("price"),
      p("priceText"),
      h3("protects"),
      { kind: "note", key: "protectsNote", tone: "protected" },
      h3("ends"),
      p("endsText"),
    ],
  },
  {
    id: "stage3",
    stage: "Stage3",
    blocks: [h3("listing"), list("listingList"), h3("can"), list("canList"), { kind: "note", key: "quotaNote" }],
  },
  {
    id: "launchTypes",
    blocks: [{ kind: "table", key: "table" }, h3("escrow"), p("escrowText"), h3("budget"), p("budgetText")],
  },
  {
    id: "exits",
    blocks: [
      h3("cost"),
      p("costText"),
      h3("protected"),
      p("protectedText"),
      p("protectedSource"),
      { kind: "note", key: "example", tone: "protected" },
      p("buyers"),
    ],
  },
  {
    id: "dissolution",
    blocks: [h3("dissolution"), list("dissolutionList"), p("dissolutionText"), h3("rollover"), p("rolloverText")],
  },
  { id: "fees", blocks: [{ kind: "table", key: "table" }, p("p1")] },
  {
    id: "treasury",
    blocks: [
      h3("sources"),
      list("sourcesList"),
      h3("capital"),
      p("capitalText"),
      h3("tokens"),
      p("tokensText"),
      h3("team"),
      p("teamText"),
    ],
  },
  { id: "analyst", blocks: [list("list")] },
  { id: "roles", blocks: [{ kind: "table", key: "table" }, p("p1")] },
  { id: "timings", blocks: [p("p1"), { kind: "figure", figure: "timings" }, p("p2")] },
  { id: "markets", blocks: [list("list")] },
  { id: "testnet", blocks: [{ kind: "figure", figure: "network" }, list("list")] },
  { id: "contracts", blocks: [p("p1"), { kind: "figure", figure: "contracts" }, p("p2")] },
  { id: "faq", blocks: [{ kind: "faq", key: "items" }] },
  { id: "glossary", blocks: [{ kind: "terms", key: "items" }] },
];

export const GROUPS: { id: string; sections: string[] }[] = [
  { id: "start", sections: ["overview", "lifecycle"] },
  { id: "guides", sections: ["guideBacker", "guideBuilder", "guideTrader", "guideAnalyst", "guideAdmin"] },
  { id: "stages", sections: ["stage1", "stage2", "stage3"] },
  { id: "money", sections: ["launchTypes", "exits", "dissolution", "fees"] },
  { id: "governance", sections: ["treasury", "analyst", "roles", "timings"] },
  { id: "trading", sections: ["markets"] },
  { id: "network", sections: ["testnet", "contracts"] },
  { id: "reference", sections: ["faq", "glossary"] },
];

export const subId = (section: string, key: string) => `${section}-${key}`;
