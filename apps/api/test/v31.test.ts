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
import { effectivePhase } from '../src/v31/live.ts';
import { loadIsolatedV1Deployment } from '../src/v31/deployment.ts';
import { listRaisesV31 } from '../src/v31/db.ts';
import { seedV31 } from '@portex/tools/seed-v31';
import { A, V31Context, RaiseV31, usd } from '@portex/tools/lib/v31';
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
    const config = loadConfig({ RPC_URL: rpc, DATABASE_PATH: ':memory:', POLL_MS: '50', PORTEX_CHAIN_ID: '31337' });
    db = openDb(':memory:'); const clients = makeClients(config);
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
    await ctx.warpTo((await ctx.api(path('SIGNAL'))).deadlines.stage2End);
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
});
