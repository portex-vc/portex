/** Disposable chain fixture; never connects to the demo ports or database. */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawn, spawnSync, type Subprocess } from 'bun';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { openDb, type DB } from '../src/db.ts';
import { loadConfig } from '../src/config.ts';
import { makeClients } from '../src/chain.ts';
import { Indexer } from '../src/indexer.ts';
import { Analyst } from '../src/analyst/index.ts';
import { createCombinedApp } from '../src/server-v2.ts';
import { IndexerV31, curvePrice } from '../src/v31/indexer.ts';
import { AnalystV31 } from '../src/v31/analyst.ts';
import { effectivePhase, LiveV31, typed } from '../src/v31/live.ts';
import { StateV31 } from '../src/v31/snapshot.ts';
import { withRpcTally } from '../src/lib/rpc-metrics.ts';
import { Database } from 'bun:sqlite';
import type { Scorer, ScorerInput } from '../src/analyst/types.ts';
import { loadIsolatedV1Deployment } from '../src/v31/deployment.ts';
import { listRaisesV31, positionIds } from '../src/v31/db.ts';
import { seedV31 } from '@portex/tools/seed-v31';
import { A, V31Context, RaiseV31, usd, DAY, backer } from '@portex/tools/lib/v31';
import { BUILDER, snapshot, revert } from '@portex/tools/lib/chain';
import { signRequest } from '../src/lib/signed-request.ts';

test('v3.1 phase respects the inclusive deadline and terminal states', () => {
  expect(effectivePhase(1, { stage2End: 100 }, 99)).toBe('Stage2');
  expect(effectivePhase(1, { stage2End: 100 }, 100)).toBe('ListingPending');
  expect(effectivePhase(0, { stage2End: 0 }, 200)).toBe('Stage1');
  expect(effectivePhase(3, { stage2End: 100 }, 200)).toBe('Stage3');
  expect(effectivePhase(4, { stage2End: 100 }, 200)).toBe('Dissolved');
});
test('v3.1 Stage 1 marginal price preserves rational kappa', () => {
  const cfg = { supply: '1000', targetPrice: '101' };
  expect(curvePrice(cfg, 0n)).toBe(67n);
  expect(curvePrice(cfg, 100n)).toBe(84n);
  expect(curvePrice(cfg, 200n)).toBe(101n);
});
describe('v2 fixture chain', () => {
  let anvil: Subprocess | undefined;
  let server: ReturnType<typeof Bun.serve> | undefined;
  let db: DB; let ctx: V31Context; let indexer: IndexerV31; let apiUrl: string;
  let seeds: Awaited<ReturnType<typeof seedV31>>;
  const rpc = 'http://127.0.0.1:18546';
  const root = resolve(import.meta.dir, '../../..');
  const workspace = resolve(root, 'apps/api/data/v31-fixture');
  const originalDir = process.env.PORTEX_DEPLOYMENTS_DIR;
  const originalResults = process.env.PORTEX_RESULTS_DIR;
  const originalMetrics = process.env.RPC_METRICS;
  let clients: ReturnType<typeof makeClients>; let config: ReturnType<typeof loadConfig>;
  const seed = (symbol: string) => seeds.find((r) => r.symbol === symbol)!;
  const path = (symbol: string) => `/v2/raises/${seed(symbol).address}`;
  async function isolated(fn: () => Promise<void>) {
    indexer.stop(); await indexer.poll();
    const snap = await snapshot(ctx.client);
    try { await fn(); }
    finally { await revert(ctx.client, snap); await indexer.poll(); indexer.start(); }
  }
  beforeAll(async () => {
    if (await fetch(rpc, { method: 'POST', body: '{}' }).then(() => true).catch(() => false)) throw new Error('fixture port 18546 is occupied');
    mkdirSync(workspace, { recursive: true });
    anvil = spawn([`${process.env.HOME}/.foundry/bin/anvil`, '--port', '18546', '--chain-id', '31337', '--silent'], { stdout: 'ignore', stderr: 'inherit' });
    for (let n = 0; n < 100; n++) {
      if (await fetch(rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' }).then((r) => r.ok).catch(() => false)) break;
      await Bun.sleep(100);
    }
    const deploy = spawnSync(['bash', 'packages/contracts/scripts/deploy-local.sh'], { cwd: root, env: { ...process.env, RPC_URL: rpc, DEPLOY_WORKSPACE: workspace }, timeout: 240000 });
    if (deploy.exitCode) throw new Error(deploy.stderr.toString());
    process.env.PORTEX_DEPLOYMENTS_DIR = resolve(workspace, 'deployments');
    process.env.PORTEX_RESULTS_DIR = resolve(workspace, 'results');
    loadIsolatedV1Deployment(31337);
    config = loadConfig({ RPC_URL: rpc, DATABASE_PATH: ':memory:', POLL_MS: '50', PORTEX_CHAIN_ID: '31337' });
    // Per-request RPC accounting (X-Rpc-Calls) proves the read endpoints never touch the chain.
    process.env.RPC_METRICS = '1';
    db = openDb(':memory:'); clients = makeClients(config);
    indexer = new IndexerV31(db, clients.public, config);
    const app = createCombinedApp({ config, db, clients, indexer: new Indexer(db, clients.public, config), analyst: new Analyst(db, clients, config) },
      { config, db, clients, indexer, analyst: new AnalystV31(db, clients, config) });
    server = Bun.serve({ port: 0, fetch: app.fetch }); apiUrl = `http://127.0.0.1:${server.port}`;
    ctx = new V31Context(rpc, apiUrl); indexer.start(); await ctx.waitIndexed();
    seeds = await seedV31(rpc, apiUrl);
  }, 240000);
  afterAll(async () => {
    indexer?.stop(); if (indexer) await indexer.poll(); server?.stop(true); anvil?.kill(); if (anvil) await anvil.exited; db?.close();
    if (originalDir === undefined) delete process.env.PORTEX_DEPLOYMENTS_DIR; else process.env.PORTEX_DEPLOYMENTS_DIR = originalDir;
    if (originalResults === undefined) delete process.env.PORTEX_RESULTS_DIR; else process.env.PORTEX_RESULTS_DIR = originalResults;
    if (originalMetrics === undefined) delete process.env.RPC_METRICS; else process.env.RPC_METRICS = originalMetrics;
  });
  test('health and config expose the attested deployment', async () => {
    const health = await ctx.api('/v2/health');
    expect(health.deploymentV31).toBe(true);
    expect(health.chainId).toBe(31337);
    expect(health.deployment.factory).toMatch(/^0x/);
    const cfg = await ctx.api('/v2/config');
    expect(cfg.quote.quoteFrozen).toBe(true);
    expect(cfg.stageBounds).toEqual({ stage1Min: '1296000', stage1Max: '5184000', stage2Min: '3024000', stage2Max: '6048000' });
    expect(cfg.templates.map((t: any) => t.name)).toEqual(['ESCROW_LAUNCH', 'BUDGET_LAUNCH']);
    expect(cfg.addresses.attester.toLowerCase()).toBe('0x70997970c51812dc3a010c7d01b50e0d17dc79c8');
    // Materialized registry reads (web request W4).
    const registry = cfg.addresses.registry;
    expect(cfg.curator).toBe(await ctx.read(registry, A.PortexRegistryV31Abi, 'curator'));
    expect(cfg.protocolParameters).toEqual(typed(await ctx.read(registry, A.PortexRegistryV31Abi, 'protocolParameters')));
    expect(cfg.quotes[cfg.quote.address]).toEqual({ frozen: true, codeHash: await ctx.read(registry, A.PortexRegistryV31Abi, 'quoteCodeHash', [cfg.quote.address]) });
  });
  test('six summaries have signed content while v1 tables remain empty', async () => {
    const rows = await ctx.api('/v2/raises'); expect(rows.length).toBe(6);
    for (const s of seeds) {
      const r = rows.find((r: any) => r.address === s.address);
      expect(r.phase).toBe(s.phase); expect(r.metadata.description.length).toBeGreaterThan(0); expect(r.riskScoreBps).not.toBeNull();
      for (const f of ['reports', 'updates', 'feedback']) expect((await ctx.api(`/v2/raises/${s.address}/${f}`)).length).toBe(1);
    }
    expect((await ctx.api('/v1/raises')).length).toBe(0);
    expect((db.query('SELECT COUNT(*) AS n FROM events').get() as any).n).toBe(0);
  });
  test('full-size quotes distinguish every position from the buyer ledger', async () => {
    const r = await ctx.api(`${path('SIGNAL')}/positions/${ctx.backers[0].address}`); expect(r.positions.length).toBe(2);
    for (const p of r.positions) {
      const chain = await ctx.read(seed('SIGNAL').address, A.RaiseCoreAbi, 'guaranteedClaim', [BigInt(p.id)]);
      expect(p.guaranteedClaim.amount).toBe(String(chain.amount)); expect(p.redeemQuote.result.payout).toBe(String(chain.amount));
      expect(p.redeemQuote.validity.stateNonce).toBe(r.stateNonce);
    }
    const buyer = await ctx.api(`${path('SIGNAL')}/positions/${ctx.buyer.address}`);
    expect(buyer.positions[0].positionState.class).toBe('Buyer'); expect(buyer.positions[0].guaranteedClaim.amount).toBe('0');
    expect(buyer.positions[0].redeemQuote.result).toBeUndefined(); expect(buyer.buyerLedger.marketExitQuote.validity.available).toBe(true);
  });
  test('eventless deadline updates phase, quotes, filter and inbox', async () => isolated(async () => {
    await ctx.warpTo((await ctx.api(path('SIGNAL'))).deadlines.stage2End); await indexer.poll();
    const p = await ctx.api(path('SIGNAL')); expect(p.phase).toBe('ListingPending'); expect(p.listingPreview.validity.available).toBe(true); expect(p.listingStatus.length).toBeGreaterThan(0);
    const owner = await ctx.api(`${path('SIGNAL')}/positions/${ctx.backers[0].address}`);
    expect(owner.positions[0].redeemQuote.validity.available).toBe(true); expect(owner.positions[0].protectedExitQuote).toBeNull();
    expect((await ctx.api('/v2/raises?phase=ListingPending')).length).toBe(2);
    expect((await ctx.api(`/v2/users/${ctx.buyer.address}/inbox`)).items.some((i: any) => i.type === 'listing_ready')).toBe(true);
  }));
  test('Budget haircut and proposal execution are visible', async () => {
    const d = await ctx.api(path('BENCH')); expect(BigInt(d.reserveState.J)).toBeLessThan(10n ** 18n); expect(d.governance.config.enabled).toBe(true);
    const proposals = await ctx.api(`${path('BENCH')}/proposals`); expect(proposals[0].state).toBe('Executed'); expect(proposals[0].executedTx).toMatch(/^0x/);
    const events = await ctx.api(`${path('BENCH')}/activity?all=1&limit=500`);
    for (const n of ['BudgetHaircutApplied', 'Proposed', 'VoteChanged', 'ProposalResolved']) expect(events.some((e: any) => e.kind === n)).toBe(true);
  });
  test('heuristic uses positions and posts the veto through RaiseCore', async () => {
    const d = await ctx.api(path('WATCH')); expect(d.vetoActive).toBe(true); expect(d.latestReport.veto).toBe(true);
    expect(d.latestReport.metrics.backerCount).toBe(3); expect(d.latestReport.metrics.builderLinkedShareBps).toBe(10000); expect(d.latestReport.postedTx).toMatch(/^0x/);
    expect((await ctx.api(`${path('WATCH')}/activity?all=1`)).some((e: any) => e.kind === 'VetoChanged')).toBe(true);
  });
  test('signed writes enforce builder, bind v2 path, and accept responses', async () => {
    const body = JSON.stringify({ tagline: 'Updated', description: 'Updated fixture', website: '', twitter: '', github: '', docs: '' }); const target = `${path('HARBOR')}/profile`;
    const badRole = await fetch(`${apiUrl}${target}`, { method: 'PUT', headers: await signRequest(ctx.backers[0].account, 'PUT', target, body), body }); expect(badRole.status).toBe(403);
    const badPath = await fetch(`${apiUrl}${target}`, { method: 'PUT', headers: await signRequest(BUILDER.account, 'PUT', target.replace('/v2/', '/v1/'), body), body }); expect(badPath.status).toBe(401);
    const report = await ctx.api(`${path('HARBOR')}/report`);
    const response = await ctx.signed(BUILDER, 'POST', `${path('HARBOR')}/reports/${report.reportHash}/response`, { text: 'Reviewed.' }); expect(response.builderResponse.text).toBe('Reviewed.');
    await ctx.signed(BUILDER, 'POST', `${path('HARBOR')}/metadata`, { description: 'Updated description', website: 'https://example.test' }); expect((await ctx.api(path('HARBOR'))).profile.description).toBe('Updated description');
  });
  test('invalid addresses and unknown raises return structured errors', async () => {
    for (const [url, status] of [['/v2/raises/invalid', 400], ['/v2/raises/0x0000000000000000000000000000000000000001', 404], [`${path('SIGNAL')}/positions/no`, 400]] as const) {
      const response = await fetch(`${apiUrl}${url}`); expect(response.status).toBe(status); expect((await response.json() as any).error.code).toBeDefined();
    }
  });
  test('every book-changing event has a history point and human summary', async () => {
    const events = await ctx.api(`${path('SIGNAL')}/activity?all=1&limit=500`); const prices = await ctx.api(`${path('SIGNAL')}/price-history`);
    for (const e of events.filter((e: any) => ['Deposited', 'AtCostExited', 'ProtectedSplitExecuted', 'MarketBought', 'MarketSold', 'DepthAdvanced', 'PhaseChanged'].includes(e.kind))) {
      expect(prices.some((p: any) => p.txHash === e.txHash && p.logIndex === e.logIndex)).toBe(true); expect(e.summary.length).toBeGreaterThan(20);
    }
    expect(prices[0].kind).toBe('curve');
    expect((await ctx.api(`${path('SIGNAL')}/trades?limit=500`)).some((t: any) => t.type === 'protectedExit' && BigInt(t.data.result.profit) > 0n)).toBe(true);
  });
  test('quota changes on transfer while terminal position records stay frozen', async () => isolated(async () => {
    const target = path('ATLAS'); const before = await ctx.api(`${target}/positions/${ctx.backers[0].address}`); const row = listRaisesV31(db).find((r) => r.symbol === 'ATLAS')!;
    const amount = BigInt(before.quota) / 4n; await ctx.write(ctx.backers[0], row.token, A.ProjectTokenV31Abi, 'transfer', [ctx.buyer.address, amount]); await indexer.poll();
    const after = await ctx.api(`${target}/positions/${ctx.backers[0].address}`);
    expect(after.quota).toBe(String(BigInt(before.quota) - amount)); expect(after.positions).toEqual(before.positions); expect(after.stateNonce).toBe(before.stateNonce);
    expect((await ctx.api(`${target}/activity?all=1&limit=500`)).some((e: any) => e.contract === 'token' && e.kind === 'QuotaDestroyed' && BigInt(e.data.rewardNonce) > 0n)).toBe(true);
  }));
  test('dissolution claims retire without double-counting cohort funding', async () => isolated(async () => {
    const row = listRaisesV31(db).find((r) => r.symbol === 'PILOT')!; const p = await ctx.api(`${path('PILOT')}/positions/${ctx.backers[0].address}`);
    const before = await ctx.read(row.claims, A.ClaimVaultAbi, 'liability'); await ctx.write(ctx.backers[0], row.claims, A.ClaimVaultAbi, 'claim', [BigInt(p.positions[0].id)]); await indexer.poll();
    expect(await ctx.read<bigint>(row.claims, A.ClaimVaultAbi, 'liability')).toBe(before - BigInt(p.positions[0].guaranteedClaim.amount));
    expect((await ctx.api(`${path('PILOT')}/positions/${ctx.backers[0].address}`)).positions[0].guaranteedClaim.amount).toBe('0');
    const events = await ctx.api(`${path('PILOT')}/activity?all=1&limit=500`);
    expect(events.filter((e: any) => e.kind === 'DissolutionFunded').length).toBe(1); expect(events.filter((e: any) => e.kind === 'ClaimVaultFunded').length).toBe(2); expect((await ctx.api(path('PILOT'))).E).toBe('0');
  }));
  test('deep reorg removes orphan discovery and replays projections idempotently', async () => isolated(async () => {
    const base = await snapshot(ctx.client); const original = await RaiseV31.create(ctx, 'Orphan', 'ORPHAN'); await original.deposit(ctx.backers[0], usd(500));
    await ctx.client.request({ method: 'anvil_mine', params: ['0x46'] } as never); await indexer.poll(); expect(indexer.status.lastError).toBeNull();
    expect((await ctx.api(`/v2/raises/${original.address}`)).symbol).toBe('ORPHAN'); const count = (db.query('SELECT COUNT(*) AS n FROM v31_events').get() as any).n;
    await indexer.poll(); expect((db.query('SELECT COUNT(*) AS n FROM v31_events').get() as any).n).toBe(count);
    await revert(ctx.client, base); const replacement = await RaiseV31.create(ctx, 'Replacement', 'REPLACED'); await replacement.deposit(ctx.backers[0], usd(750));
    await ctx.client.request({ method: 'anvil_mine', params: ['0x48'] } as never); await indexer.poll(); expect(indexer.status.lastError).toBeNull(); expect(replacement.address).toBe(original.address);
    const data = await ctx.api(`/v2/raises/${replacement.address}`); expect(data.symbol).toBe('REPLACED'); expect(data.E).toBe(String(usd(750)));
    expect((await ctx.api(`${path('HARBOR')}/reports`)).length).toBe(1); expect((db.query('SELECT COUNT(*) AS n FROM raises').get() as any).n).toBe(0);
  }), 30000);

  // ------------------------------------------------------------------------------------------------ DB data path

  const norm = (v: unknown) => JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x)));
  const actors = () => [...ctx.backers, ctx.buyer, BUILDER, backer(20), backer(21), backer(22)].map((a) => a.address);
  /** The former per-request RPC implementation, evaluated at the indexed block, as the oracle. */
  async function oracle() {
    const block = await ctx.client.getBlock({ blockNumber: BigInt(indexer.status.lastIndexedBlock) });
    return { live: new LiveV31(clients.public, db, block.number, Number(block.timestamp)), state: new StateV31(db, Number(block.number), Number(block.timestamp)), block };
  }
  /** Additive fields the web requested (W5, W6, W7, W8) are checked separately against their own views. */
  const lean = {
    summary: ({ modules, ...s }: any) => s,
    detail: (d: any) => {
      const { lastProposalAt, activeProposalId, eligibleCapital, tokenSnapshotBlock, ...state } = d.governance.state;
      const { disposedQuote, ...treasury } = d.treasury;
      return { ...d, governance: { ...d.governance, state }, treasury };
    },
    positions: (p: any) => ({ ...p, positions: p.positions.map(({ futureClaimBounds, ...x }: any) => x) }),
  };
  async function expectMaterializedEqualsChain() {
    const { live, state, block } = await oracle();
    const rows = listRaisesV31(db);
    for (const row of rows) {
      expect(lean.summary(norm(state.summary(row)))).toEqual(norm(await live.summary(row)));
      const detail = norm(state.detail(row));
      expect(lean.detail(detail)).toEqual(norm(await live.detail(row)));
      const at = { blockNumber: block.number };
      const gov = (fn: string) => ctx.client.readContract({ address: row.governor as never, abi: A.GovernanceV31Abi, functionName: fn as never, ...at }).then(String);
      const tok = (fn: string) => ctx.client.readContract({ address: row.token as never, abi: A.ProjectTokenV31Abi, functionName: fn as never, ...at });
      expect(detail.governance.state.lastProposalAt).toBe(await gov('lastProposalAt'));
      expect(detail.governance.state.activeProposalId).toBe(await gov('activeProposalId'));
      expect(detail.governance.state.eligibleCapital).toBe(String(await ctx.client.readContract({ address: row.address as never, abi: A.RaiseCoreAbi, functionName: 'eligibleCapital', ...at })));
      expect(detail.governance.state.tokenSnapshotBlock).toBe(Number(await tok('snapshotBlock')));
      expect(detail.treasury.disposedQuote).toBe(String(await tok('disposedQuote')));
      expect(detail.modules.attester).toBe(state.summary(row).modules.attester);
      expect(norm(state.proposals(row)).map(({ snapshotBlock, tokenValue, ...p }: any) => p)).toEqual(norm(await live.proposals(row)));
      for (const u of actors()) {
        const mine = norm(state.positions(row, u));
        expect(lean.positions(mine)).toEqual(norm(await live.positions(row, u)));
        for (const p of mine.positions.filter((p: any) => p.futureClaimBounds)) {
          expect(p.futureClaimBounds).toEqual(typed(await ctx.client.readContract({ address: row.address as never, abi: A.RaiseCoreAbi, functionName: 'futureClaimBounds', args: [BigInt(p.id), 1], ...at })));
        }
      }
    }
    for (const u of actors()) expect(norm(state.rolloverSources(rows, u))).toEqual(norm(await live.rolloverSources(rows, u)));
  }
  test('read endpoints make no RPC calls per request', async () => {
    await ctx.waitIndexed();
    const signal = seed('SIGNAL').address, atlas = seed('ATLAS').address, u = ctx.backers[0].address;
    for (const url of ['/v2/raises', '/v2/config', '/v2/markets', path('SIGNAL'), path('ATLAS'), path('PILOT'), `${path('SIGNAL')}/positions/${u}`, `${path('BENCH')}/proposals`,
      `${path('BENCH')}/votes/${u}`, `/v2/users/${u}/inbox`, `/v2/users/${u}/rollover-sources`, `/v2/raises/${signal}/quote?side=buy&amount=1000000`,
      `/v2/raises/${atlas}/activity`, `/v2/raises/${signal}/candles`, `/v2/health`]) {
      const res = await fetch(`${apiUrl}${url}`);
      expect(`${url}: ${res.status} ${res.headers.get('x-rpc-calls')}`).toBe(`${url}: 200 0`);
      expect(res.headers.get('x-block-number')).toBe(String(indexer.status.lastIndexedBlock));
    }
    const wallet = await fetch(`${apiUrl}/v2/users/${u}/wallet`);
    // The native balance is the one cached chain read: at most once per (address, block).
    expect(Number(wallet.headers.get('x-rpc-calls'))).toBeLessThanOrEqual(1);
    expect((await fetch(`${apiUrl}/v2/users/${u}/wallet`)).headers.get('x-rpc-calls')).toBe('0');
    expect(wallet.headers.get('cache-control')).toBe('private, no-store');
    expect((await fetch(`${apiUrl}/v2/raises`)).headers.get('cache-control')).toBe('public, s-maxage=2, stale-while-revalidate=30');
    expect(indexer.refresher.stats.mode).toBe('deployless');
  });
  test('materialized state equals the chain views at the indexed block', async () => {
    await ctx.waitIndexed();
    await expectMaterializedEqualsChain();
  }, 60000);
  test('time-dependent projections match the chain after eventless time passes', async () => isolated(async () => {
    // Mid Stage 2 (depth decay, protected-exit lambda), then past the deadline (ListingPending, listing preview).
    await ctx.warp(5 * DAY); await indexer.poll();
    await expectMaterializedEqualsChain();
    await ctx.warpTo((await ctx.api(path('SIGNAL'))).deadlines.stage2End); await indexer.poll();
    expect((await ctx.api(path('SIGNAL'))).listingPreview.validity.available).toBe(true);
    await expectMaterializedEqualsChain();
  }), 90000);
  test('Stage 1 and Stage 2 quotes mirror the raise quote views exactly', async () => isolated(async () => {
    const typedQuote = (v: any) => typed(v.validity.available ? v : { validity: v.validity });
    const strip = ({ raise, stateNonce, blockNumber, chainTime, kind, amountOut, position, owner, ...rest }: any) => rest;
    async function compare() {
      const { state, block } = await oracle();
      const at = { blockNumber: block.number };
      for (const symbol of ['SIGNAL', 'BENCH']) {
        const row = listRaisesV31(db).find((r) => r.symbol === symbol)!;
        const read = (fn: string, args: unknown[]) => ctx.client.readContract({ address: row.address as never, abi: A.RaiseCoreAbi, functionName: fn as never, args: args as never, ...at });
        for (const amount of [0n, 1n, 1_000_000n, 777_777_777n, usd(50_000), usd(10_000_000)]) {
          expect(strip(state.raiseQuote(row, { side: 'buy', amount }))).toEqual(typedQuote(await read('marketBuyQuote', [amount])));
          expect(strip(state.raiseQuote(row, { side: 'buy', amount, owner: BUILDER.address }))).toEqual(typedQuote(await read('marketBuyQuoteFor', [BUILDER.address, amount])));
        }
        const held = BigInt((await ctx.api(`/v2/raises/${row.address}/positions/${ctx.buyer.address}`)).buyerLedger.tokens);
        for (const q of [1n, held / 3n, held, held + 1n]) {
          expect(strip(state.raiseQuote(row, { side: 'sell', amount: q, owner: ctx.buyer.address }))).toEqual(typedQuote(await read('marketExitQuote', [ctx.buyer.address, q])));
        }
        const nonce = await read('stateNonce', []);
        for (const { id } of positionIds(db, row.address)) {
          const tokens = BigInt(state.load(row).positions.get(id)?.positionState?.tokens ?? 0);
          for (const q of [1n, tokens / 2n, tokens, tokens + 1n]) {
            expect(strip(state.raiseQuote(row, { side: 'sell', amount: q, position: id }))).toEqual(typedQuote(await read('redeemQuote', [BigInt(id), q, nonce])));
            expect(strip(state.raiseQuote(row, { side: 'sell', amount: q, position: id, exit: 'protected' }))).toEqual(typedQuote(await read('protectedExitQuote', [BigInt(id), q])));
          }
        }
      }
    }
    await compare();
    await ctx.warp(9 * DAY); await indexer.poll();
    await compare();
    // Stage 1 deposit: the curve purchase equals what `deposit` would buy.
    const harbor = listRaisesV31(db).find((r) => r.symbol === 'HARBOR')!;
    await ctx.write(ctx.backers[5], ctx.quote, A.MockUSDGV31Abi, 'approve', [harbor.address, usd(1_000_000)]); await indexer.poll();
    for (const amount of [usd(1), usd(1234), usd(90_000)]) {
      const q = await ctx.api(`/v2/raises/${harbor.address}/quote?side=deposit&amount=${amount}`);
      const nonce = await ctx.read<bigint>(harbor.address, A.RaiseCoreAbi, 'stateNonce');
      const sim = await ctx.client.simulateContract({ address: harbor.address as never, abi: A.RaiseCoreAbi, functionName: 'deposit', args: [amount, 0n, nonce, 2n ** 40n], account: ctx.backers[5].account });
      expect(q.amountOut).toBe(String((sim.result as readonly bigint[])[1]));
      expect(BigInt(q.debit) + BigInt(q.change)).toBe(amount);
    }
  }), 120000);
  test('wallet balances and allowances equal the ERC-20 views, including lazy listing delivery', async () => isolated(async () => {
    const harbor = listRaisesV31(db).find((r) => r.symbol === 'HARBOR')!;
    // A finite approval partly spent by transferFrom (no Approval event): the refresh re-reads it exactly.
    await ctx.write(ctx.backers[6], ctx.quote, A.MockUSDGV31Abi, 'approve', [harbor.address, usd(1000)]);
    await ctx.write(ctx.backers[6], harbor.address, A.RaiseCoreAbi, 'deposit', [usd(400), 0n, await ctx.read(harbor.address, A.RaiseCoreAbi, 'stateNonce'), 2n ** 40n]);
    await indexer.poll();
    const rows = listRaisesV31(db);
    for (const u of actors()) {
      const w = await ctx.api(`/v2/users/${u}/wallet`);
      expect(w.quote.balance).toBe(String(await ctx.read(ctx.quote, A.MockUSDGV31Abi, 'balanceOf', [u])));
      for (const [spender, amount] of Object.entries(w.quote.allowances)) expect(amount).toBe(String(await ctx.read(ctx.quote, A.MockUSDGV31Abi, 'allowance', [u, spender])));
      for (const row of rows) {
        const chain = await ctx.read<bigint>(row.token, A.ProjectTokenV31Abi, 'balanceOf', [u]);
        const entry = w.tokens.find((t: any) => t.raise === row.address);
        expect(`${row.symbol} ${u}: ${entry?.balance ?? '0'}`).toBe(`${row.symbol} ${u}: ${chain}`);
        for (const [spender, amount] of Object.entries(entry?.allowances ?? {})) expect(amount).toBe(String(await ctx.read(row.token, A.ProjectTokenV31Abi, 'allowance', [u, spender])));
      }
      expect(w.native.balance).toBe(String(await ctx.client.getBalance({ address: u as never, blockNumber: BigInt(w.blockNumber) })));
    }
    expect((await ctx.api(`/v2/users/${ctx.backers[6].address}/wallet`)).quote.allowances[harbor.address]).toBe(String(usd(600)));
    // Listed backers hold undelivered credit until their first transfer; it counts in balanceOf.
    const atlas = rows.find((r) => r.symbol === 'ATLAS')!;
    expect((await ctx.api(`/v2/users/${ctx.backers[3].address}/wallet`)).tokens.some((t: any) => t.raise === atlas.address && BigInt(t.balance) > 0n)).toBe(true);
  }), 120000);
  test('governance votes come from indexed events', async () => {
    const row = listRaisesV31(db).find((r) => r.symbol === 'BENCH')!;
    for (const u of [ctx.backers[0].address, ctx.backers[4].address]) {
      const { votes } = await ctx.api(`${path('BENCH')}/votes/${u}`);
      for (const [id, vote] of Object.entries(votes[0].positions) as [string, any][]) {
        const chain = await ctx.read(row.governor, A.GovernanceV31Abi, 'voteOf', [1n, BigInt(id)]);
        expect(vote).toEqual(typed(chain));
      }
      expect(Object.keys(votes[0].positions).length).toBeGreaterThan(0);
    }
  });
  test('an existing database migrates in place and backfills without re-indexing', async () => isolated(async () => {
    const copy = Database.deserialize(db.serialize());
    // What a database indexed by the previous release looks like: no quote-token rows, ledger, state or pool ticks.
    copy.exec(`DELETE FROM v31_events WHERE contract='quote'; DELETE FROM v31_state; DELETE FROM v31_balances; DELETE FROM v31_allowances;
      DELETE FROM v31_allowance_dirty; DELETE FROM v31_materialized; DELETE FROM v31_dirty; DELETE FROM v31_pool_liquidity;
      DELETE FROM v31_meta WHERE key IN ('erc20Ledger','quoteIndexedFrom','configDirty') OR key LIKE 'backfill:%';`);
    const eventsBefore = (copy.query("SELECT COUNT(*) AS n FROM v31_events WHERE contract!='quote'").get() as any).n;
    const migrated = new IndexerV31(copy as never, clients.public, { ...config, logPage: 100 });
    for (let i = 0; i < 20 && !(migrated.sync.done && migrated.status.lastIndexedBlock === indexer.status.lastIndexedBlock); i++) await migrated.poll();
    expect(migrated.status.lastError).toBeNull();
    expect(migrated.sync.done).toBe(true);
    expect(migrated.sync.backfillTo).toBe(indexer.status.lastIndexedBlock);
    // Nothing was re-indexed: the raise events are the same rows, the quote events came from the backfill.
    expect((copy.query("SELECT COUNT(*) AS n FROM v31_events WHERE contract!='quote'").get() as any).n).toBe(eventsBefore);
    const table = (d: any, sql: string) => d.query(sql).all();
    expect(table(copy, 'SELECT * FROM v31_balances ORDER BY token, holder')).toEqual(table(db, 'SELECT * FROM v31_balances ORDER BY token, holder'));
    expect(table(copy, "SELECT COUNT(*) AS n FROM v31_events WHERE contract='quote'")).toEqual(table(db, "SELECT COUNT(*) AS n FROM v31_events WHERE contract='quote'"));
    const { block } = await oracle();
    const a = new StateV31(db, Number(block.number), Number(block.timestamp)), b = new StateV31(copy as never, Number(block.number), Number(block.timestamp));
    for (const row of listRaisesV31(db)) {
      expect(norm(b.detail(row))).toEqual(norm(a.detail(row)));
      for (const u of actors()) expect(norm(b.positions(row, u))).toEqual(norm(a.positions(row, u)));
    }
    for (const u of actors()) expect(norm(b.wallet(listRaisesV31(db), u, ctx.quote))).toEqual(norm(a.wallet(listRaisesV31(db), u, ctx.quote)));
    copy.close();
  }), 120000);
  test('analysis reads only the database (mocked model scorer, no chain calls)', async () => {
    let seen: ScorerInput | null = null;
    const model: Scorer = { name: 'model-mock', score: async (input) => { seen = input; return { riskScoreBps: 1500, veto: false, rationale: 'mocked model', findings: [] }; } };
    const analyst = new AnalystV31(db, { ...clients, wallet: null }, config, [model]);
    for (const [symbol, backers] of [['HARBOR', 0], ['WATCH', 3]] as const) {
      const { result, tally } = await withRpcTally(() => analyst.analyze(seed(symbol).address));
      expect(tally.total).toBe(0);
      expect(result.panel.map((p) => p.scorer)).toContain('model-mock');
      expect(result.postedTx).toBeNull();
      expect((seen as any).metrics).toBeDefined();
      expect((seen as any).backers.length).toBe(backers);
      expect((await ctx.api(`/v2/raises/${seed(symbol).address}/report`)).reportHash).toBe(result.reportHash);
    }
    // The cluster raise is still flagged from indexed quote-token funding (one builder-funded cluster).
    expect((seen as any).funding.every((f: any) => f.funder?.toLowerCase() === BUILDER.address.toLowerCase())).toBe(true);
  });
});
