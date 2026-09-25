/** Matches CurveV31's rational integral, with one final native-quote ceiling. */
export function curveCost(target: bigint, allocation: bigint, sold: bigint, quantity: bigint): bigint {
  if (allocation <= 0n || sold < 0n || quantity < 0n || sold + quantity > allocation)
    throw new Error("Invalid curve input");
  const numerator = target * quantity * (4n * allocation + 2n * sold + quantity);
  const denominator = 6n * allocation * 10n ** 30n;
  return (numerator + denominator - 1n) / denominator;
}
export function depositQuote(target: bigint, allocation: bigint, sold: bigint, amount: bigint) {
  if (amount < 0n || sold > allocation) throw new Error("Invalid deposit");
  let low = 0n,
    high = allocation - sold;
  while (low < high) {
    const mid = low + (high - low + 1n) / 2n;
    if (curveCost(target, allocation, sold, mid) <= amount) low = mid;
    else high = mid - 1n;
  }
  const debit = curveCost(target, allocation, sold, low);
  return { tokens: low, debit, change: amount - debit, unitCost: low > 0n ? (debit * 10n ** 30n) / low : 0n };
}
/** Floor a minimum, never round it upward or use floating-point token arithmetic. */
export function minimumOutput(quote: bigint, toleranceBps: number): bigint {
  if (quote < 0n || !Number.isInteger(toleranceBps) || toleranceBps < 0 || toleranceBps > 100)
    throw new Error("Invalid tolerance");
  return (quote * BigInt(10000 - toleranceBps)) / 10000n;
}
export const quoteDeadline = (chainNow: number) => BigInt(Math.floor(chainNow) + 600);
export function parseTolerance(percent: string): number | null {
  if (!/^\d+(\.\d{1,2})?$/.test(percent)) return null;
  const bps = Math.round(Number(percent) * 100);
  return bps >= 0 && bps <= 100 ? bps : null;
}
