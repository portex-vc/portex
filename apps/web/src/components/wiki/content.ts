/**
 * The wiki's structure. Text lives in messages/*.json under `wiki.s.<section>`; this file only says which blocks a
 * section has and in what order, so the three languages always share one layout.
 */
export type Block =
  | { kind: "p"; key: string }
  | { kind: "list"; key: string }
  | { kind: "h3"; key: string }
  | { kind: "note"; key: string; tone?: "protected" }
  | { kind: "table"; key: string }
  | { kind: "faq"; key: string }
  | { kind: "terms"; key: string }
  | { kind: "figure"; figure: "hero" | "mechanism" | "stepper" | "boundary" };

export interface Section {
  id: string;
  /** Stage sections take their title from the canonical stage names. */
  stage?: "Stage1" | "Stage2" | "Stage3";
  blocks: Block[];
}

const p = (key: string): Block => ({ kind: "p", key });
const list = (key: string): Block => ({ kind: "list", key });
const h3 = (key: string): Block => ({ kind: "h3", key });

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
  { id: "timings", blocks: [{ kind: "table", key: "table" }, p("p1")] },
  { id: "markets", blocks: [list("list")] },
  { id: "testnet", blocks: [list("list")] },
  { id: "faq", blocks: [{ kind: "faq", key: "items" }] },
  { id: "glossary", blocks: [{ kind: "terms", key: "items" }] },
];

export const GROUPS: { id: string; sections: string[] }[] = [
  { id: "start", sections: ["overview", "lifecycle"] },
  { id: "stages", sections: ["stage1", "stage2", "stage3"] },
  { id: "money", sections: ["launchTypes", "exits", "dissolution", "fees"] },
  { id: "governance", sections: ["treasury", "analyst", "roles", "timings"] },
  { id: "trading", sections: ["markets", "testnet"] },
  { id: "reference", sections: ["faq", "glossary"] },
];

export const subId = (section: string, key: string) => `${section}-${key}`;
