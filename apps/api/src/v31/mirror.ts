/**
 * Exact integer mirrors of the v3.1 contract math, evaluated off-chain over materialized state (no RPC).
 *
 * Every function follows its Solidity source line by line: `Math.mulDiv` floors, `Math.Rounding.Ceil` rounds up, and
 * checked arithmetic that would revert throws `Revert`. Sources: ReserveMarket.sol, ProtectedSplitLib.sol,
 * ViewsV31.sol (exitQuote, tradeQuote, listingPlan), StorageV31.sol (time, effectivePhase), ListingMathV31.sol,
 * CurveV31.sol, VestingVaultV31.sol, TreasuryV31.sol, GovernanceV31.sol (_quoteValue).
 */
export const SCALE = 10n ** 18n;
export const NORMALIZED_PRICE = 10n ** 30n;
export const MAX_QUOTE = 10n ** 30n;
export const MAX_SUPPLY = 10n ** 30n;
const Q96 = 1n << 96n;
const Q192 = 1n << 192n;
const DAY = 86400n;

export const PHASE = { Stage1: 0, Stage2: 1, ListingPending: 2, Stage3: 3, Dissolved: 4 } as const;
export const REASON = {
  None: 0, PhaseClosed: 1, InvalidPosition: 2, InvalidQuantity: 3, StaleNonce: 4, EmptyBook: 5, Insolvent: 6,
  PriceInvalid: 7, VenueUnavailable: 8, Migrating: 9, Unauthorized: 10,
} as const;
export const CLASS = { Backer: 0, Buyer: 1, BuilderPurchase: 2 } as const;
export const BRANCH = { Positive: 0, QuoteWithoutTokens: 1, ZeroQuote: 2, Empty: 3 } as const;

/** A path on which the Solidity code reverts (the view call would fail). */
export class Revert extends Error {
  constructor(readonly reason: string) { super(`execution reverted: ${reason}`); }
}
const req = (ok: boolean, reason = 'InvariantFailure') => { if (!ok) throw new Revert(reason); };
const sub = (a: bigint, b: bigint) => { req(a >= b, 'Panic(0x11)'); return a - b; };

export const mulDiv = (a: bigint, b: bigint, c: bigint) => { req(c !== 0n, 'Panic(0x12)'); return a * b / c; };
export const mulDivUp = (a: bigint, b: bigint, c: bigint) => {
  req(c !== 0n, 'Panic(0x12)');
  const p = a * b;
  return p / c + (p % c === 0n ? 0n : 1n);
};
export const ceilDiv = (a: bigint, b: bigint) => { req(b !== 0n, 'Panic(0x12)'); return a === 0n ? 0n : (a - 1n) / b + 1n; };
const min = (a: bigint, b: bigint) => a < b ? a : b;
const max = (a: bigint, b: bigint) => a > b ? a : b;

// ------------------------------------------------------------------------------------------------ StorageV31

/** `effectivePhase`: Stage 2 reads as ListingPending from `stage2End` on (inclusive). */
export function effectivePhaseIndex(storagePhase: number, stage2End: bigint | number, now: number): number {
  return storagePhase === PHASE.Stage2 && Number(stage2End) > 0 && now >= Number(stage2End) ? PHASE.ListingPending : storagePhase;
}

/** `S.time`: the Stage 2 decay clock in [0, SCALE]. */
export function stage2Time(stage2Start: bigint, stage2End: bigint, stage2Length: bigint, now: number): bigint {
  const t = BigInt(now);
  if (stage2Start === 0n || t <= stage2Start) return 0n;
  if (t >= stage2End) return SCALE;
  return mulDiv(t - stage2Start, SCALE, stage2Length);
}

// ------------------------------------------------------------------------------------------------ ReserveMarket

export interface Book { E: bigint; R: bigint; V: bigint; T: bigint; O: bigint }
export interface Fees { total: bigint; reserve: bigint; reward: bigint; treasury: bigint }
export interface PSResult { cost: bigint; value: bigint; premium: bigint; cap: bigint; profit: bigint; qSold: bigint; burn: bigint; payout: bigint }
export interface TradeQuote {
  validity: Validity; gross: bigint; ammAmount: bigint; tokens: bigint; net: bigint; fees: Fees;
  priceBefore: bigint; priceAfter: bigint; priceImpactBps: bigint; depthBurn: bigint;
}
export interface ExitQuote { validity: Validity; result: PSResult; bookBurn: bigint; depthBurn: bigint }
export interface Validity { available: boolean; reason: number; phase: number; stateNonce: bigint }

const zeroResult = (): PSResult => ({ cost: 0n, value: 0n, premium: 0n, cap: 0n, profit: 0n, qSold: 0n, burn: 0n, payout: 0n });
const zeroFees = (): Fees => ({ total: 0n, reserve: 0n, reward: 0n, treasury: 0n });

export function split(gross: bigint): Fees {
  const total = gross / 100n;
  const reserve = mulDiv(total, 40n, 100n);
  const reward = mulDiv(total, 30n, 100n);
  return { total, reserve, reward, treasury: total - reserve - reward };
}

export function bookPriceOf(b: Book): bigint {
  return b.T === 0n ? 0n : mulDiv(b.R + b.V, NORMALIZED_PRICE, b.T);
}

export function valid(b: Book, tokenFirst: boolean): boolean {
  if (b.R + b.V > MAX_QUOTE || b.T > MAX_SUPPLY || b.O > MAX_SUPPLY || b.E > b.V) return false;
  if (b.R * b.T < b.V * b.O) return false;
  if (b.E + b.R !== 0n && b.T === 0n) return false;
  if (b.R + b.V === 0n || b.T === 0n) return true;
  return representable(bookPriceOf(b), tokenFirst);
}

export function decay(b: Book, x0: bigint, lastT: bigint, t: bigint): { book: Book; burn: bigint; lastT: bigint } {
  req(!(t < lastT || b.V < b.E));
  const target = mulDiv(x0, SCALE - t, SCALE);
  req(b.V - b.E >= target);
  const delta = b.V - b.E - target;
  if (delta === 0n) return { book: { ...b }, burn: 0n, lastT };
  const q = b.R + b.V;
  req(q !== 0n);
  const burn = mulDiv(delta, b.T, q);
  return { book: { ...b, V: b.V - delta, T: b.T - burn }, burn, lastT: t };
}

export function shrink(b: Book, cost: bigint): { book: Book; burn: bigint } {
  req(!(cost > b.E || cost > b.V));
  const burn = cost !== 0n && b.T !== 0n ? mulDiv(cost, b.T, b.R + b.V) : 0n;
  return { book: { ...b, E: b.E - cost, V: b.V - cost, T: sub(b.T, burn) }, burn };
}

/** ProtectedSplitLib.quote, steps 2–11. */
export function protectedSplit(book: Book, pos: { basis: bigint; tokens: bigint }, q: bigint, lambdaT: bigint): { r: PSResult; after: Book } {
  req(q !== 0n, 'ZeroQuantity');
  req(q <= pos.tokens, 'ExceedsPositionTokens');
  req(book.T !== 0n, 'ZeroInventory');
  req(lambdaT <= SCALE, 'LambdaOutOfRange');
  const r = zeroResult();
  r.cost = q === pos.tokens ? pos.basis : mulDiv(pos.basis, q, pos.tokens);
  let burnShrink = 0n;
  if (r.cost > 0n) {
    const qSum = book.R + book.V;
    if (qSum !== 0n) {
      burnShrink = mulDiv(r.cost, book.T, qSum);
      req(burnShrink <= book.T, 'ShrinkBurnExceedsInventory');
    }
    req(book.V >= r.cost, 'InsufficientVirtualQuote');
  }
  const after: Book = { R: book.R, V: book.V - r.cost, T: book.T - burnShrink, O: book.O, E: sub(book.E, r.cost) };
  const qPost = book.R + after.V;
  r.value = mulDiv(qPost, q, after.T + q);
  r.premium = r.value > r.cost ? r.value - r.cost : 0n;
  const rt = book.R * after.T;
  const vo = after.V * book.O;
  req(rt >= vo, 'InsufficientSolvency');
  if (qPost * after.T !== vo) {
    r.cap = mulDiv(qPost, rt - vo, qPost * after.T - vo);
    if (r.cap > book.R) r.cap = book.R;
  }
  r.profit = mulDiv(lambdaT, r.premium, SCALE);
  if (r.profit > r.cap) r.profit = r.cap;
  if (r.profit === 0n) r.qSold = 0n;
  else if (r.profit === qPost) r.qSold = q;
  else {
    r.qSold = mulDivUp(r.profit, after.T, qPost - r.profit);
    if (r.qSold > q) r.qSold = q;
  }
  after.R = sub(book.R, r.profit);
  after.T = after.T + r.qSold;
  r.burn = q - r.qSold;
  r.payout = r.cost + r.profit;
  return { r, after };
}

/** ReserveMarket.protectedQuote: ProtectedSplitLib with the zero-inventory branch and its exactness check. */
export function protectedQuote(b: Book, pos: { basis: bigint; tokens: bigint }, q: bigint, t: bigint): { r: PSResult; after: Book; bookBurn: bigint } {
  if (b.T === 0n) {
    const r = zeroResult();
    r.cost = q === pos.tokens ? pos.basis : mulDiv(pos.basis, q, pos.tokens);
    r.payout = r.cost;
    r.burn = q;
    const s = shrink(b, r.cost);
    return { r, after: s.book, bookBurn: s.burn };
  }
  const { r, after } = protectedSplit(b, pos, q, t);
  const bookBurn = sub(b.T + r.qSold, after.T);
  if (r.profit !== 0n) {
    const postQ = sub(b.R + b.V, r.cost);
    req(postQ > r.profit);
    const exactSold = mulDivUp(r.profit, sub(b.T, bookBurn), postQ - r.profit);
    req(!(exactSold > q || exactSold !== r.qSold));
  }
  return { r, after, bookBurn };
}

function impact(before: bigint, after: bigint): bigint {
  req(before !== 0n);
  const delta = after >= before ? after - before : before - after;
  return mulDiv(delta, 10000n, before);
}

export function marketBuy(b: Book, gross: bigint): { r: Omit<TradeQuote, 'validity' | 'depthBurn'>; after: Book } {
  const fees = split(gross);
  const ammAmount = gross - fees.total;
  const tokens = mulDiv(b.T, ammAmount, b.R + b.V + ammAmount);
  const priceBefore = bookPriceOf(b);
  const after = { ...b, R: b.R + ammAmount + fees.reserve, T: sub(b.T, tokens), O: b.O + tokens };
  const priceAfter = bookPriceOf(after);
  return { r: { gross, fees, ammAmount, tokens, net: tokens, priceBefore, priceAfter, priceImpactBps: impact(priceBefore, priceAfter) }, after };
}

export function marketSell(b: Book, quantity: bigint): { r: Omit<TradeQuote, 'validity' | 'depthBurn'>; after: Book } {
  const gross = mulDiv(b.R + b.V, quantity, b.T + quantity);
  const fees = split(gross);
  const net = gross - fees.total;
  const priceBefore = bookPriceOf(b);
  const debit = gross - fees.reserve;
  req(debit <= b.R);
  const after = { ...b, R: b.R - debit, T: b.T + quantity, O: sub(b.O, quantity) };
  const priceAfter = bookPriceOf(after);
  return { r: { gross, fees, ammAmount: gross, tokens: quantity, net, priceBefore, priceAfter, priceImpactBps: impact(priceBefore, priceAfter) }, after };
}

// ------------------------------------------------------------------------------------------------ ViewsV31

/** The raise state the typed views read, rebuilt from materialized view results. */
export interface RaiseMath {
  /** Storage phase (never ListingPending). */
  phase: number;
  nonce: bigint;
  book: Book;
  x0: bigint;
  lastT: bigint;
  stage2Start: bigint;
  stage2End: bigint;
  stage2Length: bigint;
  tokenFirst: boolean;
  migrating: boolean;
  isBuilder: (owner: string) => boolean;
  buyerTokens: (owner: string) => bigint;
  // listingPlan inputs
  token: string;
  vesting: string;
  pEnd: bigint;
  lastPrice: bigint;
  liquidityReserve: bigint;
  totalBackerTokens: bigint;
  totalBuilderTokens: bigint;
  claimLiabilities: bigint;
}
/** A position as `positionState` reports it (owner zero when it does not exist). */
export interface PositionMath { owner: string; class: number; tokens: bigint; basis: bigint }

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
export function validityOf(s: RaiseMath, reason: number, now: number): Validity {
  const r = s.migrating ? REASON.Migrating : reason;
  return { available: r === REASON.None, reason: r, phase: effectivePhaseIndex(s.phase, s.stage2End, now), stateNonce: s.nonce };
}

/** ViewsV31.exitQuote: `redeemQuote` (protected=false, caller nonce) and `protectedExitQuote` (protected=true, current nonce). */
export function exitQuote(s: RaiseMath, p: PositionMath, q: bigint, isProtected: boolean, nonce: bigint, now: number): ExitQuote {
  const out: ExitQuote = { validity: validityOf(s, REASON.Migrating, now), result: zeroResult(), bookBurn: 0n, depthBurn: 0n };
  if (s.migrating) return out;
  const phase = effectivePhaseIndex(s.phase, s.stage2End, now);
  let reason: number = REASON.None;
  // Like the contract, a quote no longer expires when the state moves: the caller's minimum payout binds instead.
  void nonce;
  if (phase === PHASE.Stage3 || phase === PHASE.Dissolved || (isProtected && phase !== PHASE.Stage2)) reason = REASON.PhaseClosed;
  else if (p.owner.toLowerCase() === ZERO_ADDRESS || p.class === CLASS.Buyer || (isProtected && p.class !== CLASS.Backer)) reason = REASON.InvalidPosition;
  else if (q === 0n || q > p.tokens) reason = REASON.InvalidQuantity;
  out.validity = validityOf(s, reason, now);
  if (reason !== REASON.None) return out;
  const basis = p.basis;
  out.result.cost = q === p.tokens ? basis : mulDiv(basis, q, p.tokens);
  out.result.burn = q;
  out.result.payout = out.result.cost;
  // Stage 1: the exited tokens return to the sale inventory; nothing burns.
  if (phase === PHASE.Stage1) {
    out.result.burn = 0n;
    return out;
  }
  const t = stage2Time(s.stage2Start, s.stage2End, s.stage2Length, now);
  const d = decay(s.book, s.x0, s.lastT, t);
  out.depthBurn = d.burn;
  if (isProtected) {
    const pq = protectedQuote(d.book, { basis, tokens: p.tokens }, q, t);
    out.result = pq.r;
    out.bookBurn = pq.bookBurn;
  } else {
    out.bookBurn = shrink(d.book, out.result.cost).burn;
  }
  return out;
}

const emptyTrade = (validity: Validity): TradeQuote => ({
  validity, gross: 0n, ammAmount: 0n, tokens: 0n, net: 0n, fees: zeroFees(), priceBefore: 0n, priceAfter: 0n, priceImpactBps: 0n, depthBurn: 0n,
});

/** ViewsV31.tradeQuote: `marketBuyQuote(For)` (buying) and `marketExitQuote` (selling the owner's buyer ledger). */
export function tradeQuote(s: RaiseMath, owner: string | null, amount: bigint, buying: boolean, now: number): TradeQuote {
  if (s.migrating) return emptyTrade(validityOf(s, REASON.Migrating, now));
  const phase = effectivePhaseIndex(s.phase, s.stage2End, now);
  if (phase !== PHASE.Stage2 && (buying || phase !== PHASE.ListingPending)) return emptyTrade(validityOf(s, REASON.PhaseClosed, now));
  const who = owner ?? ZERO_ADDRESS;
  if (buying && who.toLowerCase() !== ZERO_ADDRESS && s.isBuilder(who)) return emptyTrade(validityOf(s, REASON.Unauthorized, now));
  if (amount === 0n || (buying && amount > MAX_QUOTE / 4n) || (!buying && amount > s.buyerTokens(who))) return emptyTrade(validityOf(s, REASON.InvalidQuantity, now));
  const t = stage2Time(s.stage2Start, s.stage2End, s.stage2Length, now);
  const d = decay(s.book, s.x0, s.lastT, t);
  const b = d.book;
  if (b.T === 0n || b.R + b.V === 0n) return emptyTrade(validityOf(s, REASON.EmptyBook, now));
  if (!buying) {
    const gross = mulDiv(b.R + b.V, amount, b.T + amount);
    if (gross - split(gross).reserve > b.R) return emptyTrade(validityOf(s, REASON.Insolvent, now));
  }
  const inventoryBefore = b.T;
  const { r, after } = buying ? marketBuy(b, amount) : marketSell(b, amount);
  if (!valid(after, s.tokenFirst) || (buying && (r.tokens === 0n || r.tokens >= inventoryBefore))) {
    return emptyTrade(validityOf(s, REASON.Insolvent, now));
  }
  return { validity: validityOf(s, REASON.None, now), ...r, depthBurn: d.burn };
}

export interface ListingPreview {
  validity: Validity; branch: number; price: bigint; sqrtPriceX96: bigint; escrowRolled: bigint; desiredQuote: bigint;
  desiredToken: bigint; usedQuote: bigint; usedToken: bigint; minQuote: bigint; minToken: bigint; liquidity: bigint;
  bookBurn: bigint; liquidityReserveBurn: bigint; depthBurn: bigint; quoteDust: bigint; backerDelivery: bigint;
  buyerDelivery: bigint; builderDelivery: bigint; ordinaryDestination: string; builderDestination: string;
  claimLiabilities: bigint; claimsEndOnSuccess: boolean;
}

/** ViewsV31.listingPreview / listingPlan: the mandatory listing at final decay. */
export function listingPreview(s: RaiseMath, now: number): ListingPreview {
  const phase = effectivePhaseIndex(s.phase, s.stage2End, now);
  const p: ListingPreview = {
    validity: { available: false, reason: s.migrating ? REASON.Migrating : REASON.PhaseClosed, phase, stateNonce: s.nonce },
    branch: BRANCH.Positive, price: 0n, sqrtPriceX96: 0n, escrowRolled: 0n, desiredQuote: 0n, desiredToken: 0n, usedQuote: 0n,
    usedToken: 0n, minQuote: 0n, minToken: 0n, liquidity: 0n, bookBurn: 0n, liquidityReserveBurn: 0n, depthBurn: 0n, quoteDust: 0n,
    backerDelivery: 0n, buyerDelivery: 0n, builderDelivery: 0n, ordinaryDestination: ZERO_ADDRESS, builderDestination: ZERO_ADDRESS,
    claimLiabilities: 0n, claimsEndOnSuccess: false,
  };
  if (s.migrating || phase !== PHASE.ListingPending) return p;
  const d = decay(s.book, s.x0, s.lastT, SCALE);
  const b = d.book;
  Object.assign(p, {
    depthBurn: d.burn, escrowRolled: b.E, desiredQuote: b.E + b.R, desiredToken: b.T, backerDelivery: s.totalBackerTokens,
    buyerDelivery: b.O, builderDelivery: s.totalBuilderTokens, ordinaryDestination: s.token, builderDestination: s.vesting,
    claimLiabilities: s.claimLiabilities, claimsEndOnSuccess: true,
  });
  p.validity = { available: true, reason: REASON.None, phase, stateNonce: s.nonce };
  if (p.desiredQuote !== 0n && b.T === 0n) {
    p.branch = BRANCH.QuoteWithoutTokens;
    p.validity = { available: false, reason: REASON.EmptyBook, phase, stateNonce: s.nonce };
    return p;
  }
  if (p.desiredQuote !== 0n) p.price = mulDiv(p.desiredQuote, NORMALIZED_PRICE, b.T);
  else {
    p.branch = b.T === 0n ? BRANCH.Empty : BRANCH.ZeroQuote;
    p.price = b.T === 0n ? s.pEnd : s.lastPrice;
  }
  if (!representable(p.price, s.tokenFirst)) {
    p.validity = { available: false, reason: REASON.PriceInvalid, phase, stateNonce: s.nonce };
    return p;
  }
  p.sqrtPriceX96 = sqrtPriceOf(p.price, s.tokenFirst);
  if (p.desiredQuote !== 0n) {
    const l = liquidityFor(p.sqrtPriceX96, s.tokenFirst ? b.T : p.desiredQuote, s.tokenFirst ? p.desiredQuote : b.T);
    p.liquidity = l.liquidity;
    [p.usedToken, p.usedQuote] = s.tokenFirst ? [l.used0, l.used1] : [l.used1, l.used0];
    p.minQuote = minimumUsage(p.desiredQuote);
    p.minToken = minimumUsage(b.T);
    if (p.desiredQuote < 1_000_000n || p.liquidity === 0n || p.usedQuote < p.minQuote || p.usedToken < p.minToken) {
      p.branch = BRANCH.ZeroQuote;
      p.liquidity = 0n; p.usedQuote = 0n; p.usedToken = 0n; p.minQuote = 0n; p.minToken = 0n;
    }
  }
  const reserveUsed = min(p.usedToken, s.liquidityReserve);
  p.liquidityReserveBurn = s.liquidityReserve - reserveUsed;
  p.bookBurn = sub(b.T, sub(p.usedToken, reserveUsed));
  p.quoteDust = sub(p.desiredQuote, p.usedQuote);
  return p;
}

// ------------------------------------------------------------------------------------------------ ListingMathV31

export const SQRT_LOWER = 4310618292n;
export const SQRT_UPPER = 1456195216270955103206513029158776779468408838535n;
const MAX_LIQUIDITY = ((1n << 128n) - 1n) / 8873n;

/** s*s*d <= n*2^192 (the Solidity 512-bit version returns false when the left side exceeds 512 bits; so does this). */
export function squareLe(s: bigint, n: bigint, d: bigint): boolean { return s * s * d <= n * Q192; }

export function representable(price: bigint, tokenFirst: boolean): boolean {
  if (price === 0n) return false;
  const [n, d] = tokenFirst ? [price, NORMALIZED_PRICE] : [NORMALIZED_PRICE, price];
  return squareLe(SQRT_LOWER + 1n, n, d) && !squareLe(SQRT_UPPER, n, d);
}

export function sqrtPriceOf(price: bigint, tokenFirst: boolean): bigint {
  req(representable(price, tokenFirst), 'InvalidConfig');
  const [n, d] = tokenFirst ? [price, NORMALIZED_PRICE] : [NORMALIZED_PRICE, price];
  let low = SQRT_LOWER + 1n;
  let high = SQRT_UPPER - 1n;
  while (low < high) {
    const middle = low + (high - low + 1n) / 2n;
    if (squareLe(middle, n, d)) low = middle;
    else high = middle - 1n;
  }
  return low;
}

export function listingAmounts(s: bigint, liquidity: bigint): { amount0: bigint; amount1: bigint } {
  req(!(s <= SQRT_LOWER || s >= SQRT_UPPER), 'InvalidConfig');
  return {
    amount0: ceilDiv(mulDivUp(liquidity << 96n, SQRT_UPPER - s, SQRT_UPPER), s),
    amount1: mulDivUp(liquidity, s - SQRT_LOWER, Q96),
  };
}

export function liquidityFor(s: bigint, desired0: bigint, desired1: bigint): { liquidity: bigint; used0: bigint; used1: bigint } {
  let low = 0n;
  let high = MAX_LIQUIDITY;
  while (low < high) {
    const middle = low + (high - low + 1n) / 2n;
    const a = listingAmounts(s, middle);
    if (a.amount0 <= desired0 && a.amount1 <= desired1) low = middle;
    else high = middle - 1n;
  }
  const used = listingAmounts(s, low);
  return { liquidity: low, used0: used.amount0, used1: used.amount1 };
}

export function minimumUsage(desired: bigint): bigint { return max(1n, mulDiv(desired, 9999n, 10000n)); }

// ------------------------------------------------------------------------------------------------ CurveV31

export function curveCost(target: bigint, allocation: bigint, sold: bigint, quantity: bigint): bigint {
  req(!(allocation === 0n || sold > allocation || quantity > allocation - sold), 'InvalidAmount');
  const area = quantity * (4n * allocation + 2n * sold + quantity);
  return mulDivUp(target, area, 6n * allocation * NORMALIZED_PRICE);
}

/** Greatest affordable quantity and its exact debit (the deposit's own binary search). */
export function curvePurchase(target: bigint, allocation: bigint, sold: bigint, deposit: bigint): { quantity: bigint; debit: bigint } {
  let quantity = 0n;
  let high = allocation - sold;
  while (quantity < high) {
    const middle = quantity + (high - quantity + 1n) / 2n;
    if (curveCost(target, allocation, sold, middle) <= deposit) quantity = middle;
    else high = middle - 1n;
  }
  return { quantity, debit: curveCost(target, allocation, sold, quantity) };
}

export function curveMarginalPrice(target: bigint, allocation: bigint, sold: bigint): bigint {
  return allocation === 0n ? 0n : mulDiv(target, 2n * allocation + sold, 3n * allocation);
}

// ------------------------------------------------------------------------------------------------ modules

/** VestingVaultV31.vested: 30-day cliff, then linear over 1095 days. */
export function vestedAt(grant: bigint, listedAt: bigint, now: number): bigint {
  const cliff = listedAt + 30n * DAY;
  const t = BigInt(now);
  if (listedAt === 0n || t <= cliff) return 0n;
  return mulDiv(grant, min(t - cliff, 1095n * DAY), 1095n * DAY);
}

/** TreasuryV31.lockedTokensAt: all of the allocation until listing, then a straight line to zero. */
export function lockedTokensAt(allocation: bigint, listedAt: bigint, vestingDuration: bigint, time: number): bigint {
  const t = BigInt(time);
  if (listedAt === 0n || t <= listedAt) return allocation;
  const elapsed = t - listedAt;
  if (elapsed >= vestingDuration) return 0n;
  return allocation - mulDiv(allocation, elapsed, vestingDuration);
}

/** GovernanceV31._quoteValue: USDG value of project tokens at a v4 sqrt price. */
export function quoteValueAt(tokens: bigint, sqrtPriceX96: bigint, tokenFirst: boolean): bigint {
  if (sqrtPriceX96 === 0n || tokens === 0n) return 0n;
  if (tokenFirst) return mulDiv(mulDiv(tokens, sqrtPriceX96, Q96), sqrtPriceX96, Q96);
  return mulDiv(mulDiv(tokens, Q96, sqrtPriceX96), Q96, sqrtPriceX96);
}
