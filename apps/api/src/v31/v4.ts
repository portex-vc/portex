/**
 * Exact mirror of a Uniswap v4-core (v4.0.0) exact-input swap, as PortexSwapRouterV31.quoteExactIn runs it: the
 * Pool.swap loop with tick-bitmap word stepping, SwapMath.computeSwapStep, SqrtPriceMath rounding, TickMath and the
 * protocol-fee split. The router's price limits are MIN_SQRT_PRICE + 1 / MAX_SQRT_PRICE - 1 and it rejects partial
 * fills. Inputs are materialized pool state (slot0 + active liquidity) and the pool's initialized ticks, rebuilt from
 * indexed ModifyLiquidity events. No RPC.
 */
const Q96 = 1n << 96n;
const MAX_U160 = (1n << 160n) - 1n;
const MAX_U256 = (1n << 256n) - 1n;
const TWO_256 = 1n << 256n;
const PIPS = 1_000_000n;
export const MIN_TICK = -887272;
export const MAX_TICK = 887272;
export const MIN_SQRT_PRICE = 4295128739n;
export const MAX_SQRT_PRICE = 1461446703485210103287273052203988822378723970342n;

export class V4Revert extends Error {
  constructor(readonly reason: string) { super(`execution reverted: ${reason}`); }
}
const req = (ok: boolean, reason: string) => { if (!ok) throw new V4Revert(reason); };

const mulDiv = (a: bigint, b: bigint, c: bigint) => { const r = a * b / c; req(r <= MAX_U256, 'FullMath overflow'); return r; };
const mulDivUp = (a: bigint, b: bigint, c: bigint) => { const p = a * b; const r = p / c + (p % c ? 1n : 0n); req(r <= MAX_U256, 'FullMath overflow'); return r; };
const divUp = (a: bigint, b: bigint) => a / b + (a % b ? 1n : 0n);

// ------------------------------------------------------------------------------------------------ TickMath

const TICK_FACTORS: [number, bigint][] = [
  [0x2, 0xfff97272373d413259a46990580e213an], [0x4, 0xfff2e50f5f656932ef12357cf3c7fdccn],
  [0x8, 0xffe5caca7e10e4e61c3624eaa0941cd0n], [0x10, 0xffcb9843d60f6159c9db58835c926644n],
  [0x20, 0xff973b41fa98c081472e6896dfb254c0n], [0x40, 0xff2ea16466c96a3843ec78b326b52861n],
  [0x80, 0xfe5dee046a99a2a811c461f1969c3053n], [0x100, 0xfcbe86c7900a88aedcffc83b479aa3a4n],
  [0x200, 0xf987a7253ac413176f2b074cf7815e54n], [0x400, 0xf3392b0822b70005940c7a398e4b70f3n],
  [0x800, 0xe7159475a2c29b7443b29c7fa6e889d9n], [0x1000, 0xd097f3bdfd2022b8845ad8f792aa5825n],
  [0x2000, 0xa9f746462d870fdf8a65dc1f90e061e5n], [0x4000, 0x70d869a156d2a1b890bb3df62baf32f7n],
  [0x8000, 0x31be135f97d08fd981231505542fcfa6n], [0x10000, 0x9aa508b5b7a84e1c677de54f3e99bc9n],
  [0x20000, 0x5d6af8dedb81196699c329225ee604n], [0x40000, 0x2216e584f5fa1ea926041bedfe98n],
  [0x80000, 0x48a170391f7dc42444e8fa2n],
];
const sqrtCache = new Map<number, bigint>();

export function getSqrtPriceAtTick(tick: number): bigint {
  const cached = sqrtCache.get(tick);
  if (cached !== undefined) return cached;
  const absTick = Math.abs(tick);
  req(absTick <= MAX_TICK, 'InvalidTick');
  let price = absTick & 1 ? 0xfffcb933bd6fad37aa2d162d1a594001n : 1n << 128n;
  for (const [bit, factor] of TICK_FACTORS) if (absTick & bit) price = (price * factor) >> 128n;
  if (tick > 0) price = MAX_U256 / price;
  const sqrt = (price >> 32n) + (price % (1n << 32n) === 0n ? 0n : 1n);
  if (sqrtCache.size < 100_000) sqrtCache.set(tick, sqrt);
  return sqrt;
}

/** The greatest tick whose sqrt price is at or below `sqrtPriceX96` (TickMath.getTickAtSqrtPrice). */
export function getTickAtSqrtPrice(sqrtPriceX96: bigint): number {
  req(sqrtPriceX96 >= MIN_SQRT_PRICE && sqrtPriceX96 < MAX_SQRT_PRICE, 'InvalidSqrtPrice');
  let low = MIN_TICK;
  let high = MAX_TICK;
  while (low < high) {
    const middle = low + Math.ceil((high - low) / 2);
    if (getSqrtPriceAtTick(middle) <= sqrtPriceX96) low = middle;
    else high = middle - 1;
  }
  return low;
}

// ------------------------------------------------------------------------------------------------ SqrtPriceMath

export function getAmount0Delta(a: bigint, b: bigint, liquidity: bigint, roundUp: boolean): bigint {
  if (a > b) [a, b] = [b, a];
  req(a !== 0n, 'InvalidPrice');
  const numerator1 = liquidity << 96n;
  const numerator2 = b - a;
  return roundUp ? divUp(mulDivUp(numerator1, numerator2, b), a) : mulDiv(numerator1, numerator2, b) / a;
}

export function getAmount1Delta(a: bigint, b: bigint, liquidity: bigint, roundUp: boolean): bigint {
  const numerator = a > b ? a - b : b - a;
  const product = liquidity * numerator;
  return mulDiv(liquidity, numerator, Q96) + (roundUp && product % Q96 !== 0n ? 1n : 0n);
}

function nextSqrtPriceFromAmount0RoundingUp(sqrtP: bigint, liquidity: bigint, amount: bigint): bigint {
  if (amount === 0n) return sqrtP;
  const numerator1 = liquidity << 96n;
  const product = amount * sqrtP;
  if (product < TWO_256) {
    const denominator = numerator1 + product;
    if (denominator < TWO_256) return mulDivUp(numerator1, sqrtP, denominator) & MAX_U160;
  }
  const sum = numerator1 / sqrtP + amount;
  req(sum <= MAX_U256, 'Panic(0x11)');
  return divUp(numerator1, sum) & MAX_U160;
}

function nextSqrtPriceFromAmount1RoundingDown(sqrtP: bigint, liquidity: bigint, amount: bigint): bigint {
  const quotient = amount <= MAX_U160 ? (amount << 96n) / liquidity : mulDiv(amount, Q96, liquidity);
  const next = sqrtP + quotient;
  req(next <= MAX_U160, 'SafeCastOverflow');
  return next;
}

function nextSqrtPriceFromInput(sqrtP: bigint, liquidity: bigint, amountIn: bigint, zeroForOne: boolean): bigint {
  req(sqrtP !== 0n && liquidity !== 0n, 'InvalidPriceOrLiquidity');
  return zeroForOne ? nextSqrtPriceFromAmount0RoundingUp(sqrtP, liquidity, amountIn) : nextSqrtPriceFromAmount1RoundingDown(sqrtP, liquidity, amountIn);
}

/** SwapMath.computeSwapStep, exact-input branch (`amountRemaining` is the positive input still to spend). */
export function computeSwapStepExactIn(current: bigint, target: bigint, liquidity: bigint, amountRemaining: bigint, feePips: bigint) {
  const zeroForOne = current >= target;
  const lessFee = mulDiv(amountRemaining, PIPS - feePips, PIPS);
  let amountIn = zeroForOne ? getAmount0Delta(target, current, liquidity, true) : getAmount1Delta(current, target, liquidity, true);
  let next: bigint;
  let feeAmount: bigint;
  if (lessFee >= amountIn) {
    next = target;
    feeAmount = feePips === PIPS ? amountIn : mulDivUp(amountIn, feePips, PIPS - feePips);
  } else {
    amountIn = lessFee;
    next = nextSqrtPriceFromInput(current, liquidity, lessFee, zeroForOne);
    feeAmount = amountRemaining - amountIn;
  }
  const amountOut = zeroForOne ? getAmount1Delta(next, current, liquidity, false) : getAmount0Delta(current, next, liquidity, false);
  return { next, amountIn, amountOut, feeAmount };
}

// ------------------------------------------------------------------------------------------------ Pool.swap

export interface PoolTicks {
  /** Initialized ticks (liquidityGross != 0), compressed (tick / spacing), ascending. */
  compressed: number[];
  /** liquidityNet per (uncompressed) tick. */
  net: Map<number, bigint>;
}
export interface PoolSlot { sqrtPriceX96: bigint; tick: number; liquidity: bigint; lpFee: number; protocolFee: number }

/** Initialized ticks from ModifyLiquidity deltas (liquidityGross and liquidityNet, exactly as Pool.modifyLiquidity). */
export function ticksFrom(events: { tickLower: number; tickUpper: number; liquidityDelta: bigint }[], tickSpacing: number): PoolTicks {
  const gross = new Map<number, bigint>();
  const net = new Map<number, bigint>();
  for (const e of events) {
    if (e.liquidityDelta === 0n) continue;
    gross.set(e.tickLower, (gross.get(e.tickLower) ?? 0n) + e.liquidityDelta);
    gross.set(e.tickUpper, (gross.get(e.tickUpper) ?? 0n) + e.liquidityDelta);
    net.set(e.tickLower, (net.get(e.tickLower) ?? 0n) + e.liquidityDelta);
    net.set(e.tickUpper, (net.get(e.tickUpper) ?? 0n) - e.liquidityDelta);
  }
  const compressed = [...gross].filter(([, g]) => g !== 0n).map(([t]) => Math.floor(t / tickSpacing)).sort((a, b) => a - b);
  return { compressed, net };
}

const wordOf = (compressed: number) => Math.floor(compressed / 256);
const bitOf = (compressed: number) => ((compressed % 256) + 256) % 256;

/** TickBitmap.nextInitializedTickWithinOneWord over the sorted initialized set. */
export function nextInitializedTickWithinOneWord(ticks: PoolTicks, tick: number, tickSpacing: number, lte: boolean): { next: number; initialized: boolean } {
  const compressed = Math.floor(tick / tickSpacing);
  const list = ticks.compressed;
  if (lte) {
    const floor = wordOf(compressed) * 256;
    // Largest initialized c with floor <= c <= compressed.
    let found: number | null = null;
    for (let i = list.length - 1; i >= 0; i--) { if (list[i] <= compressed) { if (list[i] >= floor) found = list[i]; break; } }
    return found !== null ? { next: found * tickSpacing, initialized: true } : { next: (compressed - bitOf(compressed)) * tickSpacing, initialized: false };
  }
  const start = compressed + 1;
  const ceiling = wordOf(start) * 256 + 255;
  let found: number | null = null;
  for (const c of list) { if (c >= start) { if (c <= ceiling) found = c; break; } }
  return found !== null ? { next: found * tickSpacing, initialized: true } : { next: (start + 255 - bitOf(start)) * tickSpacing, initialized: false };
}

export interface SwapQuote {
  amountIn: bigint; amountOut: bigint; consumed: bigint; lpFee: bigint; protocolFee: bigint; feeAmount: bigint;
  sqrtPriceBefore: bigint; sqrtPriceAfter: bigint; tickAfter: number; liquidityAfter: bigint; swapFeePips: number;
}

/** Pool.swap for an exact-input amount, at the router's price limit. Throws V4Revert where the router would revert. */
export function quoteExactIn(slot: PoolSlot, ticks: PoolTicks, tickSpacing: number, zeroForOne: boolean, amountIn: bigint): SwapQuote {
  req(amountIn > 0n && amountIn <= (1n << 127n) - 1n, 'InvalidAmount');
  req(slot.sqrtPriceX96 !== 0n, 'PoolNotInitialized');
  const limit = zeroForOne ? MIN_SQRT_PRICE + 1n : MAX_SQRT_PRICE - 1n;
  const protocolFee = BigInt(zeroForOne ? slot.protocolFee % 4096 : slot.protocolFee >> 12);
  const lpFee = BigInt(slot.lpFee);
  const swapFee = protocolFee === 0n ? lpFee : protocolFee + lpFee - protocolFee * lpFee / PIPS;
  if (zeroForOne) req(limit < slot.sqrtPriceX96, 'PriceLimitAlreadyExceeded');
  else req(limit > slot.sqrtPriceX96, 'PriceLimitAlreadyExceeded');
  let remaining = amountIn;
  let out = 0n;
  let sqrtP = slot.sqrtPriceX96;
  let tick = slot.tick;
  let liquidity = slot.liquidity;
  let lpFees = 0n;
  let protocolFees = 0n;
  while (!(remaining === 0n || sqrtP === limit)) {
    const start = sqrtP;
    let { next: tickNext, initialized } = nextInitializedTickWithinOneWord(ticks, tick, tickSpacing, zeroForOne);
    if (tickNext <= MIN_TICK) tickNext = MIN_TICK;
    if (tickNext >= MAX_TICK) tickNext = MAX_TICK;
    const sqrtNext = getSqrtPriceAtTick(tickNext);
    const target = zeroForOne ? (sqrtNext < limit ? limit : sqrtNext) : (sqrtNext > limit ? limit : sqrtNext);
    const step = computeSwapStepExactIn(sqrtP, target, liquidity, remaining, swapFee);
    sqrtP = step.next;
    remaining -= step.amountIn + step.feeAmount;
    out += step.amountOut;
    let fee = step.feeAmount;
    if (protocolFee > 0n) {
      const delta = swapFee === protocolFee ? fee : (step.amountIn + fee) * protocolFee / PIPS;
      fee -= delta;
      protocolFees += delta;
    }
    lpFees += fee;
    if (sqrtP === sqrtNext) {
      if (initialized) {
        let net = ticks.net.get(tickNext) ?? 0n;
        if (zeroForOne) net = -net;
        liquidity += net;
        req(liquidity >= 0n, 'LiquidityUnderflow');
      }
      tick = zeroForOne ? tickNext - 1 : tickNext;
    } else if (sqrtP !== start) {
      tick = getTickAtSqrtPrice(sqrtP);
    }
  }
  const consumed = amountIn - remaining;
  return { amountIn, amountOut: out, consumed, lpFee: lpFees, protocolFee: protocolFees, feeAmount: lpFees + protocolFees,
    sqrtPriceBefore: slot.sqrtPriceX96, sqrtPriceAfter: sqrtP, tickAfter: tick, liquidityAfter: liquidity, swapFeePips: Number(swapFee) };
}
