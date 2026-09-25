import type { RaiseSummary } from "./api";

export type LaunchTemplate = RaiseSummary["template"];

export const LAUNCH_TYPES = [
  { key: "sealed", template: "ESCROW_LAUNCH" },
  { key: "milestone", template: "BUDGET_LAUNCH" },
] as const satisfies readonly { key: string; template: LaunchTemplate }[];

export function launchTypeKey(template: LaunchTemplate) {
  return template === "ESCROW_LAUNCH" ? "sealed" : "milestone";
}
