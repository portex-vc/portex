/** Secondary market: pure candle/price math, then a disposable real-v4 chain (never the demo ports or database). */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawn, spawnSync, type Subprocess } from 'bun';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { Hono } from 'hono';
import { getAddress, type Address } from 'viem';
import { openDb, type DB } from '../src/db.ts';
import { loadConfig } from '../src/config.ts';
import { makeClients } from '../src/chain.ts';
import { IndexerV31 } from '../src/v31/indexer.ts';
import { AnalystV31 } from '../src/v31/analyst.ts';
import { createV31App } from '../src/v31/api.ts';
import {
  buildCandles, decimal, executionPriceE18, fullRangeAmounts, priceAt, spotPriceE18, SQRT_LOWER, SQRT_UPPER, type PricePoint,
} from '../src/v31/market.ts';
import { PortexSwapRouterV31Abi } from '../src/generated/v31-abis.ts';
import { A, V31Context, RaiseV31, usd, DAY } from '@portex/tools/lib/v31';
import { DEPLOYER, snapshot, revert } from '@portex/tools/lib/chain';

const E18 = 10n ** 18n;
const Q96 = 2n ** 96n;
const isqrt = (n: bigint) => { if (n < 2n) return n; let x = n, y = (x + 1n) / 2n; while (y < x) { x = y; y = (x + n / x) / 2n; } return x; };

describe('market math', () => {
  test('decimal strings trim zeros and keep full precision', () => {
    expect(decimal(0n, 18)).toBe('0');
    expect(decimal(10n ** 17n, 18)).toBe('0.1');
    expect(decimal(123456789n, 6)).toBe('123.456789');
    expect(decimal(-2500000n, 6)).toBe('-2.5');
    expect(decimal(1n, 18)).toBe('0.000000000000000001');
  });
  test('spot price is USDG per whole token in both currency orders', () => {
    // 0.1 USDG per token = 1e5 raw USDG per 1e18 raw token = 1e-13 raw ratio.
    const tokenFirst = isqrt(Q96 * Q96 / 10n ** 13n);
    expect(Number(spotPriceE18(tokenFirst, true)) / 1e18).toBeCloseTo(0.1, 9);
    const quoteFirst = isqrt(Q96 * Q96 * 10n ** 13n);
    expect(Number(spotPriceE18(quoteFirst, false)) / 1e18).toBeCloseTo(0.1, 9);
    expect(spotPriceE18(0n, true)).toBe(0n);
    expect(executionPriceE18(usd(50), 500n * E18)).toBe(10n ** 17n);
    expect(executionPriceE18(1n, 0n)).toBe(0n);
  });
  test('full-range reserves are bounded and move with price', () => {
    const L = 10n ** 18n;
    const at1 = fullRangeAmounts(L, Q96);
    expect(at1.amount1).toBe(L * (Q96 - SQRT_LOWER) / Q96);
    expect(at1.amount0).toBe(L * Q96 * (SQRT_UPPER - Q96) / Q96 / SQRT_UPPER);
    const higher = fullRangeAmounts(L, 2n * Q96);
    expect(higher.amount1).toBeGreaterThan(at1.amount1);
    expect(higher.amount0).toBeLessThan(at1.amount0);
    expect(fullRangeAmounts(0n, Q96)).toEqual({ amount0: 0n, amount1: 0n });
  });
  test('candles open at the previous close, omit empty buckets and split the listing bucket by venue', () => {
    const p = (time: number, price: string, venue: 'stage2' | 'pool', volume = 0n, trade = true): PricePoint =>
      ({ time, price: BigInt(Math.round(Number(price) * 1e6)) * 10n ** 12n, volume, venue, trade });
    const points = [
      p(3600, '0.10', 'stage2', 0n, false), p(3700, '0.12', 'stage2', usd(100)), p(3800, '0.11', 'stage2', usd(40)),
      // Nothing in the 2h bucket.
      p(3 * 3600 + 5, '0.13', 'stage2', usd(10)),
      p(3 * 3600 + 900, '0.14', 'pool', 0n, false), p(3 * 3600 + 1000, '0.15', 'pool', usd(7)),
      p(5 * 3600, '0.12', 'pool', usd(3)),
    ];
    const c = buildCandles(points, 3600);
    expect(c.map((x) => [x.time, x.venue])).toEqual([[3600, 'stage2'], [10800, 'stage2'], [10800, 'pool'], [18000, 'pool']]);
    expect(c[0]).toEqual({ time: 3600, open: '0.1', high: '0.12', low: '0.1', close: '0.11', volume: '140', trades: 2, venue: 'stage2' });
    // Continuity: the next Stage 2 bucket opens at the last Stage 2 close.
    expect(c[1]).toMatchObject({ open: '0.11', high: '0.13', low: '0.11', close: '0.13', trades: 1 });
    // The pool opens at the listing price (a non-trade point), and its next bucket at its last close.
    expect(c[2]).toMatchObject({ open: '0.14', high: '0.15', low: '0.14', close: '0.15', volume: '7', trades: 1 });
    expect(c[3]).toMatchObject({ open: '0.15', high: '0.15', low: '0.12', close: '0.12', volume: '3' });
    expect(buildCandles(points, 3600, 10800, 10800).map((x) => x.venue)).toEqual(['stage2', 'pool']);
    expect(buildCandles(points, 86400)).toHaveLength(2);
    expect(buildCandles([], 60)).toEqual([]);
  });
  test('price at a time falls back before the first point', () => {
    const pts = [{ time: 10, price: 5n }, { time: 20, price: 7n }];
    expect(priceAt(pts, 5, 1n)).toBe(1n);
    expect(priceAt(pts, 10, 1n)).toBe(5n);
    expect(priceAt(pts, 25, 1n)).toBe(7n);
  });
});

describe('market on a real v4 fixture chain', () => {
  let anvil: Subprocess | undefined;
  let server: ReturnType<typeof Bun.serve> | undefined;
  let db: DB; let ctx: V31Context; let indexer: IndexerV31; let apiUrl: string;
  let raise: RaiseV31; let router: Address; let token: Address;
  const port = 18745;
  const rpc = `http://127.0.0.1:${port}`;
  const root = resolve(import.meta.dir, '../../..');
  const workspace = resolve(root, 'apps/api/data/market-fixture');
  const originalDir = process.env.PORTEX_DEPLOYMENTS_DIR;
  const clone = '0x00000000000000000000000000000000c10e0001' as Address;
  const deadline = () => BigInt(Math.floor(Date.now() / 1000) + 400 * DAY);
  const swap = async (actor: any, via: Address, buy: boolean, amount: bigint) => {
    const quote = await ctx.client.simulateContract({ address: via, abi: PortexSwapRouterV31Abi, functionName: 'quoteExactIn', args: [token, buy, amount], account: actor.account });
    const receipt = await ctx.write(actor, via, PortexSwapRouterV31Abi, 'swapExactIn', [token, buy, amount, quote.result, actor.address, deadline()]);
    return { receipt, out: quote.result as bigint };
  };
  const sync = async () => { indexer.stop(); await indexer.poll(); };

  beforeAll(async () => {
    if (await fetch(rpc, { method: 'POST', body: '{}' }).then(() => true).catch(() => false)) throw new Error(`fixture port ${port} is occupied`);
    mkdirSync(workspace, { recursive: true });
    anvil = spawn([`${process.env.HOME}/.foundry/bin/anvil`, '--port', String(port), '--chain-id', '31337', '--silent'], { stdout: 'ignore', stderr: 'inherit' });
    for (let n = 0; n < 100; n++) {
      if (await fetch(rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' }).then((r) => r.ok).catch(() => false)) break;
      await Bun.sleep(100);
    }
    const deploy = spawnSync(['bash', 'packages/contracts/scripts/deploy-local.sh'], { cwd: root, env: { ...process.env, RPC_URL: rpc, DEPLOY_WORKSPACE: workspace }, timeout: 240000 });
    if (deploy.exitCode) throw new Error(deploy.stderr.toString());
    process.env.PORTEX_DEPLOYMENTS_DIR = resolve(workspace, 'deployments');
    const config = loadConfig({ RPC_URL: rpc, DATABASE_PATH: ':memory:', POLL_MS: '50', PORTEX_CHAIN_ID: '31337' });
    db = openDb(':memory:'); const clients = makeClients(config);
    indexer = new IndexerV31(db, clients.public, config);
    const app = new Hono();
    app.route('/v2', createV31App({ config, db, clients, indexer, analyst: new AnalystV31(db, clients, config) }));
    server = Bun.serve({ port: 0, fetch: app.fetch }); apiUrl = `http://127.0.0.1:${server.port}`;
    ctx = new V31Context(rpc, apiUrl); indexer.start(); await ctx.waitIndexed();
    router = getAddress(ctx.deployment.router);
    for (const actor of [...ctx.backers, ctx.buyer]) await ctx.fund(actor);
    raise = await RaiseV31.create(ctx, 'Market Fixture', 'MKT', false, 35);
    token = raise.modules.token;
    await raise.fill(); await raise.open();
    // Stage 2 book trades: the chart's first venue.
    await raise.buy(ctx.buyer, usd(4000)); await ctx.warp(DAY);
    await raise.buy(ctx.buyer, usd(6000)); await ctx.warp(DAY);
    await raise.guarded(ctx.buyer, 'sell', [(await raise.read('buyerTokens', [ctx.buyer.address])) / 10n, 0n]);
    await ctx.warpTo((await raise.read('stageDeadlines')).stage2End);
    await raise.action(DEPLOYER, 'list');
    for (const actor of [ctx.buyer, ctx.backers[0]]) {
      await ctx.write(actor, ctx.quote, A.MockUSDGV31Abi, 'approve', [router, 2n ** 255n]);
      await ctx.write(actor, token, A.ProjectTokenV31Abi, 'approve', [router, 2n ** 255n]);
    }
    await ctx.waitIndexed();
  }, 300000);

  afterAll(async () => {
    indexer?.stop(); if (indexer) await indexer.poll(); server?.stop(true); anvil?.kill(); if (anvil) await anvil.exited; db?.close();
    if (originalDir === undefined) delete process.env.PORTEX_DEPLOYMENTS_DIR; else process.env.PORTEX_DEPLOYMENTS_DIR = originalDir;
  });

  test('local deployment mirrors testnet: real PoolManager, adapter and router in config', async () => {
    const cfg = await ctx.api('/v2/config');
    expect(cfg.addresses.router).toBe(router);
    expect(cfg.addresses.poolManager).toBe(getAddress(ctx.deployment.poolManager));
    expect(cfg.addresses.adapter).toBe(getAddress(ctx.deployment.adapter));
    expect(ctx.deployment.mockV4Adapter).toBeUndefined();
    const market = await ctx.api('/v2/markets');
    expect(market.router).toBe(router);
    expect(market.markets.map((m: any) => m.address)).toEqual([raise.address]);
    expect(market.markets[0].tradeCount).toBe(0);
    // The pool stores the listing price as a floored sqrt price: equal to 1e-9 relative.
    const { price, listingPrice } = market.markets[0];
    expect(Math.abs(Number(price) - Number(listingPrice)) / Number(listingPrice)).toBeLessThan(1e-9);
  });

  test('router swaps are indexed with the real trader; other routers show their sender', async () => {
    const buy = await swap(ctx.buyer, router, true, usd(2500));
    await ctx.warp(3600);
    const holderTokens = (await ctx.read<bigint>(token, A.ProjectTokenV31Abi, 'balanceOf', [ctx.backers[0].address])) / 5n;
    const quota = await ctx.read<bigint>(token, A.ProjectTokenV31Abi, 'quotaOf', [ctx.backers[0].address]);
    const sell = await swap(ctx.backers[0], router, false, holderTokens);
    // Selling quota-carrying tokens destroys quota through the token's own transfer rules.
    expect(await ctx.read<bigint>(token, A.ProjectTokenV31Abi, 'quotaOf', [ctx.backers[0].address])).toBe(quota - (holderTokens < quota ? holderTokens : quota));
    // An identical router at another address: its trades are attributed to that contract, not a person.
    await ctx.client.request({ method: 'anvil_setCode', params: [clone, await ctx.client.getCode({ address: router })] } as never);
    await ctx.write(ctx.buyer, ctx.quote, A.MockUSDGV31Abi, 'approve', [clone, usd(500)]);
    await ctx.warp(3600);
    const other = await swap(ctx.buyer, clone, true, usd(500));
    await ctx.waitIndexed();
    const trades = await ctx.api(`/v2/raises/${raise.address}/pool-trades?limit=10`);
    expect(trades.map((t: any) => t.side)).toEqual(['buy', 'sell', 'buy']);
    const [outside, sold, bought] = trades;
    expect(bought).toMatchObject({ trader: ctx.buyer.address, sender: router, recipient: ctx.buyer.address, viaRouter: true, txHash: buy.receipt.transactionHash });
    expect(bought.amountQuote).toBe('2500');
    expect(BigInt(bought.amountTokenRaw)).toBe(buy.out);
    expect(Number(bought.price)).toBeCloseTo(2500 / Number(decimal(buy.out, 18)), 9);
    expect(sold).toMatchObject({ trader: ctx.backers[0].address, viaRouter: true, amountQuoteRaw: String(sell.out), amountTokenRaw: String(holderTokens) });
    expect(outside).toMatchObject({ trader: clone, sender: clone, recipient: null, viaRouter: false, txHash: other.receipt.transactionHash });
    // Buying lifts the spot price above the average fill of the next sell.
    expect(Number(bought.spotPrice)).toBeGreaterThan(Number(sold.price));
  });

  test('candles carry the Stage 2 book into the pool with the listing marked', async () => {
    const res = await ctx.api(`/v2/raises/${raise.address}/candles?interval=1h`);
    const listing = (await ctx.api(`/v2/raises/${raise.address}/price-history`)).find((p: any) => p.event === 'ListingFinalized');
    expect(res.listing.price).toBe(decimal(BigInt(listing.price), 18));
    expect(res.listing.time).toBe(listing.timestamp);
    expect(res.listing.poolId).toBe((await ctx.read<string>(raise.address, A.RaiseCoreAbi, 'listingRecord')).poolId.toLowerCase());
    const stage2 = res.candles.filter((c: any) => c.venue === 'stage2');
    const pool = res.candles.filter((c: any) => c.venue === 'pool');
    expect(stage2.length).toBeGreaterThanOrEqual(3);
    expect(stage2.every((c: any) => c.time <= res.listing.time)).toBe(true);
    expect(stage2.reduce((s: number, c: any) => s + c.trades, 0)).toBe(3);
    expect(stage2.reduce((s: number, c: any) => s + Number(c.volume), 0)).toBeGreaterThan(9000);
    expect(pool[0].open).toBe(res.listing.price);
    expect(pool.reduce((s: number, c: any) => s + c.trades, 0)).toBe(3);
    const trades = await ctx.api(`/v2/raises/${raise.address}/pool-trades`);
    expect(pool.reduce((s: number, c: any) => s + Number(c.volume), 0)).toBeCloseTo(trades.reduce((s: number, t: any) => s + Number(t.amountQuote), 0), 6);
    expect(pool.at(-1).close).toBe(trades[0].spotPrice);
    for (let i = 1; i < res.candles.length; i++) expect(res.candles[i].time).toBeGreaterThanOrEqual(res.candles[i - 1].time);
    for (const c of res.candles) {
      expect(Number(c.high)).toBeGreaterThanOrEqual(Math.max(Number(c.open), Number(c.close)));
      expect(Number(c.low)).toBeLessThanOrEqual(Math.min(Number(c.open), Number(c.close)));
    }
    const day = await ctx.api(`/v2/raises/${raise.address}/candles?interval=1d&from=${res.listing.time}`);
    expect(day.candles.every((c: any) => c.time >= Math.floor(res.listing.time / 86400) * 86400)).toBe(true);
    expect((await fetch(`${apiUrl}/v2/raises/${raise.address}/candles?interval=2h`)).status).toBe(400);
    expect((await fetch(`${apiUrl}/v2/raises/${raise.address}/candles?from=abc`)).status).toBe(400);
    expect((await fetch(`${apiUrl}/v2/raises/nope/pool-trades`)).status).toBe(400);
    expect((await fetch(`${apiUrl}/v2/raises/0x0000000000000000000000000000000000000001/candles`)).status).toBe(404);
  });

  test('markets row: live price, 24h change and volume, liquidity and FDV', async () => {
    const { markets, chainTime } = await ctx.api('/v2/markets');
    const m = markets[0];
    const trades = await ctx.api(`/v2/raises/${raise.address}/pool-trades`);
    expect(m.price).toBe(trades[0].spotPrice);
    expect(m.tradeCount).toBe(3);
    expect(Number(m.volume24h)).toBeCloseTo(trades.filter((t: any) => t.time > chainTime - 86400).reduce((s: number, t: any) => s + Number(t.amountQuote), 0), 6);
    expect(Math.abs(m.change24hBps - (Number(m.price) - Number(m.listingPrice)) / Number(m.listingPrice) * 10000)).toBeLessThanOrEqual(1);
    expect(m.change24hBps).toBeGreaterThan(0);
    const supply = await ctx.read<bigint>(token, A.ProjectTokenV31Abi, 'totalSupply');
    expect(m.totalSupply).toBe(String(supply));
    expect(Number(m.fdv)).toBeCloseTo(Number(m.price) * Number(decimal(supply, 18)), 0);
    expect(Number(m.liquidity)).toBeGreaterThan(Number(m.reserves.quote));
    expect(Number(m.reserves.quote)).toBeGreaterThan(0);
    expect(m.spark).toHaveLength(48);
    expect(m.spark.at(-1)).toBe(m.price);
    expect(m.listedAt).toBeGreaterThan(0);
    const detail = await ctx.api(`/v2/markets/${raise.address}`);
    expect(detail.market.poolId).toBe(m.poolId);
    // A day later the reference moves to the last trade before the window.
    await ctx.warp(DAY + 60); await ctx.waitIndexed();
    const later = (await ctx.api('/v2/markets')).markets[0];
    expect(later.volume24h).toBe('0');
    expect(later.change24hBps).toBe(0);
  });

  test('reorged swaps are removed and replacements indexed', async () => {
    await sync();
    const base = await snapshot(ctx.client);
    const orphan = await swap(ctx.buyer, router, true, usd(111));
    await ctx.client.request({ method: 'anvil_mine', params: ['0x4'] } as never);
    await indexer.poll();
    const withOrphan = await ctx.api(`/v2/raises/${raise.address}/pool-trades`);
    expect(withOrphan[0].txHash).toBe(orphan.receipt.transactionHash);
    await revert(ctx.client, base);
    const replacement = await swap(ctx.buyer, router, true, usd(222));
    await ctx.client.request({ method: 'anvil_mine', params: ['0x8'] } as never);
    await indexer.poll();
    expect(indexer.status.lastError).toBeNull();
    const after = await ctx.api(`/v2/raises/${raise.address}/pool-trades`);
    expect(after.some((t: any) => t.txHash === orphan.receipt.transactionHash)).toBe(false);
    expect(after[0]).toMatchObject({ txHash: replacement.receipt.transactionHash, amountQuote: '222', trader: ctx.buyer.address });
    expect(after).toHaveLength(4);
    expect((db.query('SELECT COUNT(*) AS n FROM v31_pool_swaps').get() as any).n).toBe(4);
    indexer.start();
  }, 60000);
});
