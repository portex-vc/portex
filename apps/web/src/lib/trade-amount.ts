import { isValidAmountInput, parseQuote, parseToken } from "./format";

export function parseTradeAmount(input: string, buy: boolean): bigint {
  try {
    return input && isValidAmountInput(input) ? (buy ? parseQuote(input) : parseToken(input)) : 0n;
  } catch {
    return 0n;
  }
}
