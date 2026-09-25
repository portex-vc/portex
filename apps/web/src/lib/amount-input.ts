/** Normalize a localized edit to the canonical decimal string used for transaction arithmetic. */
export function normalizeAmountEdit(input: string, locale: string): string {
  const value = input.replace(/\s/g, "");
  const decimal =
    new Intl.NumberFormat(locale).formatToParts(1.1).find((part) => part.type === "decimal")?.value ?? ".";
  if (decimal === ",") {
    // A comma unambiguously identifies localized input; dots before it are grouping marks.
    return value.includes(",") ? value.replace(/\./g, "").replace(",", ".") : value;
  }
  return value.replace(/,/g, "");
}
export function displayAmountInput(value: string, locale: string): string {
  const decimal =
    new Intl.NumberFormat(locale).formatToParts(1.1).find((part) => part.type === "decimal")?.value ?? ".";
  return value.replace(".", decimal);
}
