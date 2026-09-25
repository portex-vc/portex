/**
 * Secondary market (Stage 3 · Open market): Uniswap v4 pool swaps for every listed Portex pool, trader attribution
 * through the Portex swap router, OHLCV candles that continue the Stage 2 book history, and the markets overview.
 *
 * Prices are USDG per whole token. Internally they are 1e18-scaled integers (the same scale as the Stage 2 book
 * price in v31_prices); the API returns decimal strings. Times are unix seconds of the block (chain time).
 */
import { Hono, type Context } from 'hono';
import {
  concat, decodeEventLog, getAddress, isAddress, keccak256, pad, parseAbiItem, toHex, zeroAddress,
  type Address, type Hex, type Log, type PublicClient,
} from 'viem';
import type { DB } from '../db.ts';
import type { Config } from '../config.ts';
import type { Clients } from '../chain.ts';
import * as ABIS from '../generated/v31-abis.ts';
import { profileFromRow } from '../lib/profile.ts';
import { getDeploymentV31, type DeploymentV31 } from './deployment.ts';
import { getRaiseV31, listRaisesV31, type RaiseV31Row } from './db.ts';
import { migrateMarketV31 } from './market-db.ts';
import { storedProfileImage } from './uploads.ts';

export { migrateMarketV31 };

// ---------------------------------------------------------------------------------------------- pure helpers

export const SWAP_EVENT = parseAbiItem('event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)');
export const SWAPPED_EVENT = parseAbiItem('event Swapped(address indexed trader, address indexed token, bytes32 indexed poolId, bool buy, uint256 amountIn, uint256 amountOut, address recipient)');
export const INTERVALS = { '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '4h': 14400, '1d': 86400 } as const;
export type Interval = keyof typeof INTERVALS;
export type Venue = 'stage2' | 'pool';

const Q96 = 2n ** 96n;
const Q192 = 2n ** 192n;
/** Full-range bounds of every Portex pool: sqrt prices at ticks -887200 and 887200 (ListingMathV31.LOWER/UPPER). */
export const SQRT_LOWER = 4310618292n;
export const SQRT_UPPER = 1456195216270955103206513029158776779468408838535n;
/** USDG (6 dp) per token (18 dp), scaled to 1e18 per whole token: raw ratio * 1e30. */
const PRICE_SHIFT = 10n ** 30n;
const POOLS_SLOT = pad(toHex(6), { size: 32 });
const DAY = 86400;

/** Decimal string of a fixed-point integer, trailing zeros trimmed. */
export function decimal(value: bigint, decimals: number): string {
  const negative = value < 0n;
  const v = negative ? -value : value;
  const base = 10n ** BigInt(decimals);
  const fraction = (v % base).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${v / base}${fraction ? `.${fraction}` : ''}`;
}

/** Pool marginal price as USDG per whole token, 1e18-scaled. */
export function spotPriceE18(sqrtPriceX96: bigint, tokenIsCurrency0: boolean): bigint {
  if (sqrtPriceX96 === 0n) return 0n;
  const p2 = sqrtPriceX96 * sqrtPriceX96;
  return tokenIsCurrency0 ? p2 * PRICE_SHIFT / Q192 : Q192 * PRICE_SHIFT / p2;
}

/** Average execution price of a fill (fee included), 1e18-scaled USDG per whole token. */
export function executionPriceE18(amountQuote: bigint, amountToken: bigint): bigint {
  return amountToken === 0n ? 0n : amountQuote * PRICE_SHIFT / amountToken;
}

/** Amounts held by full-range liquidity L at the given price (v4 rounding down). */
export function fullRangeAmounts(liquidity: bigint, sqrtPriceX96: bigint): { amount0: bigint; amount1: bigint } {
  if (liquidity === 0n || sqrtPriceX96 === 0n) return { amount0: 0n, amount1: 0n };
  const s = sqrtPriceX96 < SQRT_LOWER ? SQRT_LOWER : sqrtPriceX96 > SQRT_UPPER ? SQRT_UPPER : sqrtPriceX96;
  return { amount0: liquidity * Q96 * (SQRT_UPPER - s) / s / SQRT_UPPER, amount1: liquidity * (s - SQRT_LOWER) / Q96 };
}

export interface PricePoint { time: number; price: bigint; volume: bigint; venue: Venue; trade: boolean }
export interface Candle { time: number; open: string; high: string; low: string; close: string; volume: string; trades: number; venue: Venue }

/**
 * OHLCV per interval bucket and venue. A bucket opens at the previous close of the same venue (the pool's first
 * candle opens at the listing price), so candles are continuous. Empty buckets are omitted; a bucket that contains
 * the listing yields one candle per venue with the same time.
 */
export function buildCandles(points: PricePoint[], seconds: number, from?: number, to?: number): Candle[] {
  const out: { time: number; open: bigint; high: bigint; low: bigint; close: bigint; volume: bigint; trades: number; venue: Venue }[] = [];
  const last = new Map<Venue, (typeof out)[number]>();
  const previous = new Map<Venue, bigint>();
  for (const p of points) {
    if (p.price <= 0n) continue;
    const time = Math.floor(p.time / seconds) * seconds;
    let c = last.get(p.venue);
    if (!c || c.time !== time) {
      const open = previous.get(p.venue) ?? p.price;
      c = { time, open, high: open, low: open, close: open, volume: 0n, trades: 0, venue: p.venue };
      out.push(c);
      last.set(p.venue, c);
    }
    if (p.price > c.high) c.high = p.price;
    if (p.price < c.low) c.low = p.price;
    c.close = p.price;
    c.volume += p.volume;
    if (p.trade) c.trades++;
    previous.set(p.venue, p.price);
  }
  const start = from === undefined ? -Infinity : Math.floor(from / seconds) * seconds;
  return out.filter((c) => c.time >= start && (to === undefined || c.time <= to))
    .sort((a, b) => a.time - b.time || (a.venue === b.venue ? 0 : a.venue === 'stage2' ? -1 : 1))
    .map((c) => ({ time: c.time, open: decimal(c.open, 18), high: decimal(c.high, 18), low: decimal(c.low, 18),
      close: decimal(c.close, 18), volume: decimal(c.volume, 6), trades: c.trades, venue: c.venue }));
}

/** Last price at or before `time`, from time-ordered points; `fallback` before the first point. */
export function priceAt(points: { time: number; price: bigint }[], time: number, fallback: bigint): bigint {
  let price = fallback;
  for (const p of points) { if (p.time > time) break; price = p.price; }
  return price;
}

// ---------------------------------------------------------------------------------------------- indexing

export interface PoolRow { raiseAddr: string; poolId: string; token: string; quote: string; adapter: string; tokenIsCurrency0: number }
export interface SwapRow {
  raiseAddr: string; poolId: string; side: 'buy' | 'sell'; amountQuote: string; amountToken: string; price: string; spot: string;
  sqrtPriceX96: string; liquidity: string; tick: number; fee: number; sender: string; trader: string; recipient: string | null;
  viaRouter: number; txHash: string; blockNumber: number; logIndex: number;
}
interface Discovery { address: string; token: string; adapter: string; quote?: string }

const live = (value: unknown): string | null => typeof value === 'string' && isAddress(value) && value.toLowerCase() !== zeroAddress ? getAddress(value) : null;
export const routerOf = (dep: DeploymentV31 | null) => live(dep?.router);
export const managerOf = (dep: DeploymentV31 | null) => live(dep?.poolManager);

/**
 * Hooked into IndexerV31: `fetch` runs with the page's other log reads, `insert` inside its transaction and
 * `rollback` inside its reorg rollback, so pool swaps follow exactly the same reorg handling as the raise events.
 */
export class MarketIndexerV31 {
  constructor(private db: DB, private client: PublicClient, private config: Config) { migrateMarketV31(db); }

  /** Pool ids of all known raises, resolved once through the adapter's `poolKey(token, quote)` and cached. */
  private async pools(factoryLogs: Log[]): Promise<Map<string, PoolRow>> {
    const map = new Map<string, PoolRow>();
    const rows = this.db.query('SELECT * FROM v31_pools').all() as PoolRow[];
    for (const p of rows) map.set(p.poolId.toLowerCase(), p);
    // A cached pool is valid while its raise still has the same token (a replaced local chain may reuse addresses).
    const cached = new Map(rows.map((p) => [p.raiseAddr.toLowerCase(), p.token.toLowerCase()]));
    const known = new Set<string>();
    const pending: Discovery[] = listRaisesV31(this.db)
      .filter((r) => { const ok = cached.get(r.address.toLowerCase()) === r.token.toLowerCase(); if (ok) known.add(r.address.toLowerCase()); return !ok; })
      .map((r) => ({ address: r.address, token: r.token, adapter: r.adapter, quote: JSON.parse(r.config || '{}').quote }));
    // Raises discovered in the page being indexed are not in v31_raises yet.
    const created = new Map<string, Discovery>();
    for (const log of factoryLogs) {
      try {
        const e = decodeEventLog({ abi: ABIS.RaiseFactoryV31Abi, topics: log.topics, data: log.data }) as { eventName: string; args: any };
        const key = String(e.args.raise).toLowerCase();
        if (e.eventName === 'RaiseCreated' && !known.has(key)) created.set(key, { address: e.args.raise, token: e.args.modules.token, adapter: e.args.modules.adapter });
        if (e.eventName === 'RaiseConfigured' && created.has(key)) created.get(key)!.quote = e.args.config.quote;
      } catch { /* Not a discovery event. */ }
    }
    pending.push(...created.values());
    for (const r of pending) {
      if (!r.quote || !isAddress(r.quote)) continue;
      const poolId = await this.client.readContract({ address: r.adapter as Address, abi: ABIS.UniswapV4AdapterAbi, functionName: 'poolKey', args: [r.token as Address, r.quote as Address] }) as Hex;
      const row: PoolRow = { raiseAddr: getAddress(r.address), poolId: poolId.toLowerCase(), token: getAddress(r.token), quote: getAddress(r.quote),
        adapter: getAddress(r.adapter), tokenIsCurrency0: BigInt(r.token) < BigInt(r.quote) ? 1 : 0 };
      // Deterministic from (token, quote, hook): safe to keep across reorgs.
      this.db.query('INSERT OR REPLACE INTO v31_pools VALUES (?,?,?,?,?,?)').run(row.raiseAddr, row.poolId, row.token, row.quote, row.adapter, row.tokenIsCurrency0);
      for (const [id, p] of map) if (p.raiseAddr.toLowerCase() === row.raiseAddr.toLowerCase()) map.delete(id);
      map.set(row.poolId, row);
    }
    return map;
  }

  async fetch(from: number, to: number, factoryLogs: Log[]): Promise<{ rows: SwapRow[]; logs: Log[] }> {
    const dep = getDeploymentV31(this.config.chainId);
    const manager = managerOf(dep);
    if (!manager) return { rows: [], logs: [] };
    const pools = await this.pools(factoryLogs);
    if (!pools.size) return { rows: [], logs: [] };
    const ids = [...pools.keys()] as Hex[];
    const swaps: Log[] = [];
    for (let i = 0; i < ids.length; i += 50) {
      swaps.push(...await this.client.getLogs({ address: manager, event: SWAP_EVENT, args: { id: ids.slice(i, i + 50) }, fromBlock: BigInt(from), toBlock: BigInt(to) }));
    }
    if (!swaps.length) return { rows: [], logs: [] };
    const router = routerOf(dep);
    const routed = router && swaps.some((l: any) => getAddress(l.args.sender) === router)
      ? await this.client.getLogs({ address: router, event: SWAPPED_EVENT, fromBlock: BigInt(from), toBlock: BigInt(to) }) : [];
    const order = (a: Log, b: Log) => Number(a.blockNumber! - b.blockNumber!) || a.logIndex! - b.logIndex!;
    // Router events follow their PoolManager swap in the same transaction; pair them in order per (tx, pool).
    const queue = new Map<string, any[]>();
    for (const l of [...routed].sort(order) as any[]) {
      const key = `${l.transactionHash}:${String(l.args.poolId).toLowerCase()}`;
      queue.set(key, [...(queue.get(key) ?? []), l.args]);
    }
    const rows: SwapRow[] = [];
    for (const l of [...swaps].sort(order) as any[]) {
      const a = l.args;
      const pool = pools.get(String(a.id).toLowerCase());
      if (!pool) continue;
      const sender = getAddress(a.sender);
      const attributed = router && sender === router ? queue.get(`${l.transactionHash}:${pool.poolId}`)?.shift() : undefined;
      const token0 = pool.tokenIsCurrency0 === 1;
      const tokenDelta = BigInt(token0 ? a.amount0 : a.amount1);
      const quoteDelta = BigInt(token0 ? a.amount1 : a.amount0);
      // Deltas are the swapper's: negative is paid into the pool.
      const side = quoteDelta < 0n ? 'buy' : 'sell';
      const amountQuote = quoteDelta < 0n ? -quoteDelta : quoteDelta;
      const amountToken = tokenDelta < 0n ? -tokenDelta : tokenDelta;
      rows.push({
        raiseAddr: pool.raiseAddr, poolId: pool.poolId, side, amountQuote: amountQuote.toString(), amountToken: amountToken.toString(),
        price: executionPriceE18(amountQuote, amountToken).toString(), spot: spotPriceE18(BigInt(a.sqrtPriceX96), token0).toString(),
        sqrtPriceX96: String(a.sqrtPriceX96), liquidity: String(a.liquidity), tick: Number(a.tick), fee: Number(a.fee), sender,
        trader: attributed ? getAddress(attributed.trader) : sender, recipient: attributed ? getAddress(attributed.recipient) : null,
        viaRouter: attributed ? 1 : 0, txHash: l.transactionHash, blockNumber: Number(l.blockNumber), logIndex: Number(l.logIndex),
      });
    }
    return { rows, logs: [...swaps, ...routed] };
  }

  insert(rows: SwapRow[], timestamps: Map<number, number>): void {
    const q = this.db.query('INSERT OR IGNORE INTO v31_pool_swaps VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
    for (const r of rows) {
      q.run(r.raiseAddr, r.poolId, r.side, r.amountQuote, r.amountToken, r.price, r.spot, r.sqrtPriceX96, r.liquidity, r.tick, r.fee,
        r.sender, r.trader, r.recipient, r.viaRouter, timestamps.get(r.blockNumber)!, r.txHash, r.blockNumber, r.logIndex);
    }
  }

  rollback(from: number): void {
    this.db.query('DELETE FROM v31_pool_swaps WHERE blockNumber >= ?').run(from);
  }
}

// ---------------------------------------------------------------------------------------------- reads

interface StoredSwap extends SwapRow { timestamp: number }

function poolOf(db: DB, raise: string): PoolRow | null {
  return db.query('SELECT * FROM v31_pools WHERE raiseAddr = ?').get(raise) as PoolRow | null;
}
function swapsOf(db: DB, raise: string): StoredSwap[] {
  return db.query('SELECT * FROM v31_pool_swaps WHERE raiseAddr = ? ORDER BY blockNumber, logIndex').all(raise) as StoredSwap[];
}
function listingOf(db: DB, raise: string): { time: number; price: bigint; blockNumber: number; logIndex: number; txHash: string } | null {
  const row = db.query("SELECT timestamp, price, blockNumber, logIndex, txHash FROM v31_prices WHERE raiseAddr = ? AND event = 'ListingFinalized' ORDER BY blockNumber DESC LIMIT 1").get(raise) as
    { timestamp: number; price: string | null; blockNumber: number; logIndex: number; txHash: string } | null;
  return row && row.price ? { time: row.timestamp, price: BigInt(row.price), blockNumber: row.blockNumber, logIndex: row.logIndex, txHash: row.txHash } : null;
}

/** Stage 2 book history (with its market-trade volume), then the listing and every pool swap. */
export function chartPoints(db: DB, raise: string): { points: PricePoint[]; listing: ReturnType<typeof listingOf> } {
  const listing = listingOf(db, raise);
  const book = db.query(`SELECT p.timestamp, p.price, p.event, p.blockNumber, p.logIndex, t.type, t.quote FROM v31_prices p
    LEFT JOIN v31_trades t ON t.txHash = p.txHash AND t.logIndex = p.logIndex
    WHERE p.raiseAddr = ? AND p.kind = 'book' AND p.price IS NOT NULL ORDER BY p.blockNumber, p.logIndex`).all(raise) as
    { timestamp: number; price: string; event: string; blockNumber: number; logIndex: number; type: string | null; quote: string | null }[];
  const points: PricePoint[] = [];
  for (const r of book) {
    if (listing && (r.blockNumber > listing.blockNumber || (r.blockNumber === listing.blockNumber && r.logIndex >= listing.logIndex))) break;
    const trade = r.type === 'buy' || r.type === 'sell';
    points.push({ time: r.timestamp, price: BigInt(r.price), volume: trade ? BigInt(r.quote ?? 0) : 0n, venue: 'stage2', trade });
  }
  if (listing) {
    points.push({ time: listing.time, price: listing.price, volume: 0n, venue: 'pool', trade: false });
    for (const s of swapsOf(db, raise)) points.push({ time: s.timestamp, price: BigInt(s.spot), volume: BigInt(s.amountQuote), venue: 'pool', trade: true });
  }
  return { points, listing };
}

export interface MarketDeps { config: Config; db: DB; clients: Clients }

/** Live pool state at one block: slot0 price and active liquidity, read from PoolManager storage. */
async function poolState(client: PublicClient, manager: Address, poolId: Hex, blockNumber: bigint) {
  const base = keccak256(concat([poolId, POOLS_SLOT]));
  const [slot0, liquidity] = await Promise.all([
    client.getStorageAt({ address: manager, slot: base, blockNumber }),
    client.getStorageAt({ address: manager, slot: pad(toHex(BigInt(base) + 3n), { size: 32 }), blockNumber }),
  ]);
  return { sqrtPriceX96: BigInt(slot0 ?? 0) & ((1n << 160n) - 1n), liquidity: BigInt(liquidity ?? 0) & ((1n << 128n) - 1n) };
}

export async function marketRow(deps: MarketDeps, row: RaiseV31Row, blockNumber: bigint, now: number) {
  const { db, clients, config } = deps;
  const dep = getDeploymentV31(config.chainId);
  const manager = managerOf(dep);
  const pool = poolOf(db, row.address);
  const listing = listingOf(db, row.address);
  const swaps = swapsOf(db, row.address);
  const token0 = pool?.tokenIsCurrency0 === 1;
  const [state, totalSupply] = await Promise.all([
    manager && pool ? poolState(clients.public, manager, pool.poolId as Hex, blockNumber) : Promise.resolve({ sqrtPriceX96: 0n, liquidity: 0n }),
    clients.public.readContract({ address: row.token as Address, abi: ABIS.ProjectTokenV31Abi, functionName: 'totalSupply', blockNumber }) as Promise<bigint>,
  ]);
  const listingPrice = listing?.price ?? BigInt(JSON.parse(row.state).listingPrice ?? 0);
  const price = state.sqrtPriceX96 ? spotPriceE18(state.sqrtPriceX96, token0) : listingPrice;
  const history = [{ time: listing?.time ?? 0, price: listingPrice }, ...swaps.map((s) => ({ time: s.timestamp, price: BigInt(s.spot) }))];
  const reference = priceAt(history, now - DAY, listingPrice);
  const { amount0, amount1 } = fullRangeAmounts(state.liquidity, state.sqrtPriceX96);
  const [tokenReserve, quoteReserve] = token0 ? [amount0, amount1] : [amount1, amount0];
  const liquidity = quoteReserve + tokenReserve * price / PRICE_SHIFT;
  const volume24h = swaps.filter((s) => s.timestamp > now - DAY).reduce((sum, s) => sum + BigInt(s.amountQuote), 0n);
  // Sparkline: 48 samples of the last price over the last 30 days (or since listing).
  const start = Math.max(listing?.time ?? now, now - 30 * DAY);
  const spark = Array.from({ length: 48 }, (_, i) => decimal(priceAt(history, start + Math.round((now - start) * i / 47), listingPrice), 18));
  const stored = (db.query('SELECT profile FROM v31_profiles WHERE raiseAddr=?').get(row.address) as { profile: string } | null)?.profile;
  return {
    address: row.address, name: row.name, symbol: row.symbol, token: row.token,
    profile: { ...profileFromRow(stored, '', ''), ...storedProfileImage(stored, config) },
    poolId: pool?.poolId ?? null, tokenIsCurrency0: token0, fee: 10000, tickSpacing: 200,
    price: decimal(price, 18), listingPrice: decimal(listingPrice, 18),
    change24hBps: reference > 0n ? Number((price - reference) * 10000n / reference) : 0,
    volume24h: decimal(volume24h, 6), liquidity: decimal(liquidity, 6),
    reserves: { quote: decimal(quoteReserve, 6), token: decimal(tokenReserve, 18) },
    totalSupply: totalSupply.toString(), fdv: decimal(price * totalSupply / PRICE_SHIFT, 6),
    tradeCount: swaps.length, listedAt: listing?.time ?? null, lastTradeAt: swaps.at(-1)?.timestamp ?? null, spark,
  };
}

export function poolTrade(s: StoredSwap) {
  return {
    time: s.timestamp, side: s.side, price: decimal(BigInt(s.price), 18), spotPrice: decimal(BigInt(s.spot), 18),
    amountQuote: decimal(BigInt(s.amountQuote), 6), amountToken: decimal(BigInt(s.amountToken), 18),
    amountQuoteRaw: s.amountQuote, amountTokenRaw: s.amountToken, trader: s.trader, sender: s.sender, recipient: s.recipient,
    viaRouter: s.viaRouter === 1, txHash: s.txHash, blockNumber: s.blockNumber, logIndex: s.logIndex,
  };
}

// ---------------------------------------------------------------------------------------------- routes

const error = (c: Context, status: number, code: string, message: string) => c.json({ error: { code, message } }, status as never);

export function createMarketV31App(deps: MarketDeps): Hono {
  const { db, clients, config } = deps;
  migrateMarketV31(db);
  const app = new Hono();
  const raiseOf = (c: Context) => {
    const address = c.req.param('address') ?? '';
    if (!isAddress(address)) return { fail: error(c, 400, 'INVALID_ADDRESS', 'invalid raise address') };
    const row = getRaiseV31(db, address);
    return row ? { row } : { fail: error(c, 404, 'RAISE_NOT_FOUND', 'v3.1 raise not indexed') };
  };
  const head = async () => {
    const b = await clients.public.getBlock({ blockTag: 'latest' });
    return { blockNumber: b.number, now: Number(b.timestamp) };
  };
  const venue = () => {
    const dep = getDeploymentV31(config.chainId);
    return { router: routerOf(dep), poolManager: managerOf(dep), quote: dep ? live(dep.quote ?? dep.mockUSDG) : null };
  };
  const guard = async (c: Context, fn: () => Promise<Response>) => {
    try { return await fn(); } catch { return error(c, 503, 'CHAIN_UNAVAILABLE', 'Chain request failed'); }
  };
  const listed = () => listRaisesV31(db).filter((r) => Number(JSON.parse(r.state).phase) === 3);

  app.get('/markets', (c) => guard(c, async () => {
    const { blockNumber, now } = await head();
    const markets = await Promise.all(listed().map((r) => marketRow(deps, r, blockNumber, now)));
    return c.json({ ...venue(), chainTime: now, blockNumber: Number(blockNumber), markets });
  }));
  app.get('/markets/:address', (c) => guard(c, async () => {
    const r = raiseOf(c);
    if ('fail' in r) return r.fail!;
    if (Number(JSON.parse(r.row.state).phase) !== 3) return error(c, 404, 'NOT_LISTED', 'project has not reached Stage 3 · Open market');
    const { blockNumber, now } = await head();
    return c.json({ ...venue(), chainTime: now, blockNumber: Number(blockNumber), market: await marketRow(deps, r.row, blockNumber, now) });
  }));
  app.get('/raises/:address/candles', (c) => {
    const r = raiseOf(c);
    if ('fail' in r) return r.fail!;
    const interval = (c.req.query('interval') ?? '1h') as Interval;
    if (!(interval in INTERVALS)) return error(c, 400, 'BAD_REQUEST', `interval must be one of ${Object.keys(INTERVALS).join(', ')}`);
    const bound = (key: string) => {
      const v = c.req.query(key);
      if (v === undefined || v === '') return undefined;
      const n = Number(v);
      return Number.isSafeInteger(n) && n >= 0 ? n : NaN;
    };
    const from = bound('from'), to = bound('to');
    if (Number.isNaN(from) || Number.isNaN(to)) return error(c, 400, 'BAD_REQUEST', 'from and to must be unix seconds');
    const { points, listing } = chartPoints(db, r.row.address);
    return c.json({
      raise: r.row.address, interval, seconds: INTERVALS[interval],
      listing: listing ? { time: listing.time, price: decimal(listing.price, 18), txHash: listing.txHash, poolId: poolOf(db, r.row.address)?.poolId ?? null } : null,
      candles: buildCandles(points, INTERVALS[interval], from, to),
    });
  });
  app.get('/raises/:address/pool-trades', (c) => {
    const r = raiseOf(c);
    if ('fail' in r) return r.fail!;
    const limit = Math.max(1, Math.min(500, Math.floor(Number(c.req.query('limit')) || 100)));
    const rows = db.query('SELECT * FROM v31_pool_swaps WHERE raiseAddr = ? ORDER BY blockNumber DESC, logIndex DESC LIMIT ?').all(r.row.address, limit) as StoredSwap[];
    return c.json(rows.map(poolTrade));
  });
  return app;
}
