import { Hono, type Context } from 'hono';
import { cors } from 'hono/cors';
import { getAddress, isAddress, keccak256, stringToHex, type Abi, type Address } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { createWalletClient, http } from 'viem';
import {
  MockUSDGAbi, PortexRegistryAbi, RaiseAbi, RaiseFactoryAbi, AttestationBoardAbi, hasGovernorAbi,
} from './generated/abis.ts';
import { loadConfig, ANVIL_ACCOUNTS, ANVIL_DEPLOYER_KEY, type Config } from './config.ts';
import { loadIsolatedV1Deployment } from './v31/deployment.ts';
import { openDb, getRaise, listRaises, type DB, type RaiseRow } from './db.ts';
import { makeClients, makeChain, getDeployment, batchRead, type Clients } from './chain.ts';
import { Indexer, backerCount } from './indexer.ts';
import { Analyst, reportFromRow } from './analyst/index.ts';
import { readLiveDetail, readLivePosition } from './live.ts';
import { summarizeActivity, type ActivityContext, type ActivityRow } from './activity.ts';
import { feedbackMessage, metadataMessage, verifySignature } from './signatures.ts';
import { verifySignedRequest } from './lib/signed-request.ts';
import { RateLimiter } from './lib/rate-limit.ts';
import { validateProfile, profileFromRow } from './lib/profile.ts';
import { deriveInbox, type InboxRaiseInput, type InboxTranche, type InboxProposal } from './inbox.ts';

class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

export interface Deps {
  config: Config;
  db: DB;
  clients: Clients;
  indexer: Indexer;
  analyst: Analyst;
}

// ---- serialization helpers ---------------------------------------------------

type QuoteInfo = { address: string; symbol: string; decimals: number };

function escrowed(row: RaiseRow): string {
  const total = BigInt(row.totalPrincipal || '0');
  if (row.state === 'Growth' || row.state === 'Migrated') {
    const committed = BigInt(row.committedPrincipal || '0');
    return total > committed ? (total - committed).toString() : '0';
  }
  return total.toString();
}

function summaryOf(row: RaiseRow, quote: QuoteInfo, backers: number, riskScoreBps: number | null, now: number) {
  return {
    address: row.address,
    name: row.name,
    symbol: row.symbol,
    description: row.description,
    builder: row.builder,
    template: { id: row.templateId, name: row.templateName, version: row.version },
    state: row.state,
    token: row.token,
    pool: row.pool,
    vault: row.vault,
    poolAddress: row.pool,
    vaultAddress: row.vault,
    governor: row.governor,
    quote,
    softCap: String(JSON.parse(row.config).softCap ?? '0'),
    hardCap: String(JSON.parse(row.config).hardCap ?? '0'),
    totalPrincipal: row.totalPrincipal,
    escrowedPrincipal: escrowed(row),
    committedPrincipal: row.committedPrincipal,
    backers,
    createdAt: row.createdAt,
    deadlineAt: row.deadlineAt,
    bookPrice: row.poolOpen ? row.bookPrice : null,
    realRatioBps: row.poolOpen ? row.realRatioBps : null,
    riskScoreBps,
    vetoActive: row.vetoUntil > now,
    profile: profileFromRow(row.profile, row.description, row.website),
  };
}

const ACTOR_KEYS = ['user', 'trader', 'builder', 'author', 'voter', 'to', 'raise'] as const;

/** Fallback actor extraction for raw/internal events surfaced via ?all=1. */
function rawActor(args: Record<string, unknown>): string | null {
  for (const k of ACTOR_KEYS) {
    const v = args[k];
    if (typeof v === 'string' && isAddress(v)) return getAddress(v);
  }
  return null;
}

// ---- app ---------------------------------------------------------------------

export function createApp(deps: Deps): Hono {
  const { config, db, clients, indexer, analyst } = deps;
  const app = new Hono();

  app.use('*', cors({
    origin: (origin) => (config.corsOrigins.includes(origin) ? origin : config.corsOrigins[0]),
  }));

  app.onError((err, c) => {
    if (err instanceof ApiError) {
      return c.json({ error: { code: err.code, message: err.message } }, err.status as never);
    }
    console.error('[api] unhandled error:', err);
    return c.json({ error: { code: 'INTERNAL', message: err instanceof Error ? err.message : 'internal error' } }, 500);
  });

  const quoteCache = new Map<string, QuoteInfo>();
  async function quoteInfo(address: string): Promise<QuoteInfo> {
    const key = address.toLowerCase();
    const hit = quoteCache.get(key);
    if (hit) return hit;
    let info: QuoteInfo = { address: getAddress(address), symbol: '', decimals: 18 };
    try {
      const [symbol, decimals] = await batchRead<unknown>(clients.public, [
        { address: address as Address, abi: MockUSDGAbi as Abi, functionName: 'symbol' },
        { address: address as Address, abi: MockUSDGAbi as Abi, functionName: 'decimals' },
      ]);
      info = { address: getAddress(address), symbol: String(symbol), decimals: Number(decimals) };
    } catch { /* chain unavailable — return placeholder */ }
    quoteCache.set(key, info);
    return info;
  }

  function quoteAssetOf(row: RaiseRow): string {
    return String(JSON.parse(row.config).quoteAsset ?? getDeployment(config.chainId)?.mockUSDG ?? '');
  }

  function mustRaise(address: string): RaiseRow {
    if (!isAddress(address)) throw new ApiError(400, 'INVALID_ADDRESS', 'invalid raise address');
    const row = getRaise(db, address);
    if (!row) throw new ApiError(404, 'RAISE_NOT_FOUND', 'raise not indexed');
    return row;
  }

  /** Like mustRaise, but tolerates indexer latency for just-created raises. */
  async function mustRaiseSoon(address: string, timeoutMs = 15_000): Promise<RaiseRow> {
    if (!isAddress(address)) throw new ApiError(400, 'INVALID_ADDRESS', 'invalid raise address');
    const start = Date.now();
    for (;;) {
      const row = getRaise(db, address);
      if (row) return row;
      if (Date.now() - start > timeoutMs) throw new ApiError(404, 'RAISE_NOT_FOUND', 'raise not indexed');
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  function latestReport(raise: string) {
    const row = db.query('SELECT * FROM reports WHERE raiseAddr = ? COLLATE NOCASE ORDER BY id DESC LIMIT 1')
      .get(raise) as never;
    return row ? reportFromRow(row) : null;
  }

  // ---- signed requests (privileged writes) ---------------------------------------
  // One EIP-191 scheme for every privileged or costly POST/PUT — see docs/API_CONTRACT.md.

  const analyzeRaiseLimiter = new RateLimiter(1, 10 * 60_000); // public: once per raise per 10 min
  const analyzeIpLimiter = new RateLimiter(10, 10 * 60_000);   // public: ≤10 analyzes per IP per 10 min

  /** Verify the signed-request headers against the raw body; returns caller + parsed JSON. */
  async function readSignedBody(c: Context): Promise<{ address: Address; json: Record<string, unknown> }> {
    const bodyText = await c.req.text();
    const res = await verifySignedRequest({
      address: c.req.header('X-Portex-Address') ?? null,
      signature: c.req.header('X-Portex-Signature') ?? null,
      ts: c.req.header('X-Portex-Ts') ?? null,
      method: c.req.method,
      path: new URL(c.req.url).pathname,
      body: bodyText,
    });
    if (!res.ok) throw new ApiError(res.status, res.code, res.message);
    let json: Record<string, unknown> = {};
    if (bodyText) {
      try {
        json = JSON.parse(bodyText) as Record<string, unknown>;
      } catch {
        throw new ApiError(400, 'BAD_REQUEST', 'body must be valid JSON');
      }
    }
    return { address: res.address, json };
  }

  function mustBuilder(row: RaiseRow, caller: Address): void {
    if (caller.toLowerCase() !== row.builder.toLowerCase()) {
      throw new ApiError(403, 'NOT_BUILDER', 'this endpoint must be signed by the raise builder');
    }
  }

  // ---- reads -------------------------------------------------------------------

  app.get('/v1/health', (c) => {
    const s = indexer.status;
    const ok = s.deploymentPresent && s.lastError === null && s.head !== null;
    return c.json({
      ok,
      chainId: config.chainId,
      head: s.head,
      headTimestamp: s.headTimestamp,
      indexedBlock: s.lastIndexedBlock,
      deployment: s.deploymentPresent,
      error: s.deploymentPresent ? s.lastError : 'deployment file not found — waiting for contracts',
    });
  });

  app.get('/v1/config', async (c) => {
    const dep = getDeployment(config.chainId);
    if (!dep?.factory) throw new ApiError(503, 'NO_DEPLOYMENT', 'contracts not deployed yet');
    const quote = await quoteInfo(String(dep.mockUSDG ?? ''));
    const templates: { id: string; name: string; version: number; deprecated: boolean }[] = [];
    try {
      const registry = dep.registry as Address;
      const names = ['ZERO_EXTRACTION', 'MILESTONE_FUNDING'] as const;
      const counts = await batchRead<bigint>(clients.public, names.map((n) => ({
        address: registry, abi: PortexRegistryAbi as Abi, functionName: 'versionCount',
        args: [keccak256(stringToHex(n))],
      })));
      for (let t = 0; t < names.length; t++) {
        for (let v = 1; v <= Number(counts[t]); v++) {
          const [ver] = await batchRead<Record<string, unknown>>(clients.public, [{
            address: registry, abi: PortexRegistryAbi as Abi, functionName: 'getVersion',
            args: [keccak256(stringToHex(names[t])), v],
          }]);
          templates.push({
            id: keccak256(stringToHex(names[t])), name: names[t], version: v,
            deprecated: !!ver.deprecated,
          });
        }
      }
    } catch { /* registry unreadable — return config without templates */ }
    return c.json({
      chainId: config.chainId,
      isLocal: config.isLocal,
      addresses: {
        factory: getAddress(String(dep.factory)),
        registry: getAddress(String(dep.registry)),
        board: getAddress(String(dep.attestationBoard)),
        quote: quote.address,
        dexAdapter: dep.dexAdapter ? getAddress(String(dep.dexAdapter)) : null,
      },
      quote,
      templates,
    });
  });

  app.get('/v1/raises', async (c) => {
    const state = c.req.query('state');
    const rows = listRaises(db, state);
    const now = Math.floor(Date.now() / 1000);
    const dep = getDeployment(config.chainId);
    const quoteAddr = String(dep?.mockUSDG ?? '');
    const quote = quoteAddr ? await quoteInfo(quoteAddr) : { address: '', symbol: '', decimals: 18 };
    return c.json(rows.map((r) =>
      summaryOf(r, quote, backerCount(db, r.address), latestReport(r.address)?.riskScoreBps ?? null, now)));
  });

  app.get('/v1/raises/:address', async (c) => {
    const row = await mustRaiseSoon(c.req.param('address'), 5_000);
    const now = Math.floor(Date.now() / 1000);
    const quote = await quoteInfo(quoteAssetOf(row));
    const summary = summaryOf(row, quote, backerCount(db, row.address), latestReport(row.address)?.riskScoreBps ?? null, now);
    const dep = getDeployment(config.chainId);
    let live;
    try {
      live = await readLiveDetail(clients.public, row, dep?.dexAdapter ? String(dep.dexAdapter) : null, quote.decimals);
    } catch (err) {
      throw new ApiError(503, 'CHAIN_UNAVAILABLE', `live reads failed: ${err instanceof Error ? err.message : err}`);
    }
    const cfg = JSON.parse(row.config) as Record<string, string | number>;
    const start = row.start;
    return c.json({
      ...summary,
      config: cfg,
      times: {
        start,
        minIncubationEndsAt: start + Number(cfg.minIncubation ?? 0),
        deadlineAt: row.deadlineAt,
        commitmentStart: row.commitmentStart,
        commitmentEnd: row.commitmentEnd,
        growthStart: row.growthStart,
        migrationTime: row.migrationTime,
        epoch: live.epoch,
        epochLength: Number(cfg.epochLength ?? 0),
        numTranches: Number(cfg.numTranches ?? 0),
      },
      gates: live.gates,
      pool: live.pool,
      vault: live.vault,
      dex: live.dex,
      latestReport: latestReport(row.address),
    });
  });

  app.get('/v1/raises/:address/positions/:user', async (c) => {
    const row = mustRaise(c.req.param('address'));
    const user = c.req.param('user');
    if (!isAddress(user)) throw new ApiError(400, 'INVALID_ADDRESS', 'invalid user address');
    try {
      const pos = await readLivePosition(clients.public, row, user, quoteAssetOf(row));
      return c.json(pos);
    } catch (err) {
      throw new ApiError(503, 'CHAIN_UNAVAILABLE', `live reads failed: ${err instanceof Error ? err.message : err}`);
    }
  });

  app.get('/v1/raises/:address/trades', (c) => {
    const row = mustRaise(c.req.param('address'));
    const limit = Math.min(Number(c.req.query('limit') ?? 100) || 100, 500);
    const rows = db.query(
      'SELECT * FROM trades WHERE raiseAddr = ? COLLATE NOCASE ORDER BY blockNumber DESC, logIndex DESC LIMIT ?',
    ).all(row.address, limit) as never[];
    return c.json(rows.map((t: Record<string, unknown>) => ({
      type: t.type, trader: t.trader, quote: t.quote, tokens: t.tokens, price: t.price,
      R: t.R, V: t.V, T: t.T, txHash: t.txHash, blockNumber: t.blockNumber, timestamp: t.timestamp,
    })));
  });

  app.get('/v1/raises/:address/price-history', (c) => {
    const row = mustRaise(c.req.param('address'));
    const rows = db.query(
      'SELECT timestamp, price, realRatioBps, R, V FROM price_points WHERE raiseAddr = ? COLLATE NOCASE ORDER BY blockNumber ASC, logIndex ASC',
    ).all(row.address);
    return c.json(rows);
  });

  app.get('/v1/raises/:address/activity', async (c) => {
    const row = mustRaise(c.req.param('address'));
    const limit = Math.min(Number(c.req.query('limit') ?? 100) || 100, 500);
    const includeInternal = c.req.query('all') === '1';
    const quote = await quoteInfo(quoteAssetOf(row));
    const rows = db.query(
      `SELECT contract, name, args, txHash, blockNumber, logIndex, timestamp FROM events
       WHERE raiseAddr = ? COLLATE NOCASE ORDER BY blockNumber DESC, logIndex DESC LIMIT ?`,
    ).all(row.address.toLowerCase(), limit) as ActivityRow[];

    // Display labels: well-known dev accounts (localhost) + this raise's builder.
    const labels: Record<string, string> = {};
    if (config.isLocal) for (const a of ANVIL_ACCOUNTS) labels[a.address.toLowerCase()] = a.label;
    labels[row.builder.toLowerCase()] = 'builder';

    // Book price before a given event, from the indexed price history (for "0.27 → 0.99").
    const points = db.query(
      'SELECT blockNumber, logIndex, price FROM price_points WHERE raiseAddr = ? COLLATE NOCASE ORDER BY blockNumber ASC, logIndex ASC',
    ).all(row.address) as { blockNumber: number; logIndex: number; price: string }[];
    const priceBefore = (blockNumber: number, logIndex: number): string | null => {
      let prev: string | null = null;
      for (const p of points) {
        if (p.blockNumber > blockNumber || (p.blockNumber === blockNumber && p.logIndex >= logIndex)) break;
        prev = p.price;
      }
      return prev;
    };

    const ctx: ActivityContext = {
      quoteSymbol: quote.symbol || 'quote',
      quoteDecimals: quote.decimals,
      tokenSymbol: row.symbol || 'TOKEN',
      labels,
      priceBefore,
    };

    const out = [];
    for (const r of rows) {
      const s = summarizeActivity(r, ctx);
      if (!s && !includeInternal) continue; // internal wiring/noise is hidden from the default feed
      const data = JSON.parse(r.args) as Record<string, unknown>;
      out.push({
        kind: r.name,
        actor: s?.actor ?? rawActor(data),
        summary: s?.summary ?? `${r.contract} ${r.name}`,
        data, // raw event args, always available
        txHash: r.txHash,
        blockNumber: r.blockNumber,
        timestamp: r.timestamp,
      });
    }

    // Off-chain builder updates ride the same feed as BuilderUpdate items.
    const updates = db.query(
      'SELECT * FROM updates WHERE raiseAddr = ? COLLATE NOCASE ORDER BY id DESC LIMIT ?',
    ).all(row.address, limit) as { id: number; author: string; createdAt: number; title: string; body: string; kind: string }[];
    for (const u of updates) {
      out.push({
        kind: 'BuilderUpdate',
        actor: u.author,
        summary: `Builder posted a ${u.kind}: “${u.title}”`,
        data: { id: u.id, title: u.title, body: u.body, updateKind: u.kind },
        txHash: '',
        blockNumber: 0,
        timestamp: u.createdAt,
      });
    }
    // events order by (blockNumber, logIndex); updates carry only a timestamp — merge by time
    out.sort((a, b) => b.timestamp - a.timestamp || b.blockNumber - a.blockNumber);
    return c.json(out.slice(0, limit));
  });

  app.get('/v1/raises/:address/report', (c) => {
    const row = mustRaise(c.req.param('address'));
    return c.json(latestReport(row.address));
  });

  app.get('/v1/raises/:address/reports', (c) => {
    const row = mustRaise(c.req.param('address'));
    const rows = db.query('SELECT * FROM reports WHERE raiseAddr = ? COLLATE NOCASE ORDER BY id DESC').all(row.address) as never[];
    return c.json(rows.map(reportFromRow));
  });

  app.get('/v1/raises/:address/feedback', (c) => {
    const row = mustRaise(c.req.param('address'));
    const rows = db.query(
      'SELECT * FROM feedback WHERE raiseAddr = ? COLLATE NOCASE ORDER BY id DESC',
    ).all(row.address) as { id: number; raiseAddr: string; author: string; createdAt: number; rating: number; text: string; isBacker: number }[];
    return c.json(rows.map((f) => ({
      id: f.id, raise: f.raiseAddr, author: f.author, createdAt: f.createdAt,
      rating: f.rating, text: f.text, isBacker: !!f.isBacker,
    })));
  });

  app.get('/v1/raises/:address/proposals', (c) => {
    const row = mustRaise(c.req.param('address'));
    if (!row.governor || !hasGovernorAbi) return c.json([]);
    const cfg = JSON.parse(row.config) as Record<string, unknown>;
    const gov = (cfg.governor ?? {}) as Record<string, string | number>;
    const quorumBps = Number(gov.quorumBps ?? 0);
    const approvalBps = Number(gov.approvalBps ?? 0);
    const disputeWindow = Number(gov.disputeWindow ?? 0);
    // Chain time: the indexer's head timestamp (tracks eventless blocks too, e.g. the
    // ones dev time-travel mines); wall clock as fallback.
    const now = Math.max(indexer.status.headTimestamp ?? 0, Math.floor(Date.now() / 1000));
    const rows = db.query(
      'SELECT * FROM proposals WHERE raiseAddr = ? COLLATE NOCASE ORDER BY id ASC',
    ).all(row.address) as {
      id: number; amount: string; uri: string; state: string; yesPrincipal: string; noPrincipal: string;
      principalSnapshot: string; createdAt: number; votingEndsAt: number | null;
      disputeEndsAt: number | null; executedTx: string | null;
    }[];
    return c.json(rows.map((p) => {
      const yes = BigInt(p.yesPrincipal || '0');
      const no = BigInt(p.noPrincipal || '0');
      const executeDeadline = p.disputeEndsAt !== null ? p.disputeEndsAt + disputeWindow : null;
      let state: string;
      switch (p.state) {
        case 'Active': state = 'Voting'; break;
        case 'Passed':
          state = p.disputeEndsAt !== null && now < p.disputeEndsAt
            ? 'Dispute'
            : executeDeadline !== null && now < executeDeadline ? 'Executable' : 'Expired';
          break;
        default: state = p.state; // Defeated | Executed | Expired
      }
      return {
        id: p.id,
        amount: p.amount,
        uri: p.uri,
        state,
        onchainStatus: p.state,
        yesPrincipal: p.yesPrincipal,
        noPrincipal: p.noPrincipal,
        quorumBps,
        approvalBps,
        principalSnapshot: p.principalSnapshot,
        participationPrincipal: (yes + no).toString(),
        capPrincipal: ((yes * 1000n) / 10000n).toString(), // MAX_SPEND_OF_YES_BPS = 10% of YES principal
        votingEndsAt: p.votingEndsAt,
        disputeEndsAt: p.disputeEndsAt,
        executeDeadline,
        executedTx: p.executedTx,
      };
    }));
  });

  // ---- protocol-wide read (trust page) -------------------------------------------------

  app.get('/v1/protocol', async (c) => {
    const dep = getDeployment(config.chainId);
    if (!dep?.factory || !dep?.registry || !dep?.attestationBoard) {
      throw new ApiError(503, 'NO_DEPLOYMENT', 'contracts not deployed yet');
    }
    const registry = String(dep.registry) as Address;
    const factory = String(dep.factory) as Address;
    const board = String(dep.attestationBoard) as Address;
    const ZERO = '0x0000000000000000000000000000000000000000';

    // Templates: every published version, with bundleHash and on-chain codehashes.
    const names = ['ZERO_EXTRACTION', 'MILESTONE_FUNDING'] as const;
    const templates: Record<string, unknown>[] = [];
    try {
      const counts = await batchRead<bigint>(clients.public, names.map((n) => ({
        address: registry, abi: PortexRegistryAbi as Abi, functionName: 'versionCount',
        args: [keccak256(stringToHex(n))],
      })));
      for (let t = 0; t < names.length; t++) {
        for (let v = 1; v <= Number(counts[t]); v++) {
          const [ver] = await batchRead<Record<string, unknown>>(clients.public, [{
            address: registry, abi: PortexRegistryAbi as Abi, functionName: 'getVersion',
            args: [keccak256(stringToHex(names[t])), v],
          }]);
          const implementations: Record<string, { address: string; codehash: string | null } | null> = {};
          for (const [outKey, field] of [['raise', 'raiseImpl'], ['pool', 'poolImpl'], ['vault', 'vaultImpl'], ['governor', 'governorImpl']] as const) {
            const addr = String(ver[field] ?? '');
            if (!addr || addr === ZERO) { implementations[outKey] = null; continue; }
            const code = await clients.public.getCode({ address: addr as Address }).catch(() => undefined);
            implementations[outKey] = {
              address: getAddress(addr),
              codehash: code ? keccak256(code) : null,
            };
          }
          templates.push({
            id: keccak256(stringToHex(names[t])), name: names[t], version: v,
            bundleHash: String(ver.bundleHash), publishedAt: Number(ver.publishedAt ?? 0),
            deprecated: !!ver.deprecated,
            dexAdapter: ver.dexAdapter && String(ver.dexAdapter) !== ZERO ? getAddress(String(ver.dexAdapter)) : null,
            implementations,
          });
        }
      }
    } catch (err) {
      throw new ApiError(503, 'CHAIN_UNAVAILABLE', `registry reads failed: ${err instanceof Error ? err.message : err}`);
    }

    // Whitelisted quote assets from factory QuoteAssetUpdated events.
    const quoteAssets: QuoteInfo[] = [];
    try {
      const ev = (RaiseFactoryAbi as readonly { type: string; name?: string }[])
        .find((i) => i.type === 'event' && i.name === 'QuoteAssetUpdated');
      if (ev) {
        const logs = await clients.public.getLogs({ address: factory, event: ev as never, fromBlock: 0n }) as unknown as { args: { asset: string; allowed: boolean } }[];
        const allowed = new Map<string, boolean>();
        for (const l of logs) {
          allowed.set(getAddress(l.args.asset), !!l.args.allowed);
        }
        for (const [asset, isAllowed] of allowed) {
          if (isAllowed) quoteAssets.push(await quoteInfo(asset));
        }
      }
    } catch { /* factory logs unreadable — return config without quote assets */ }

    // Roles: curator (registry owner), attester + council (board).
    const [curator, attester, council] = await batchRead<string>(clients.public, [
      { address: registry, abi: PortexRegistryAbi as Abi, functionName: 'curator' },
      { address: board, abi: AttestationBoardAbi as Abi, functionName: 'attester' },
      { address: board, abi: AttestationBoardAbi as Abi, functionName: 'council' },
    ]);

    // Veto params: the distinct (vetoMaxDelay, vetoCooldown) pairs across indexed raises.
    const rows = listRaises(db);
    const vetoMap = new Map<string, { vetoMaxDelay: number; vetoCooldown: number; raises: number }>();
    for (const r of rows) {
      const cfg = JSON.parse(r.config) as Record<string, string | number>;
      const delay = Number(cfg.vetoMaxDelay ?? 0);
      const cooldown = Number(cfg.vetoCooldown ?? 0);
      const key = `${delay}/${cooldown}`;
      const entry = vetoMap.get(key) ?? { vetoMaxDelay: delay, vetoCooldown: cooldown, raises: 0 };
      entry.raises += 1;
      vetoMap.set(key, entry);
    }

    // Counts: raises by state, total escrowed principal, distinct backers.
    const raisesByState: Record<string, number> = {};
    let totalEscrowed = 0n;
    for (const r of rows) {
      raisesByState[r.state] = (raisesByState[r.state] ?? 0) + 1;
      totalEscrowed += BigInt(escrowed(r));
    }
    const flowRows = db.query('SELECT raiseAddr, user, delta FROM flows').all() as { raiseAddr: string; user: string; delta: string }[];
    const net = new Map<string, bigint>();
    for (const f of flowRows) {
      const key = `${f.raiseAddr.toLowerCase()}:${f.user.toLowerCase()}`;
      net.set(key, (net.get(key) ?? 0n) + BigInt(f.delta));
    }
    const backers = new Set<string>();
    for (const [key, v] of net) if (v > 0n) backers.add(key.split(':')[1]);

    return c.json({
      chainId: config.chainId,
      registry: getAddress(registry),
      factory: getAddress(factory),
      board: getAddress(board),
      templates,
      quoteAssets,
      roles: { curator: getAddress(curator), attester: getAddress(attester), council: getAddress(council) },
      veto: [...vetoMap.values()],
      counts: {
        raises: raisesByState,
        totalEscrowed: totalEscrowed.toString(),
        totalBackers: backers.size,
      },
    });
  });

  // ---- per-user inbox -------------------------------------------------------------------

  app.get('/v1/users/:address/inbox', (c) => {
    const user = c.req.param('address');
    if (!isAddress(user)) throw new ApiError(400, 'INVALID_ADDRESS', 'invalid user address');
    const u = user.toLowerCase();

    // Raises where the user holds a net principal position (from indexed flows).
    const flowRows = db.query('SELECT raiseAddr, delta FROM flows WHERE user = ? COLLATE NOCASE')
      .all(user) as { raiseAddr: string; delta: string }[];
    const byRaise = new Map<string, bigint>();
    for (const f of flowRows) {
      byRaise.set(f.raiseAddr.toLowerCase(), (byRaise.get(f.raiseAddr.toLowerCase()) ?? 0n) + BigInt(f.delta));
    }

    // Chain clock: indexer head timestamp (tracks time-travel) with wall clock as floor.
    const now = Math.max(indexer.status.headTimestamp ?? 0, Math.floor(Date.now() / 1000));

    const inputs: InboxRaiseInput[] = [];
    for (const [ra, principal] of byRaise) {
      if (principal <= 0n) continue;
      const row = getRaise(db, ra);
      if (!row) continue;
      const cfg = JSON.parse(row.config) as Record<string, string | number>;
      const epochLength = Number(cfg.epochLength ?? 0);

      // Per-tranche state from indexed tranche events (ordered replay, latest wins).
      const trancheRows = db.query(
        `SELECT name, args, timestamp FROM events WHERE raiseAddr = ? COLLATE NOCASE
         AND name IN ('TrancheCommitted', 'TrancheClaimed', 'TrancheRedeemed')
         ORDER BY blockNumber ASC, logIndex ASC`,
      ).all(row.address) as { name: string; args: string; timestamp: number }[];
      const trancheMap = new Map<number, InboxTranche>();
      for (const e of trancheRows) {
        const args = JSON.parse(e.args) as { user?: string; k?: string | number; principal?: string; epoch?: string | number };
        if (String(args.user ?? '').toLowerCase() !== u) continue;
        const k = Number(args.k);
        if (!Number.isFinite(k)) continue;
        if (e.name === 'TrancheCommitted') {
          const epoch = Number(args.epoch ?? 0);
          trancheMap.set(k, {
            k, state: 'Committed', principal: String(args.principal ?? '0'),
            claimableAt: epoch === 0 ? (row.growthStart ?? 0) : e.timestamp + epochLength,
          });
        } else if (e.name === 'TrancheClaimed') {
          const cur = trancheMap.get(k);
          if (cur) trancheMap.set(k, { ...cur, state: 'Claimed' });
        } else {
          const cur = trancheMap.get(k);
          if (cur) trancheMap.set(k, { ...cur, state: 'Redeemed' });
        }
      }

      // Rule 2 proposals + this user's votes (from indexed governor events).
      const proposals: InboxProposal[] = [];
      if (row.governor) {
        const voteRows = db.query(
          `SELECT args FROM events WHERE raiseAddr = ? COLLATE NOCASE AND contract = 'governor' AND name = 'Voted'`,
        ).all(row.address) as { args: string }[];
        const votes = new Map<number, boolean>(); // proposalId -> support
        for (const v of voteRows) {
          const args = JSON.parse(v.args) as { id?: string | number; voter?: string; support?: boolean };
          if (String(args.voter ?? '').toLowerCase() !== u) continue;
          votes.set(Number(args.id), !!args.support);
        }
        const pRows = db.query('SELECT * FROM proposals WHERE raiseAddr = ? COLLATE NOCASE ORDER BY id ASC')
          .all(row.address) as { id: number; state: string; votingEndsAt: number | null; disputeEndsAt: number | null }[];
        for (const p of pRows) {
          proposals.push({
            id: p.id,
            status: p.state as InboxProposal['status'],
            votingEndsAt: p.votingEndsAt,
            disputeEndsAt: p.disputeEndsAt,
            userVoted: votes.has(p.id),
            userVotedYes: votes.get(p.id) === true,
          });
        }
      }

      const pp = db.query(
        'SELECT R, realRatioBps FROM price_points WHERE raiseAddr = ? COLLATE NOCASE ORDER BY blockNumber DESC, logIndex DESC LIMIT 1',
      ).get(row.address) as { R: string; realRatioBps: number } | null;

      inputs.push({
        address: row.address,
        name: row.name,
        symbol: row.symbol,
        state: row.state,
        governor: row.governor,
        principal: principal.toString(),
        commitmentEnd: row.commitmentEnd,
        growthStart: row.growthStart,
        epochLength,
        numTranches: Number(cfg.numTranches ?? 0),
        minGraduationLiquidity: String(cfg.minGraduationLiquidity ?? '0'),
        minRealRatioBps: Number(cfg.minRealRatioBps ?? 0),
        realRatioBps: pp?.realRatioBps ?? null,
        poolR: pp?.R ?? null,
        tranches: [...trancheMap.values()],
        proposals,
      });
    }

    return c.json({ user: getAddress(user), now, items: deriveInbox(now, inputs) });
  });

  // ---- writes ------------------------------------------------------------------

  app.post('/v1/raises/:address/feedback', async (c) => {
    const row = mustRaise(c.req.param('address'));
    const body = await c.req.json().catch(() => null) as { author?: string; rating?: number; text?: string; signature?: string } | null;
    if (!body || !body.author || !isAddress(body.author)) throw new ApiError(400, 'BAD_REQUEST', 'author must be a valid address');
    const rating = Number(body.rating);
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) throw new ApiError(400, 'BAD_REQUEST', 'rating must be an integer 1..5');
    const text = String(body.text ?? '');
    if (text.length < 1 || text.length > 2000) throw new ApiError(400, 'BAD_REQUEST', 'text must be 1..2000 chars');
    if (!body.signature) throw new ApiError(400, 'BAD_REQUEST', 'signature required');

    const message = feedbackMessage(row.address, rating, text);
    const valid = await verifySignature(body.author, message, body.signature);
    if (!valid) throw new ApiError(401, 'BAD_SIGNATURE', 'signature does not match author over the feedback message');

    let isBacker = false;
    try {
      const [principal] = await batchRead<bigint>(clients.public, [{
        address: row.address as Address, abi: RaiseAbi as Abi, functionName: 'principalOf', args: [getAddress(body.author)],
      }]);
      isBacker = principal > 0n;
    } catch {
      // chain unavailable: fall back to indexed flows
      const rows = db.query('SELECT delta FROM flows WHERE raiseAddr = ? COLLATE NOCASE AND user = ? COLLATE NOCASE').all(row.address, body.author) as { delta: string }[];
      isBacker = rows.reduce((acc, r) => acc + BigInt(r.delta), 0n) > 0n;
    }

    const createdAt = Math.floor(Date.now() / 1000);
    const author = getAddress(body.author);
    const res = db.query(
      'INSERT INTO feedback (raiseAddr, author, createdAt, rating, text, isBacker, signature) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(row.address, author, createdAt, rating, text, isBacker ? 1 : 0, body.signature);
    return c.json({
      id: Number(res.lastInsertRowid), raise: row.address, author, createdAt,
      rating, text, isBacker,
    }, 201);
  });

  app.post('/v1/raises/:address/analyze', async (c) => {
    const row = mustRaise(c.req.param('address'));
    const { address: caller } = await readSignedBody(c);
    const who = caller.toLowerCase();
    const isAdmin = config.adminAddresses.includes(who);
    const isBuilder = who === row.builder.toLowerCase();
    if (!isAdmin && !isBuilder) {
      // Public path: anyone signed in, but the costly analysis is throttled —
      // once per raise per 10 minutes, and ≤10 analyzes per IP per 10 minutes.
      const ip = (c.req.header('x-forwarded-for') ?? '').split(',')[0].trim() || 'local';
      if (!analyzeIpLimiter.allow(ip)) {
        throw new ApiError(429, 'RATE_LIMITED', 'too many analyze requests from this IP — try again later');
      }
      if (!analyzeRaiseLimiter.allow(row.address.toLowerCase())) {
        throw new ApiError(429, 'RATE_LIMITED', 'this raise was analyzed recently — the public path allows one run per raise per 10 minutes');
      }
    }
    try {
      const report = await analyst.analyze(row.address);
      return c.json(report);
    } catch (err) {
      if ((err as { code?: string }).code === 'RAISE_NOT_FOUND') throw new ApiError(404, 'RAISE_NOT_FOUND', 'raise not indexed');
      throw err;
    }
  });

  app.post('/v1/raises/:address/metadata', async (c) => {
    const row = await mustRaiseSoon(c.req.param('address'));
    if (c.req.header('X-Portex-Signature')) {
      // New scheme: the generic signed request (headers), signed by the builder.
      const { address: caller, json } = await readSignedBody(c);
      mustBuilder(row, caller);
      const description = typeof json.description === 'string' ? json.description : null;
      if (description === null || description.length > 2000) {
        throw new ApiError(400, 'BAD_REQUEST', 'description must be a string of at most 2000 chars');
      }
      const website = typeof json.website === 'string' ? json.website.slice(0, 200) : '';
      db.query('UPDATE raises SET description = ?, website = ? WHERE address = ?')
        .run(description, website, row.address);
      return c.json({ ok: true, description, website });
    }
    // Deprecated (kept for one release): body-signed legacy format.
    const body = await c.req.json().catch(() => null) as { description?: string; website?: string; signature?: string } | null;
    if (!body || typeof body.description !== 'string' || body.description.length > 2000) {
      throw new ApiError(400, 'BAD_REQUEST', 'description must be a string of at most 2000 chars');
    }
    const website = typeof body.website === 'string' ? body.website.slice(0, 200) : '';
    if (!body.signature) throw new ApiError(400, 'BAD_REQUEST', 'signature required');
    const message = metadataMessage(row.address, body.description, website);
    const valid = await verifySignature(row.builder, message, body.signature);
    if (!valid) throw new ApiError(401, 'BAD_SIGNATURE', 'metadata must be signed by the raise builder');
    db.query('UPDATE raises SET description = ?, website = ? WHERE address = ?')
      .run(body.description, website, row.address);
    c.header('Deprecation', 'true');
    return c.json({ ok: true, description: body.description, website, deprecated: 'body-signed metadata is deprecated; use the signed-request headers (X-Portex-*) instead' });
  });

  // ---- builder profile -------------------------------------------------------------

  app.put('/v1/raises/:address/profile', async (c) => {
    const row = await mustRaiseSoon(c.req.param('address'));
    const { address: caller, json } = await readSignedBody(c);
    mustBuilder(row, caller);
    const v = validateProfile(json);
    if (!v.ok) throw new ApiError(400, 'BAD_REQUEST', v.message);
    db.query('UPDATE raises SET profile = ?, description = ?, website = ? WHERE address = ?')
      .run(JSON.stringify(v.profile), v.profile.description, v.profile.website, row.address);
    return c.json({ ok: true, profile: v.profile });
  });

  // ---- builder updates ---------------------------------------------------------------

  app.get('/v1/raises/:address/updates', (c) => {
    const row = mustRaise(c.req.param('address'));
    const rows = db.query(
      'SELECT * FROM updates WHERE raiseAddr = ? COLLATE NOCASE ORDER BY id DESC LIMIT 200',
    ).all(row.address) as { id: number; raiseAddr: string; author: string; createdAt: number; title: string; body: string; kind: string }[];
    return c.json(rows.map((u) => ({
      id: u.id, raise: row.address, author: u.author, createdAt: u.createdAt,
      title: u.title, body: u.body, kind: u.kind,
    })));
  });

  app.post('/v1/raises/:address/updates', async (c) => {
    const row = await mustRaiseSoon(c.req.param('address'));
    const { address: caller, json } = await readSignedBody(c);
    mustBuilder(row, caller);
    const title = typeof json.title === 'string' ? json.title.trim() : '';
    if (!title || title.length > 200) throw new ApiError(400, 'BAD_REQUEST', 'title must be 1..200 chars');
    const updBody = typeof json.body === 'string' ? json.body : '';
    if (!updBody || updBody.length > 5000) throw new ApiError(400, 'BAD_REQUEST', 'body must be 1..5000 chars');
    const kind = String(json.kind ?? '');
    if (!['milestone', 'update', 'incident'].includes(kind)) {
      throw new ApiError(400, 'BAD_REQUEST', "kind must be one of 'milestone' | 'update' | 'incident'");
    }
    const createdAt = Math.floor(Date.now() / 1000);
    const res = db.query(
      'INSERT INTO updates (raiseAddr, author, createdAt, title, body, kind, signature) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(row.address, caller, createdAt, title, updBody, kind, c.req.header('X-Portex-Signature')!);
    return c.json({
      id: Number(res.lastInsertRowid), raise: row.address, author: caller,
      createdAt, title, body: updBody, kind,
    }, 201);
  });

  // ---- builder response to an analyst report -------------------------------------------

  app.post('/v1/raises/:address/reports/:hash/response', async (c) => {
    const row = mustRaise(c.req.param('address'));
    const hash = c.req.param('hash');
    if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new ApiError(400, 'BAD_REQUEST', 'hash must be a 0x-prefixed 32-byte hex string');
    const { address: caller, json } = await readSignedBody(c);
    mustBuilder(row, caller);
    const text = typeof json.text === 'string' ? json.text : '';
    if (!text || text.length > 2000) throw new ApiError(400, 'BAD_REQUEST', 'text must be 1..2000 chars');
    const report = db.query(
      'SELECT * FROM reports WHERE raiseAddr = ? COLLATE NOCASE AND reportHash = ? COLLATE NOCASE',
    ).get(row.address, hash) as never;
    if (!report) throw new ApiError(404, 'REPORT_NOT_FOUND', 'no report with this hash for this raise');
    const createdAt = Math.floor(Date.now() / 1000);
    db.query('UPDATE reports SET builderResponse = ?, builderResponseAt = ? WHERE raiseAddr = ? COLLATE NOCASE AND reportHash = ? COLLATE NOCASE')
      .run(text, createdAt, row.address, hash);
    return c.json(reportFromRow({ ...(report as object), builderResponse: text, builderResponseAt: createdAt } as never));
  });

  // ---- localhost-only dev endpoints ----------------------------------------------

  if (config.isLocal) {
    app.post('/v1/dev/time-travel', async (c) => {
      const body = await c.req.json().catch(() => ({})) as { seconds?: number };
      const seconds = Math.floor(Number(body.seconds ?? 0));
      if (!Number.isFinite(seconds) || seconds < 0) throw new ApiError(400, 'BAD_REQUEST', 'seconds must be a non-negative integer');
      await clients.public.request({ method: 'evm_increaseTime', params: [seconds] } as never);
      await clients.public.request({ method: 'evm_mine', params: [] } as never);
      const block = await clients.public.getBlock();
      return c.json({ now: Number(block.timestamp) });
    });

    app.post('/v1/dev/faucet', async (c) => {
      const body = await c.req.json().catch(() => null) as { to?: string; amount?: string } | null;
      if (!body?.to || !isAddress(body.to)) throw new ApiError(400, 'BAD_REQUEST', 'to must be a valid address');
      const amount = BigInt(String(body.amount ?? '0'));
      if (amount <= 0n) throw new ApiError(400, 'BAD_REQUEST', 'amount must be positive');
      const dep = getDeployment(config.chainId);
      if (!dep?.mockUSDG) throw new ApiError(503, 'NO_DEPLOYMENT', 'contracts not deployed yet');
      const chain = makeChain(config);
      const deployer = createWalletClient({
        account: privateKeyToAccount(ANVIL_DEPLOYER_KEY), chain, transport: http(config.rpcUrl),
      });
      const to = getAddress(body.to);
      const txs: string[] = [];
      const mintTx = await deployer.writeContract({
        address: dep.mockUSDG as Address, abi: MockUSDGAbi as Abi, functionName: 'mint',
        args: [to, amount], account: deployer.account, chain,
      } as never);
      txs.push(mintTx as string);
      await clients.public.waitForTransactionReceipt({ hash: mintTx as `0x${string}` });
      // Top up 10 native tokens when the balance is low (< 1 ETH).
      const balance = await clients.public.getBalance({ address: to });
      if (balance < 10n ** 18n) {
        const tx = await deployer.sendTransaction({ to, value: 10n * 10n ** 18n, account: deployer.account, chain });
        await clients.public.waitForTransactionReceipt({ hash: tx });
        txs.push(tx);
      }
      return c.json({ ok: true, txHashes: txs });
    });

    app.get('/v1/dev/accounts', (c) =>
      c.json(ANVIL_ACCOUNTS.map((a, index) => ({ index, ...a }))));
  } else {
    app.all('/v1/dev/*', (c) => c.json({ error: { code: 'NOT_FOUND', message: 'not found' } }, 404));
  }

  app.notFound((c) =>
    c.json({ error: { code: 'NOT_FOUND', message: 'not found' } }, 404));

  return app;
}

// ---- entrypoint ------------------------------------------------------------------

export async function main(): Promise<void> {
  const config = loadConfig();
  loadIsolatedV1Deployment(config.chainId);
  const db = openDb(config.databasePath);
  const clients = makeClients(config);
  const indexer = new Indexer(db, clients.public, config);
  const analyst = new Analyst(db, clients, config);
  indexer.start();

  if (config.analystIntervalMs > 0) {
    setInterval(() => {
      void (async () => {
        for (const r of listRaises(db, 'Incubation')) {
          try { await analyst.analyze(r.address); } catch (err) {
            console.error(`[analyst] scheduled analysis failed for ${r.address}:`, err instanceof Error ? err.message : err);
          }
        }
      })();
    }, config.analystIntervalMs);
  }

  const app = createApp({ config, db, clients, indexer, analyst });
  console.log(`portex-backend listening on :${config.port} (chain ${config.chainId})`);
  Bun.serve({ port: config.port, fetch: app.fetch });
}

if (import.meta.main) {
  void main();
}
