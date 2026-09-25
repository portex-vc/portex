import { expect, test } from "bun:test";
import en from "../messages/en.json";
import zh from "../messages/zh.json";
import es from "../messages/es.json";
function leaves(value: unknown, path = ""): string[] {
  if (typeof value === "string") return [path];
  return Object.entries(value as object).flatMap(([key, child]) => leaves(child, path ? `${path}.${key}` : key));
}
test("all three locales provide every message key", () => {
  const keys = leaves(en).sort();
  expect(leaves(zh).sort()).toEqual(keys);
  expect(leaves(es).sort()).toEqual(keys);
});
