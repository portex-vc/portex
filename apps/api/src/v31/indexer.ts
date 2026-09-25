import { decodeEventLog, getAddress, type Abi, type PublicClient, type Log, type Block } from 'viem';
import * as ABIS from '../generated/v31-abis.ts';
import type { Config } from '../config.ts';
import type { DB } from '../db.ts';
import { jsonify, type IndexerStatus } from '../indexer.ts';
import { getDeploymentV31 } from './deployment.ts';
import { migrateV31, getRaiseV31, listRaisesV31, type EventV31Row } from './db.ts';
import { MarketIndexerV31 } from './market.ts';

// Event payloads are ABI-decoded, then serialized; nested tuples retain their ABI names.
type Args = Record<string, any>;
const abis: Record<string, Abi> = {
  factory: ABIS.RaiseFactoryV31Abi, raise: ABIS.RaiseCoreAbi, token: ABIS.ProjectTokenV31Abi,
  governor: ABIS.GovernanceV31Abi, vesting: ABIS.VestingVaultV31Abi, claims: ABIS.ClaimVaultAbi,
  treasury: ABIS.TreasuryV31Abi, router: ABIS.RolloverRouterV31Abi,
  registry: ABIS.PortexRegistryV31Abi, adapter: ABIS.MockV4AdapterAbi,
};
type Watched = Map<string, { kind: string; raise: string | null }>;
export const PHASES = ['Stage1', 'Stage2', 'ListingPending', 'Stage3', 'Dissolved'] as const;
export const SCALE = 10n ** 18n;
export const PRICE_SCALE = 10n ** 30n;
export function curvePrice(config: Args, sold: bigint): bigint {
  const target = BigInt(config.targetPrice ?? 0);
  const allocation = BigInt(config.supply ?? 0) / 5n;
  // CurveV31 uses the exact rational kappa=3/2, not a rounded starting price.
  return allocation ? target * (2n * allocation + sold) / (3n * allocation) : 0n;
}
export function bookPrice(book: Args): string | null {
  return BigInt(book.T ?? 0) > 0n ? ((BigInt(book.R) + BigInt(book.V)) * PRICE_SCALE / BigInt(book.T)).toString() : null;
}
const emptyBook = () => ({ E: '0', R: '0', V: '0', T: '0', O: '0', sold: '0', phase: 0 });

export class IndexerV31 {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running: Promise<void> | null = null;
  private lastLogged = { cause: '', at: 0 };
  private genesisHash: string | null = null;
  readonly status: IndexerStatus = { lastIndexedBlock: 0, head: null, headTimestamp: null, lastError: null, lastPollAt: null, deploymentPresent: false };
  /** Stage 3 pool swaps: fetched with each page, written in its transaction, rolled back with it. */
  private readonly market: MarketIndexerV31;
  constructor(private db: DB, private client: PublicClient, private config: Config) { migrateV31(db); this.market = new MarketIndexerV31(db, client, config); }
  start(): void { void this.poll(); this.timer = setInterval(() => void this.poll(), this.config.pollMs); }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; }
  poll(): Promise<void> {
    if (this.running) return this.running;
    this.running = this.pollOnce().then(() => { this.status.lastError = null; }).catch((e) => {
      this.status.lastError = 'v3.1 indexing failed; check chain and deployment configuration';
      // Log each distinct cause at most once a minute; the public status stays generic.
      const cause = String((e as { shortMessage?: string })?.shortMessage ?? (e as Error)?.message ?? e).slice(0, 200);
      const now = Date.now();
      if (cause !== this.lastLogged.cause || now - this.lastLogged.at > 60_000) {
        this.lastLogged = { cause, at: now };
        console.warn(`[v31 indexer] ${cause}`);
      }
    }).finally(() => { this.running = null; this.status.lastPollAt = Math.floor(Date.now() / 1000); });
    return this.running;
  }
  private meta(key: string): string | null {
    return (this.db.query('SELECT value FROM v31_meta WHERE key = ?').get(key) as { value: string } | null)?.value ?? null;
  }
  private setMeta(key: string, value: string): void {
    this.db.query('INSERT OR REPLACE INTO v31_meta VALUES (?,?)').run(key, value);
  }
  private async pollOnce(): Promise<void> {
    const dep = getDeploymentV31(this.config.chainId);
    this.status.deploymentPresent = !!dep?.factory;
    if (!dep?.factory) return;
    if (await this.client.getChainId() !== this.config.chainId) throw new Error('RPC chain mismatch');
    const head = await this.client.getBlock({ blockTag: 'latest' });
    // Genesis never changes; some public RPC nodes cannot serve block 0, so read it once and keep it.
    this.genesisHash ??= (await this.client.getBlock({ blockNumber: 0n })).hash;
    this.status.head = Number(head.number);
    this.status.headTimestamp = Number(head.timestamp);
    if (!await this.client.getCode({ address: String(dep.factory) as `0x${string}`, blockNumber: head.number })) {
      throw new Error('v3.1 factory has no code on this chain');
    }
    const identity = `${this.genesisHash}:${String(dep.factory).toLowerCase()}`;
    if (this.meta('identity') && this.meta('identity') !== identity) this.rollback(0);
    this.setMeta('identity', identity);
    const startBlock = Math.max(1, Number(dep.deploymentBlock ?? 1));
    const floor = startBlock - 1;
    let last = Math.max(floor, Number(this.meta('last') ?? floor));
    // All block hashes are retained. Walk to the actual common ancestor, including deep reorgs.
    let ancestor = Math.max(floor, Math.min(last, Number(head.number)));
    while (ancestor > floor) {
      const stored = this.db.query('SELECT hash FROM v31_blocks WHERE number = ?').get(ancestor) as { hash: string } | null;
      const chain = await this.client.getBlock({ blockNumber: BigInt(ancestor) });
      if (stored?.hash === chain.hash) break;
      ancestor--;
    }
    if (ancestor < last) { this.rollback(ancestor + 1); last = ancestor; }
    const target = Number(head.number) - this.config.confirmations;
    for (let from = Math.max(startBlock, last + 1); from <= target; from += this.config.logPage) {
      await this.indexRange(from, Math.min(from + this.config.logPage - 1, target));
    }
    this.status.lastIndexedBlock = Number(this.meta('last') ?? 0);
  }
  private watched(): Watched {
    const dep = getDeploymentV31(this.config.chainId)!;
    const map: Watched = new Map();
    for (const [key, kind] of [['factory', 'factory'], ['registry', 'registry'], [dep.adapter ? 'adapter' : 'mockV4Adapter', 'adapter'], ['rolloverRouter', 'router']]) {
      if (dep[key]) map.set(String(dep[key]).toLowerCase(), { kind, raise: null });
    }
    for (const r of listRaisesV31(this.db)) this.addRaise(map, r.address, r);
    return map;
  }
  private addRaise(map: Watched, raise: string, modules: Args, treasury?: string): void {
    map.set(raise.toLowerCase(), { kind: 'raise', raise: getAddress(raise) });
    for (const kind of ['token', 'governor', 'vesting', 'claims']) {
      map.set(String(modules[kind]).toLowerCase(), { kind, raise: getAddress(raise) });
    }
    const pinned = treasury ?? (modules.config ? JSON.parse(modules.config).treasury : undefined);
    if (pinned) map.set(String(pinned).toLowerCase(), { kind: 'treasury', raise: getAddress(raise) });
  }
  private decode(log: Log, watched: Watched, timestamps: Map<number, number>): EventV31Row | null {
    const entry = watched.get(log.address.toLowerCase());
    if (!entry) return null;
    let decoded;
    try { decoded = decodeEventLog({ abi: abis[entry.kind], topics: log.topics as never, data: log.data }); }
    catch { return null; }
    const args = jsonify(decoded.args) as Args;
    // Rollover events belong to the launch that received (target) or released (source) the capital.
    const routed = args.target ?? args.source;
    return {
      raiseAddr: entry.raise ?? (args.raise ? getAddress(args.raise) : routed ? getAddress(routed) : null), contract: entry.kind,
      name: decoded.eventName!, args: JSON.stringify(args), address: getAddress(log.address),
      txHash: log.transactionHash!, blockNumber: Number(log.blockNumber), logIndex: Number(log.logIndex),
      timestamp: timestamps.get(Number(log.blockNumber))!,
    };
  }
  private async indexRange(from: number, to: number): Promise<void> {
    const watched = this.watched();
    const factory = String(getDeploymentV31(this.config.chainId)!.factory) as `0x${string}`;
    const factoryLogs = await this.client.getLogs({ address: factory, fromBlock: BigInt(from), toBlock: BigInt(to) });
    const created = new Map<string, Args>();
    for (const log of factoryLogs) {
      try {
        const e = decodeEventLog({ abi: ABIS.RaiseFactoryV31Abi, topics: log.topics, data: log.data });
        if (e.eventName === 'RaiseCreated') created.set(e.args.raise.toLowerCase(), e.args.modules as Args);
        if (e.eventName === 'RaiseConfigured') {
          const modules = created.get(e.args.raise.toLowerCase());
          if (modules) this.addRaise(watched, e.args.raise, modules, e.args.config.treasury);
        }
      } catch { /* Not a discovery event. */ }
    }
    const logs = await this.client.getLogs({ address: [...watched.keys()] as `0x${string}`[], fromBlock: BigInt(from), toBlock: BigInt(to) });
    const blocks: Block[] = [];
    for (let start = from; start <= to; start += 32) {
      blocks.push(...await Promise.all(Array.from({ length: Math.min(32, to - start + 1) }, (_, i) => this.client.getBlock({ blockNumber: BigInt(start + i) }))));
    }
    const timestamps = new Map(blocks.map((b) => [Number(b.number), Number(b.timestamp)]));
    const market = await this.market.fetch(from, to, factoryLogs);
    const events = logs.sort((a, b) => Number(a.blockNumber - b.blockNumber) || Number(a.logIndex - b.logIndex))
      .map((l) => this.decode(l, watched, timestamps)).filter((e): e is EventV31Row => !!e);
    // Abort if the page changed while fetching. No discovery or cursor writes escape this transaction.
    const tip = await this.client.getBlock({ blockNumber: BigInt(to) });
    if (tip.hash !== blocks.at(-1)!.hash || [...logs, ...market.logs].some((l) => blocks[Number(l.blockNumber) - from].hash !== l.blockHash)) {
      throw new Error('chain changed while indexing v3.1 page; retrying');
    }
    this.db.transaction(() => {
      for (const b of blocks) this.db.query('INSERT OR REPLACE INTO v31_blocks VALUES (?,?,?)').run(Number(b.number), b.hash!, Number(b.timestamp));
      for (const e of events) {
        const inserted = this.db.query('INSERT OR IGNORE INTO v31_events VALUES (?,?,?,?,?,?,?,?,?)')
          .run(e.raiseAddr, e.contract, e.name, e.args, e.address, e.txHash, e.blockNumber, e.logIndex, e.timestamp);
        if (inserted.changes) this.apply(e);
      }
      this.market.insert(market.rows, timestamps);
      this.setMeta('last', String(to));
    })();
  }
  private rollback(from: number): void {
    this.db.transaction(() => {
      this.db.query('DELETE FROM v31_events WHERE blockNumber >= ?').run(from);
      this.db.query('DELETE FROM v31_blocks WHERE number >= ?').run(from);
      this.market.rollback(from);
      for (const table of ['raises', 'positions', 'prices', 'trades', 'proposals']) this.db.exec(`DELETE FROM v31_${table}`);
      const events = this.db.query('SELECT * FROM v31_events ORDER BY blockNumber,logIndex').all() as EventV31Row[];
      for (const e of events) this.apply(e);
      this.setMeta('last', String(Math.max(0, from - 1)));
    })();
  }
  private apply(e: EventV31Row): void {
    const a = JSON.parse(e.args) as Args;
    if (e.contract === 'factory' && e.name === 'RaiseCreated') {
      this.db.query(`INSERT OR IGNORE INTO v31_raises
        (address,builder,templateId,version,token,governor,vesting,claims,adapter,state,createdAt,blockNumber,txHash)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(e.raiseAddr, getAddress(a.builder), a.templateId, Number(a.version),
        a.modules.token, a.modules.governor, a.modules.vesting, a.modules.claims, a.modules.adapter,
        JSON.stringify(emptyBook()), e.timestamp, e.blockNumber, e.txHash);
      return;
    }
    if (!e.raiseAddr) return;
    const row = getRaiseV31(this.db, e.raiseAddr);
    if (!row) return;
    if (e.name === 'RaiseConfigured') {
      this.db.query('UPDATE v31_raises SET config=?,name=?,symbol=? WHERE address=?').run(JSON.stringify(a.config), a.name, a.symbol, row.address);
    }
    const state: Args = JSON.parse(row.state);
    let priceChanged = false;
    if (e.contract === 'raise') {
      if (a.phase !== undefined) state.phase = Number(a.phase);
      if (a.stateNonce !== undefined) state.stateNonce = a.stateNonce;
      if (a.balances) { Object.assign(state, a.balances); priceChanged = true; }
      if (e.name === 'Deposited') {
        state.E = a.escrow; state.sold = a.sold; priceChanged = true;
        this.db.query('INSERT OR REPLACE INTO v31_positions VALUES (?,?,?,?,?)').run(row.address, a.id, a.owner, Number(a.class), a.tokens);
      }
      if (e.name === 'MarketBought') {
        const prev = this.db.query('SELECT tokens FROM v31_positions WHERE raiseAddr=? AND id=?').get(row.address, a.id) as { tokens: string } | null;
        this.db.query('INSERT OR REPLACE INTO v31_positions VALUES (?,?,?,?,?)').run(row.address, a.id, a.owner, 1, (BigInt(prev?.tokens ?? 0) + BigInt(a.trade.tokens)).toString());
      }
      if (['AtCostExited', 'ProtectedSplitExecuted', 'MarketSold'].includes(e.name)) {
        const prev = this.db.query('SELECT tokens FROM v31_positions WHERE raiseAddr=? AND id=?').get(row.address, a.id) as { tokens: string };
        this.db.query('UPDATE v31_positions SET tokens=? WHERE raiseAddr=? AND id=?').run((BigInt(prev.tokens) - BigInt(a.quantity ?? a.trade.tokens)).toString(), row.address, a.id);
      }
      if (e.name === 'DepthAdvanced') { state.V = a.newV; state.T = (BigInt(state.T) - BigInt(a.burn)).toString(); priceChanged = true; }
      if (e.name === 'BudgetHaircutApplied') {
        state.E = a.escrow; state.V = (BigInt(state.V) - BigInt(a.draw)).toString(); state.T = (BigInt(state.T) - BigInt(a.bookBurn)).toString();
        state.J = a.index; state.H = a.totalShares; priceChanged = true;
      }
      if (e.name === 'PhaseChanged') {
        state.stage2Start = Number(a.stage2Start); state.stage2End = Number(a.stage2End);
        if (Number(a.phase) === 1) {
          state.V = (2n * BigInt(state.E)).toString();
          state.T = (BigInt(state.V) * PRICE_SCALE / BigInt(JSON.parse(row.config).targetPrice)).toString();
        }
        if (Number(a.phase) === 4) Object.assign(state, { E: '0', R: '0', V: '0', T: '0', O: '0', dissolvedAt: e.timestamp });
        priceChanged = true;
      }
      if (e.name === 'ListingFinalized') {
        state.listingPrice = a.migration.price;
        Object.assign(state, { E: '0', R: '0', V: '0', T: '0', O: '0', phase: 3 }); priceChanged = true;
      }
      if (e.name === 'VetoChanged') state.vetoUntil = Number(a.vetoUntil);
      if (e.name === 'DissolvedByBuilder') state.dissolvedBy = 'builder';
      this.db.query('UPDATE v31_raises SET state=? WHERE address=?').run(JSON.stringify(state), row.address);
    }
    const cfg = e.name === 'RaiseConfigured' ? a.config : JSON.parse(row.config);
    const price = e.name === 'ListingFinalized' ? a.migration.price : bookPrice(state);
    if (priceChanged || e.name === 'RaiseConfigured') {
      this.db.query('INSERT OR REPLACE INTO v31_prices VALUES (?,?,?,?,?,?,?,?,?,?)').run(row.address,
        Number(state.phase) === 0 ? 'curve' : 'book', price, curvePrice(cfg, BigInt(state.sold)).toString(),
        JSON.stringify(state), e.name, e.timestamp, e.txHash, e.blockNumber, e.logIndex);
    }
    const types: Record<string, string> = { Deposited: 'deposit', AtCostExited: 'costExit', ProtectedSplitExecuted: 'protectedExit', MarketBought: 'buy', MarketSold: 'sell' };
    if (e.contract === 'raise' && types[e.name]) {
      this.db.query('INSERT OR REPLACE INTO v31_trades VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(row.address,
        types[e.name], a.owner, a.id, a.debit ?? a.result?.payout ?? (e.name === 'MarketBought' ? a.trade.gross : a.trade.net),
        a.tokens ?? a.quantity ?? a.trade.tokens, price, e.args, e.timestamp, e.txHash, e.blockNumber, e.logIndex);
    }
    if (e.contract === 'governor') {
      const prev = this.db.query('SELECT data FROM v31_proposals WHERE raiseAddr=? AND id=?').get(row.address, a.proposal) as { data: string } | null;
      const p: Args = prev ? JSON.parse(prev.data) : { yesWeight: '0', noWeight: '0', status: 1 };
      if (e.name === 'Proposed') Object.assign(p, a, { createdAt: e.timestamp });
      if (e.name === 'SpendProposed') Object.assign(p, { kind: Number(a.kind), mode: Number(a.mode), recipient: a.recipient, tokenAmount: a.tokenAmount, snapshotId: a.snapshotId });
      if (e.name === 'VoteChanged' || e.name === 'TokenVoteCast') {
        const key = a.support ? 'yesWeight' : 'noWeight';
        p[key] = (BigInt(p[key]) + (a.cancelled ? -1n : 1n) * BigInt(a.weight)).toString();
      }
      if (e.name === 'ProposalResolved') Object.assign(p, a, { executedTx: Number(a.status) === 4 ? e.txHash : p.executedTx ?? null });
      if (a.proposal !== undefined) this.db.query('INSERT OR REPLACE INTO v31_proposals VALUES (?,?,?)').run(row.address, a.proposal, JSON.stringify(p));
    }
  }
}
