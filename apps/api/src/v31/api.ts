import { Hono, type Context } from 'hono';
import { getAddress, isAddress, type Address } from 'viem';
import type { DB } from '../db.ts';
import type { Config } from '../config.ts';
import { ANVIL_ACCOUNTS } from '../config.ts';
import type { Clients } from '../chain.ts';
import { verifySignedRequest } from '../lib/signed-request.ts';
import { validateProfile, profileFromRow } from '../lib/profile.ts';
import { RateLimiter } from '../lib/rate-limit.ts';
import { feedbackMessage, verifySignature } from '../signatures.ts';
import { reportFromRow } from '../analyst/index.ts';
import { getDeploymentV31 } from './deployment.ts';
import { getRaiseV31, listRaisesV31, migrateV31, type EventV31Row } from './db.ts';
import { typed } from './live.ts';
import { StateUnavailable, StateV31 } from './snapshot.ts';
import { Revert } from './mirror.ts';
import { stateRow } from './state-db.ts';
import { IndexerV31 } from './indexer.ts';
import { AnalysisPending, AnalystV31 } from './analyst.ts';
import { activityV31 } from './activity.ts';
import { createUploadsApp, storedProfileImage, validateImageRef } from './uploads.ts';
import { createMarketV31App, routerOf, managerOf } from './market.ts';
import { background, rpcMetricsEnabled, withRpcTally } from '../lib/rpc-metrics.ts';

export interface V31Deps { config: Config; db: DB; clients: Clients; indexer: IndexerV31; analyst: AnalystV31 }
class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
export function createV31App({ config, db, clients, indexer, analyst }: V31Deps): Hono {
  migrateV31(db);
  const app = new Hono();
  if (rpcMetricsEnabled()) {
    // Per-request RPC accounting (RPC_METRICS=1): the calls this request caused, and the background totals.
    app.use('*', async (c, next) => {
      const { tally } = await withRpcTally(async () => { await next(); });
      c.res.headers.set('X-Rpc-Calls', String(tally.total));
      c.res.headers.set('X-Rpc-Methods', JSON.stringify(tally.methods));
    });
    app.get('/debug/rpc', (c) => c.json(background));
  }
  // Freshness and caching: every response names the indexed block and chain time it reflects. Public reads may sit
  // in a shared cache for 2 s (served stale up to 30 s while revalidating); per-user reads and writes never do.
  app.use('*', async (c, next) => {
    await next();
    const { blockNumber, now } = clock();
    c.res.headers.set('X-Block-Number', String(blockNumber));
    c.res.headers.set('X-Chain-Time', String(now));
    if (c.res.headers.has('Cache-Control')) return;
    const path = c.req.path;
    const policy = c.req.method !== 'GET' || c.res.status >= 400 || /\/(health|debug)(\/|$)/.test(path) ? 'no-store'
      : /\/users\/|\/positions\/|\/votes\//.test(path) ? 'private, no-store'
        : /\/quote$/.test(path) ? 'public, s-maxage=1, stale-while-revalidate=1'
          : 'public, s-maxage=2, stale-while-revalidate=30';
    c.res.headers.set('Cache-Control', policy);
  });
  // Unexpected errors keep a generic public message; the cause is logged server-side (each distinct cause at most
  // once a minute per path) so production failures are diagnosable.
  const logged = new Map<string, number>();
  app.onError((error, c) => {
    if (error instanceof ApiError) return c.json({ error: { code: error.code, message: error.message } }, error.status as never);
    if (error instanceof StateUnavailable) return c.json({ error: { code: 'STATE_PENDING', message: 'raise state is still being indexed' } }, 503);
    if (error instanceof AnalysisPending) return c.json({ error: { code: 'INDEXING', message: error.message } }, 503);
    const cause = String((error as { shortMessage?: string })?.shortMessage ?? error?.message ?? error).slice(0, 300);
    const key = `${c.req.method} ${c.req.path}: ${cause}`;
    if (logged.size > 1000) logged.clear();
    if (Date.now() - (logged.get(key) ?? 0) > 60_000) { logged.set(key, Date.now()); console.error(`[v2 api] ${c.req.method} ${c.req.path} failed: ${cause}`); }
    if (error instanceof Revert) return c.json({ error: { code: 'CHAIN_UNAVAILABLE', message: `view would revert: ${error.reason}` } }, 503);
    return c.json({ error: { code: 'CHAIN_UNAVAILABLE', message: 'Chain request failed' } }, 503);
  });
  /** Head chain time for time-dependent projections; the indexed block for everything else. */
  const headTime = () => indexer.status?.headTimestamp
    ?? (db.query('SELECT MAX(timestamp) AS t FROM v31_blocks').get() as { t: number | null } | null)?.t ?? Math.floor(Date.now() / 1000);
  const clock = () => ({ blockNumber: indexer.status?.lastIndexedBlock ?? 0, now: headTime() });
  const snap = () => { const { blockNumber, now } = clock(); return new StateV31(db, blockNumber, now); };
  // Per-block memo of the hot public reads: recomputed when the indexer commits, the head advances, or the API writes.
  let writes = 0;
  let memoKey = '';
  let memoMap = new Map<string, unknown>();
  function memo<T>(key: string, fn: () => T): T {
    const { blockNumber, now } = clock();
    const k = `${indexer.version}:${writes}:${blockNumber}:${now}:${Math.floor(Date.now() / 5000)}`;
    if (k !== memoKey) { memoKey = k; memoMap = new Map(); }
    if (!memoMap.has(key)) memoMap.set(key, fn());
    return memoMap.get(key) as T;
  }
  app.route('/uploads', createUploadsApp({ config }));
  // Stage 3 secondary market: /markets, /markets/:address/quote, /raises/:address/candles, /raises/:address/pool-trades.
  app.route('/', createMarketV31App({ config, db, clients, clock }));
  const storedProfile = (address: string) => (db.query('SELECT profile FROM v31_profiles WHERE raiseAddr=?').get(address) as { profile: string } | null)?.profile;
  /** Adds the stored profile `image` and its resolved `imageUrl` (the summary's `metadata` is the same object). */
  const withImage = <T extends Record<string, any>>(r: T): T => {
    if (r?.profile && typeof r.profile === 'object') Object.assign(r.profile, storedProfileImage(storedProfile(r.address), config));
    return r;
  };
  function mustRaise(address: string) {
    if (!isAddress(address)) throw new ApiError(400, 'INVALID_ADDRESS', 'invalid raise address');
    const row = getRaiseV31(db, address);
    if (!row) throw new ApiError(404, 'RAISE_NOT_FOUND', 'v3.1 raise not indexed');
    return row;
  }
  function user(address: string): string {
    if (!isAddress(address)) throw new ApiError(400, 'INVALID_ADDRESS', 'invalid user address');
    return getAddress(address);
  }
  function limit(c: Context): number { return Math.max(1, Math.min(500, Math.floor(Number(c.req.query('limit')) || 100))); }
  async function signed(c: Context, builder?: string) {
    const body = await c.req.text();
    const result = await verifySignedRequest({ method: c.req.method, path: new URL(c.req.url).pathname, body,
      address: c.req.header('X-Portex-Address'), signature: c.req.header('X-Portex-Signature'), ts: c.req.header('X-Portex-Ts') });
    if (!result.ok) throw new ApiError(result.status, result.code, result.message);
    if (builder && builder.toLowerCase() !== result.address.toLowerCase()) throw new ApiError(403, 'NOT_BUILDER', 'builder signature required');
    let json;
    try { json = JSON.parse(body || '{}'); } catch { throw new ApiError(400, 'BAD_REQUEST', 'body must be valid JSON'); }
    if (!json || typeof json !== 'object' || Array.isArray(json)) throw new ApiError(400, 'BAD_REQUEST', 'body must be an object');
    return { address: result.address, json };
  }
  const latestReport = (address: string) => {
    const row = db.query('SELECT * FROM v31_reports WHERE raiseAddr=? ORDER BY id DESC LIMIT 1').get(address);
    return row ? reportFromRow(row as never) : null;
  };
  app.get('/health', (c) => {
    const s = indexer.status;
    const pending = (db.query('SELECT COUNT(*) AS n FROM v31_dirty').get() as { n: number }).n;
    return c.json({ ok: s.deploymentPresent && s.head !== null && !s.lastError, chainId: config.chainId,
      head: s.head, headTimestamp: s.headTimestamp, indexedBlock: s.lastIndexedBlock, deploymentV31: s.deploymentPresent, deployment: getDeploymentV31(config.chainId),
      state: { pendingRaises: pending, walletSynced: indexer.sync.done, backfill: indexer.sync, refresh: indexer.refresher.stats },
      error: s.deploymentPresent ? s.lastError : 'v3.1 broadcast deployment not found' });
  });
  app.get('/config', (c) => {
    const dep = getDeploymentV31(config.chainId);
    if (!dep) throw new ApiError(503, 'NO_DEPLOYMENT', 'v3.1 not deployed');
    const stored = stateRow(db, 'config', '');
    if (!stored) throw new ApiError(503, 'STATE_PENDING', 'protocol configuration is still being indexed');
    return c.json(memo('config', () => {
      const data = JSON.parse(stored.data);
      const quote = dep.quote ?? dep.mockUSDG;
      const templates = (data.templates as any[]).map(({ id, name, version, value, spendCapBps }) => {
        const p = value.parameters;
        // The spend cap is pinned in the governor bytecode; timings are the version's governed parameters.
        return { id, name, version: String(version), ...typed(value),
          stageBounds: typed({ stage1Min: p.stage1Min, stage1Max: p.stage1Max, stage2Min: p.stage2Min, stage2Max: p.stage2Max }),
          treasury: { spendCapBps: Number(spendCapBps), vestingDuration: String(p.treasuryVesting) } };
      });
      // Bounds of the newest Escrow Launch version: what a new launch is validated against.
      const stageBounds = templates.filter((t) => t.name === 'ESCROW_LAUNCH').at(-1)?.stageBounds ?? null;
      // `admins`: lowercase ADMIN_ADDRESSES, who may trigger analyses without the rate limit (admin UI role check).
      // Share of the Stage 1 sale backers must hold at the deadline; deployments before the rule was recorded need it all.
      const graduationHoldBps = Number((dep as { graduationHoldBps?: number }).graduationHoldBps ?? 10_000);
      return { chainId: config.chainId, isLocal: config.isLocal, protocol: '3.1', stageBounds, graduationHoldBps, admins: config.adminAddresses, addresses: {
        factory: dep.factory, registry: dep.registry, quote, adapter: dep.adapter ?? dep.mockV4Adapter, attester: dep.attester, council: dep.council,
        rolloverRouter: dep.rolloverRouter ?? null, router: routerOf(dep), poolManager: managerOf(dep) },
        quote: { address: quote, symbol: dep.testQuote ? 'TEST USDG' : 'USDG', decimals: 6, testToken: dep.testQuote === true, quoteFrozen: data.quoteFrozen },
        templates, curator: data.curator ?? null, protocolParameters: data.protocolParameters ? typed(data.protocolParameters) : null, quotes: data.quotes ?? {},
        blockNumber: stored.blockNumber };
    }));
  });
  app.get('/raises', (c) => {
    const rows = memo('raises', () => {
      const s = snap();
      // A raise whose first state refresh is still pending is listed once it has state (normally the same poll).
      return listRaisesV31(db).flatMap((r) => { try { return [withImage(s.summary(r))]; } catch (e) { if (e instanceof StateUnavailable) return []; throw e; } });
    });
    const phase = c.req.query('phase');
    return c.json(phase ? rows.filter((r) => r.phase === phase) : rows);
  });
  app.get('/raises/:address', (c) => {
    const row = mustRaise(c.req.param('address'));
    return c.json({ ...memo(`detail:${row.address}`, () => withImage(snap().detail(row))), latestReport: latestReport(row.address) });
  });
  app.get('/raises/:address/positions/:user', (c) => {
    const row = mustRaise(c.req.param('address'));
    return c.json(snap().positions(row, user(c.req.param('user'))));
  });
  app.get('/raises/:address/proposals', (c) => {
    const row = mustRaise(c.req.param('address'));
    return c.json(memo(`proposals:${row.address}`, () => snap().proposals(row)));
  });
  /** Per-user governance state: Stage 2 position votes, or the Stage 3 token vote and snapshot voting power. */
  app.get('/raises/:address/votes/:user', (c) => {
    const row = mustRaise(c.req.param('address'));
    const { blockNumber, now } = clock();
    return c.json({ raise: row.address, user: user(c.req.param('user')), blockNumber, chainTime: now, votes: snap().votesOf(row, user(c.req.param('user'))) });
  });
  /** Stage 1/2 quotes (deposit, buy, buyer-ledger sell, position exits), exact mirrors of the raise's quote views. */
  app.get('/raises/:address/quote', (c) => {
    const row = mustRaise(c.req.param('address'));
    const side = c.req.query('side') ?? '';
    const raw = c.req.query('amount') ?? '';
    const position = c.req.query('position');
    const owner = c.req.query('owner');
    const exit = c.req.query('exit');
    if (!['buy', 'sell', 'deposit'].includes(side) || !/^[0-9]{1,78}$/.test(raw)) throw new ApiError(400, 'BAD_REQUEST', 'side=buy|sell|deposit and amount=<raw integer> required');
    if (position !== undefined && (side !== 'sell' || !/^[0-9]{1,78}$/.test(position))) throw new ApiError(400, 'BAD_REQUEST', 'position=<id> applies to side=sell');
    if (exit !== undefined && exit !== 'cost' && exit !== 'protected') throw new ApiError(400, 'BAD_REQUEST', 'exit must be cost or protected');
    if (owner !== undefined && !isAddress(owner)) throw new ApiError(400, 'INVALID_ADDRESS', 'invalid owner address');
    if (side === 'sell' && position === undefined && owner === undefined) throw new ApiError(400, 'BAD_REQUEST', 'side=sell needs owner=<address> (buyer ledger) or position=<id>');
    return c.json(snap().raiseQuote(row, { side, amount: BigInt(raw), position, owner: owner ? getAddress(owner) : undefined, exit }));
  });
  app.get('/raises/:address/trades', (c) => {
    const row = mustRaise(c.req.param('address'));
    const rows = db.query('SELECT * FROM v31_trades WHERE raiseAddr=? ORDER BY blockNumber DESC,logIndex DESC LIMIT ?').all(row.address, limit(c)) as Record<string, any>[];
    return c.json(rows.map(({ data, ...r }) => ({ ...r, data: JSON.parse(data) })));
  });
  app.get('/raises/:address/price-history', (c) => {
    const row = mustRaise(c.req.param('address'));
    const rows = db.query('SELECT * FROM v31_prices WHERE raiseAddr=? ORDER BY blockNumber,logIndex').all(row.address) as Record<string, any>[];
    return c.json(rows.map(({ balances, ...r }) => ({ ...r, balances: JSON.parse(balances) })));
  });
  app.get('/raises/:address/activity', (c) => {
    const row = mustRaise(c.req.param('address'));
    const labels: Record<string, string> = Object.fromEntries(config.isLocal ? ANVIL_ACCOUNTS.map((a) => [a.address.toLowerCase(), a.label]) : []);
    labels[row.builder.toLowerCase()] = 'Builder';
    const events = db.query('SELECT * FROM v31_events WHERE raiseAddr=? ORDER BY blockNumber DESC,logIndex DESC').all(row.address) as EventV31Row[];
    const items = events.map((e) => activityV31(e, row.symbol, labels, c.req.query('all') === '1')).filter(Boolean) as Record<string, any>[];
    const updates = db.query('SELECT * FROM v31_updates WHERE raiseAddr=? ORDER BY id DESC LIMIT ?').all(row.address, limit(c)) as Record<string, any>[];
    items.push(...updates.map((u) => ({ kind: 'BuilderUpdate', contract: 'offchain', actor: u.author,
      summary: `Builder posted a ${u.kind}: “${u.title}”`, data: { id: u.id, title: u.title, body: u.body, updateKind: u.kind }, txHash: '', blockNumber: 0, logIndex: 0, timestamp: u.createdAt })));
    items.sort((a, b) => b.timestamp - a.timestamp || b.blockNumber - a.blockNumber || b.logIndex - a.logIndex);
    return c.json(items.slice(0, limit(c)));
  });
  app.get('/raises/:address/report', (c) => c.json(latestReport(mustRaise(c.req.param('address')).address)));
  app.get('/raises/:address/reports', (c) => {
    const row = mustRaise(c.req.param('address'));
    return c.json((db.query('SELECT * FROM v31_reports WHERE raiseAddr=? ORDER BY id DESC').all(row.address) as never[]).map(reportFromRow));
  });
  app.get('/raises/:address/feedback', (c) => {
    const row = mustRaise(c.req.param('address'));
    return c.json((db.query('SELECT * FROM v31_feedback WHERE raiseAddr=? ORDER BY id DESC').all(row.address) as Record<string, any>[])
      .map(({ signature, raiseAddr, isBacker, ...f }) => ({ ...f, raise: raiseAddr, isBacker: !!isBacker })));
  });
  app.post('/raises/:address/feedback', async (c) => {
    const row = mustRaise(c.req.param('address'));
    const body = await c.req.json().catch(() => null);
    if (!body || !isAddress(body.author ?? '') || !Number.isInteger(body.rating) || body.rating < 1 || body.rating > 5 || typeof body.text !== 'string' || !body.text || body.text.length > 2000 || typeof body.signature !== 'string') throw new ApiError(400, 'BAD_REQUEST', 'author, rating (1..5), text (1..2000), signature required');
    if (!await verifySignature(body.author, feedbackMessage(row.address, body.rating, body.text), body.signature)) throw new ApiError(401, 'BAD_SIGNATURE', 'feedback signature does not match');
    const positions = snap().positions(row, body.author);
    const isBacker = positions.positions.some((p: any) => p.positionState.class === 'Backer' && BigInt(p.guaranteedClaim.amount) > 0n) || BigInt(positions.quota) > 0n;
    const createdAt = Math.floor(Date.now() / 1000);
    const author = getAddress(body.author);
    const result = db.query('INSERT INTO v31_feedback (raiseAddr,author,createdAt,rating,text,isBacker,signature) VALUES (?,?,?,?,?,?,?)').run(row.address, author, createdAt, body.rating, body.text, +isBacker, body.signature);
    writes++;
    return c.json({ id: Number(result.lastInsertRowid), raise: row.address, author, createdAt, rating: body.rating, text: body.text, isBacker }, 201);
  });
  const raiseLimiter = new RateLimiter(1, 600_000);
  const ipLimiter = new RateLimiter(10, 600_000);
  app.post('/raises/:address/analyze', async (c) => {
    const row = mustRaise(c.req.param('address'));
    const { address } = await signed(c);
    if (address.toLowerCase() !== row.builder.toLowerCase() && !config.adminAddresses.includes(address.toLowerCase())) {
      if (!ipLimiter.allow(c.req.header('x-forwarded-for')?.split(',')[0].trim() || 'local') || !raiseLimiter.allow(row.address.toLowerCase())) throw new ApiError(429, 'RATE_LIMITED', 'analysis rate limit reached');
    }
    const report = await analyst.analyze(row.address);
    writes++;
    return c.json(report);
  });
  app.put('/raises/:address/profile', async (c) => {
    const row = mustRaise(c.req.param('address'));
    const { json } = await signed(c, row.builder);
    // `image` is optional: absent keeps the stored image, null or '' clears it.
    const { image: rawImage, ...fields } = json;
    const value = validateProfile(fields);
    if (!value.ok) throw new ApiError(400, 'BAD_REQUEST', value.message);
    const image = rawImage === undefined ? { ok: true as const, image: storedProfileImage(storedProfile(row.address), config).image } : validateImageRef(rawImage, config);
    if (!image.ok) throw new ApiError(400, 'BAD_REQUEST', image.message);
    const profile = image.image ? { ...value.profile, image: image.image } : value.profile;
    db.query('INSERT OR REPLACE INTO v31_profiles VALUES (?,?)').run(row.address, JSON.stringify(profile));
    writes++;
    return c.json({ ok: true, profile: { ...value.profile, ...storedProfileImage(JSON.stringify(profile), config) } });
  });
  app.post('/raises/:address/metadata', async (c) => {
    const row = mustRaise(c.req.param('address'));
    const { json } = await signed(c, row.builder);
    if (typeof json.description !== 'string' || json.description.length > 2000 || (json.website !== undefined && (typeof json.website !== 'string' || json.website.length > 500 || (json.website && !/^https?:\/\/\S+$/.test(json.website))))) throw new ApiError(400, 'BAD_REQUEST', 'invalid description or website');
    const old = db.query('SELECT profile FROM v31_profiles WHERE raiseAddr=?').get(row.address) as { profile: string } | null;
    const { image } = storedProfileImage(old?.profile, config);
    const profile = { ...profileFromRow(old?.profile, '', ''), ...(image ? { image } : {}), description: json.description, website: json.website ?? '' };
    db.query('INSERT OR REPLACE INTO v31_profiles VALUES (?,?)').run(row.address, JSON.stringify(profile));
    writes++;
    return c.json({ ok: true, description: profile.description, website: profile.website });
  });
  app.get('/raises/:address/updates', (c) => {
    const row = mustRaise(c.req.param('address'));
    return c.json((db.query('SELECT * FROM v31_updates WHERE raiseAddr=? ORDER BY id DESC LIMIT 200').all(row.address) as Record<string, any>[]).map(({ signature, raiseAddr, ...r }) => ({ ...r, raise: raiseAddr })));
  });
  app.post('/raises/:address/updates', async (c) => {
    const row = mustRaise(c.req.param('address'));
    const { address, json } = await signed(c, row.builder);
    if (typeof json.title !== 'string' || !json.title.trim() || json.title.length > 200 || typeof json.body !== 'string' || !json.body || json.body.length > 5000 || !['milestone', 'update', 'incident'].includes(json.kind)) throw new ApiError(400, 'BAD_REQUEST', 'invalid update title, body or kind');
    const createdAt = Math.floor(Date.now() / 1000);
    const result = db.query('INSERT INTO v31_updates (raiseAddr,author,createdAt,title,body,kind,signature) VALUES (?,?,?,?,?,?,?)').run(row.address, address, createdAt, json.title.trim(), json.body, json.kind, c.req.header('X-Portex-Signature')!);
    return c.json({ id: Number(result.lastInsertRowid), raise: row.address, author: address, createdAt, title: json.title.trim(), body: json.body, kind: json.kind }, 201);
  });
  app.post('/raises/:address/reports/:hash/response', async (c) => {
    const row = mustRaise(c.req.param('address'));
    const hash = c.req.param('hash');
    if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new ApiError(400, 'BAD_REQUEST', 'invalid report hash');
    const { json } = await signed(c, row.builder);
    if (typeof json.text !== 'string' || !json.text || json.text.length > 2000) throw new ApiError(400, 'BAD_REQUEST', 'text must be 1..2000 chars');
    const report = db.query('SELECT * FROM v31_reports WHERE raiseAddr=? AND reportHash=? COLLATE NOCASE').get(row.address, hash);
    if (!report) throw new ApiError(404, 'REPORT_NOT_FOUND', 'report not found');
    const createdAt = Math.floor(Date.now() / 1000);
    db.query('UPDATE v31_reports SET builderResponse=?,builderResponseAt=? WHERE raiseAddr=? AND reportHash=? COLLATE NOCASE').run(json.text, createdAt, row.address, hash);
    return c.json(reportFromRow({ ...report, builderResponse: json.text, builderResponseAt: createdAt } as never));
  });
  app.get('/users/:address/rollover-sources', (c) => {
    const u = user(c.req.param('address'));
    const s = snap();
    return c.json({ user: u, now: s.now, blockNumber: s.blockNumber, router: getDeploymentV31(config.chainId)?.rolloverRouter ?? null,
      sources: s.rolloverSources(listRaisesV31(db), u) });
  });
  app.get('/users/:address/inbox', (c) => c.json(snap().inbox(listRaisesV31(db), user(c.req.param('address')))));
  /**
   * Wallet: quote-token and project-token balances and allowances from the indexed ERC-20 ledger. The native balance
   * is the one chain read left on a request path: at most one `eth_getBalance` per (address, indexed block).
   */
  app.get('/users/:address/wallet', async (c) => {
    const u = user(c.req.param('address'));
    if (!indexer.sync.done) throw new ApiError(503, 'WALLET_SYNCING', 'quote-token history is still being indexed');
    const dep = getDeploymentV31(config.chainId);
    if (!dep) throw new ApiError(503, 'NO_DEPLOYMENT', 'v3.1 not deployed');
    const s = snap();
    return c.json({ ...s.wallet(listRaisesV31(db), u, String(dep.quote ?? dep.mockUSDG)), native: { balance: String(await nativeBalance(u, s.blockNumber)) } });
  });
  const natives = new Map<string, Promise<bigint>>();
  let nativeBlock = -1;
  function nativeBalance(address: string, block: number): Promise<bigint> {
    if (block !== nativeBlock) { natives.clear(); nativeBlock = block; }
    const key = address.toLowerCase();
    let hit = natives.get(key);
    if (!hit) {
      hit = clients.public.getBalance({ address: address as Address, blockNumber: BigInt(block) });
      hit.catch(() => natives.delete(key));
      if (natives.size < 10_000) natives.set(key, hit);
    }
    return hit;
  }
  return app;
}
