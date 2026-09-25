import { expect, test } from "bun:test";
import { displayAmountInput, normalizeAmountEdit } from "../src/lib/amount-input";
import { parseQuote } from "../src/lib/format";

test("Spanish decimal commas never become a larger whole-token transaction", () => {
  expect(parseQuote(normalizeAmountEdit("0,5", "es"))).toBe(500000n);
  expect(parseQuote(normalizeAmountEdit("1.234,56", "es"))).toBe(1234560000n);
  expect(displayAmountInput("1234.56", "es")).toBe("1234,56");
});
test("English and Chinese grouped amounts retain their exact value", () => {
  for (const locale of ["en", "zh"]) expect(parseQuote(normalizeAmountEdit("1,234.56", locale))).toBe(1234560000n);
  expect(normalizeAmountEdit("0.5", "es")).toBe("0.5");
});
