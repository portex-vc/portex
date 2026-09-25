import { Hono, type Context } from 'hono';
import { getAddress, isAddress, keccak256, stringToHex } from 'viem';
import type { DB } from '../db.ts';
import type { Config } from '../config.ts';
import { ANVIL_ACCOUNTS } from '../config.ts';
import type { Clients } from '../chain.ts';
import { verifySignedRequest } from '../lib/signed-request.ts';
import { validateProfile, profileFromRow } from '../lib/profile.ts';
import { RateLimiter } from '../lib/rate-limit.ts';
import { feedbackMessage, verifySignature } from '../signatures.ts';
import { reportFromRow } from '../analyst/index.ts';
import { PortexRegistryV31Abi, GovernanceV31Abi } from '../generated/v31-abis.ts';
import { getDeploymentV31 } from './deployment.ts';
import { getRaiseV31, listRaisesV31, migrateV31, type EventV31Row } from './db.ts';
import { LiveV31, typed } from './live.ts';
import { IndexerV31 } from './indexer.ts';
import { AnalystV31 } from './analyst.ts';
import { activityV31 } from './activity.ts';
import { createUploadsApp, storedProfileImage, validateImageRef } from './uploads.ts';
import { createMarketV31App, routerOf, managerOf } from './market.ts';

export interface V31Deps { config: Config; db: DB; clients: Clients; indexer: IndexerV31; analyst: AnalystV31 }
class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
export function createV31App({ config, db, clients, indexer, analyst }: V31Deps): Hono {
  migrateV31(db);
  const app = new Hono();
  app.onError((error, c) => c.json({ error: { code: error instanceof ApiError ? error.code : 'CHAIN_UNAVAILABLE', message: error instanceof ApiError ? error.message : 'Chain request failed' } }, (error instanceof ApiError ? error.status : 503) as never));
  const live = () => LiveV31.atHead(clients.public, db);
  app.route('/uploads', createUploadsApp({ config }));
  // Stage 3 secondary market: /markets, /raises/:address/candles, /raises/:address/pool-trades.
  app.route('/', createMarketV31App({ config, db, clients }));
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
    return c.json({ ok: s.deploymentPresent && s.head !== null && !s.lastError, chainId: config.chainId,
      head: s.head, headTimestamp: s.headTimestamp, indexedBlock: s.lastIndexedBlock, deploymentV31: s.deploymentPresent, deployment: getDeploymentV31(config.chainId),
      error: s.deploymentPresent ? s.lastError : 'v3.1 broadcast deployment not found' });
  });
  app.get('/config', async (c) => {
    const dep = getDeploymentV31(config.chainId);
    if (!dep) throw new ApiError(503, 'NO_DEPLOYMENT', 'v3.1 not deployed');
    const snapshot = await live();
    const quote = dep.quote ?? dep.mockUSDG;
    const templates = [];
    for (const name of ['ESCROW_LAUNCH', 'BUDGET_LAUNCH']) {
      const id = keccak256(stringToHex(name));
      const count = Number(await snapshot.read(String(dep.registry), PortexRegistryV31Abi, 'versionCount', [id]));
      for (let i = 0; i < count; i++) {
        const version = await snapshot.read(String(dep.registry), PortexRegistryV31Abi, 'versionAt', [id, BigInt(i)]);
        const value = await snapshot.read(String(dep.registry), PortexRegistryV31Abi, 'getVersion', [id, version]);
        // The spend cap is pinned in the governor bytecode; timings are the version's governed parameters.
        const spendCapBps = await snapshot.read(value.implementations.governor, GovernanceV31Abi, 'spendCapBps');
        const p = value.parameters;
        templates.push({ id, name, version: String(version), ...typed(value),
          stageBounds: typed({ stage1Min: p.stage1Min, stage1Max: p.stage1Max, stage2Min: p.stage2Min, stage2Max: p.stage2Max }),
          treasury: { spendCapBps: Number(spendCapBps), vestingDuration: String(p.treasuryVesting) } });
      }
    }
    // Bounds of the newest Escrow Launch version: what a new launch is validated against.
    const stageBounds = templates.filter((t) => t.name === 'ESCROW_LAUNCH').at(-1)?.stageBounds ?? null;
    // `admins`: lowercase ADMIN_ADDRESSES, who may trigger analyses without the rate limit (admin UI role check).
    return c.json({ chainId: config.chainId, isLocal: config.isLocal, protocol: '3.1', stageBounds, admins: config.adminAddresses, addresses: {
      factory: dep.factory, registry: dep.registry, quote, adapter: dep.adapter ?? dep.mockV4Adapter, attester: dep.attester, council: dep.council,
      rolloverRouter: dep.rolloverRouter ?? null, router: routerOf(dep), poolManager: managerOf(dep) },
      quote: { address: quote, symbol: dep.testQuote ? 'TEST USDG' : 'USDG', decimals: 6, testToken: dep.testQuote === true,
        quoteFrozen: await snapshot.read(String(dep.registry), PortexRegistryV31Abi, 'quoteFrozen', [quote]) }, templates });
  });
  app.get('/raises', async (c) => {
    const s = await live();
    const rows = await Promise.all(listRaisesV31(db).map(async (r) => withImage(await s.summary(r))));
    const phase = c.req.query('phase');
    return c.json(phase ? rows.filter((r) => r.phase === phase) : rows);
  });
  app.get('/raises/:address', async (c) => {
    const row = mustRaise(c.req.param('address'));
    return c.json({ ...withImage(await (await live()).detail(row)), latestReport: latestReport(row.address) });
  });
  app.get('/raises/:address/positions/:user', async (c) => {
    const row = mustRaise(c.req.param('address'));
    return c.json(await (await live()).positions(row, user(c.req.param('user'))));
  });
  app.get('/raises/:address/proposals', async (c) => c.json(await (await live()).proposals(mustRaise(c.req.param('address')))));
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
    const positions = await (await live()).positions(row, body.author);
    const isBacker = positions.positions.some((p: any) => p.positionState.class === 'Backer' && BigInt(p.guaranteedClaim.amount) > 0n) || BigInt(positions.quota) > 0n;
    const createdAt = Math.floor(Date.now() / 1000);
    const author = getAddress(body.author);
    const result = db.query('INSERT INTO v31_feedback (raiseAddr,author,createdAt,rating,text,isBacker,signature) VALUES (?,?,?,?,?,?,?)').run(row.address, author, createdAt, body.rating, body.text, +isBacker, body.signature);
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
    return c.json(await analyst.analyze(row.address));
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
  app.get('/users/:address/rollover-sources', async (c) => {
    const u = user(c.req.param('address'));
    const snapshot = await live();
    return c.json({ user: u, now: snapshot.now, blockNumber: Number(snapshot.blockNumber), router: getDeploymentV31(config.chainId)?.rolloverRouter ?? null,
      sources: await snapshot.rolloverSources(listRaisesV31(db), u) });
  });
  app.get('/users/:address/inbox', async (c) => {
    const u = user(c.req.param('address'));
    const snapshot = await live();
    const items: Record<string, any>[] = [];
    for (const row of listRaisesV31(db)) {
      const p = await snapshot.positions(row, u);
      const s = await snapshot.summary(row);
      const add = (type: string, title: string, dueAt: number | null, data: unknown = {}, severity = 'action') => items.push({ type, severity, raise: row.address, raiseName: row.name, symbol: row.symbol, title, dueAt, data });
      const basis = p.positions.reduce((sum: bigint, x: any) => sum + BigInt(x.guaranteedClaim.amount), 0n);
      const held = basis > 0n || BigInt(p.buyerLedger.tokens) > 0n || BigInt(p.walletTokenBalance) > 0n || BigInt(p.vesting.grant) > 0n;
      if (!held) continue;
      if (p.phase === 'Dissolved' && basis > 0n) add('dissolution_claim', 'The project dissolved; claim your capital or roll it into another project', null, { amount: String(basis) });
      if (p.phase === 'ListingPending') add('listing_ready', 'Listing is ready; cost exits and buyer sells remain open until it succeeds', s.deadlines.stage2End);
      if (p.phase === 'Stage2') add('listing_scheduled', 'Mandatory listing ends basis protection', s.deadlines.stage2End, {}, 'upcoming');
      if (p.phase === 'Stage1' && snapshot.now >= s.deadlines.stage1End && !s.vetoActive) add('stage1_ready', 'Stage 1 is ready to resolve its gates', s.deadlines.stage1End);
      if (BigInt(p.pendingRewards.tokens) + BigInt(p.pendingRewards.quote) > 0n) add('rewards_available', 'Diamond Hand rewards are ready to claim', null, p.pendingRewards);
      if (BigInt(p.vesting.claimable) > 0n) add('vesting_available', 'Builder purchase tokens are vested', null, p.vesting);
      for (const proposal of await snapshot.proposals(row)) {
        if (proposal.state === 'Voting' && proposal.mode === 'Token') {
          const [power, vote] = await Promise.all([
            snapshot.read(row.governor, GovernanceV31Abi, 'votingPower', [BigInt(proposal.id), u]),
            snapshot.read(row.governor, GovernanceV31Abi, 'tokenVoteOf', [BigInt(proposal.id), u]),
          ]);
          if (power > 0n && !vote.cast) add('vote_open', `Treasury proposal #${proposal.id} is open for your tokens`, Number(proposal.votingEnds), { proposalId: proposal.id });
        } else if (proposal.state === 'Voting') {
          for (const position of p.positions.filter((x: any) => x.positionState.class === 'Backer' && BigInt(x.positionState.basis) > 0n)) {
            const vote = await snapshot.read(row.governor, GovernanceV31Abi, 'voteOf', [BigInt(proposal.id), BigInt(position.id)]);
            if (!vote.cast) add('vote_open', `Proposal #${proposal.id} is open for position #${position.id}`, Number(proposal.votingEnds), { proposalId: proposal.id, positionId: position.id });
          }
        }
        if (proposal.state === 'Dispute' && proposal.mode === 'Capital' && basis > 0n) add('dispute_exit', `Proposal #${proposal.id} passed; cost exits remain available`, Number(proposal.disputeEnds), { proposalId: proposal.id });
      }
    }
    items.sort((a, b) => (a.severity === 'action' ? 0 : 1) - (b.severity === 'action' ? 0 : 1) || (a.dueAt ?? Infinity) - (b.dueAt ?? Infinity));
    return c.json({ user: u, now: snapshot.now, items });
  });
  return app;
}
