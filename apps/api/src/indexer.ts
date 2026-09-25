/**
 * Indexer: discovers raises from RaiseFactory events, then follows each raise's
 * Raise/Stage2Pool/DiamondVault/AttestationBoard (and SpendGovernor, when its ABI exists)
 * events into SQLite.
 *
 * Properties:
 *  - idempotent:   UNIQUE(txHash, logIndex) on every derived table, INSERT OR IGNORE.
 *  - resumable:    meta.lastIndexedBlock advanced per page, inside the same transaction.
 *  - re-org safe:  only indexes up to head - CONFIRMATIONS; per-block hashes are stored and
 *                  verified each poll; on divergence everything ≥ the fork point is dropped
 *                  and raise aggregates are recomputed from the remaining events.
 *  - reset safe:   an anvil restart (head < lastIndexed, changed factory address, or changed
 *                  genesis hash) wipes the DB and re-indexes from scratch.
 */
import {
  decodeEventLog, keccak256, stringToHex, toEventSelector, getAddress,
  type PublicClient, type Abi, type Address, type Log,
} from 'viem';
import {
  RaiseFactoryAbi, RaiseAbi, Stage2PoolAbi, DiamondVaultAbi, AttestationBoardAbi,
  SpendGovernorAbi, hasGovernorAbi, ProjectTokenAbi, MockUSDGAbi,
} from './generated/abis.ts';
import { getMeta, setMeta, wipeAll, getRaise, type DB, type RaiseRow } from './db.ts';
import { getDeployment } from './chain.ts';
import type { Config } from './config.ts';

export const TEMPLATE_IDS: Record<string, string> = {
  [keccak256(stringToHex('ZERO_EXTRACTION')).toLowerCase()]: 'ZERO_EXTRACTION',
  [keccak256(stringToHex('MILESTONE_FUNDING')).toLowerCase()]: 'MILESTONE_FUNDING',
};

const STATE_NAMES = ['Incubation', 'Commitment', 'Growth', 'Migrated', 'Failed'] as const;

type Kind = 'factory' | 'raise' | 'pool' | 'vault' | 'board' | 'governor' | 'token';

const KIND_ABIS: Record<string, Abi> = {
  factory: RaiseFactoryAbi as Abi,
  raise: RaiseAbi as Abi,
  pool: Stage2PoolAbi as Abi,
  vault: DiamondVaultAbi as Abi,
  board: AttestationBoardAbi as Abi,
  governor: SpendGovernorAbi as Abi,
  token: ProjectTokenAbi as Abi,
};

// topic0 -> [{abi, eventName}] across every contract kind we decode.
const SELECTORS = new Map<string, { abi: Abi; eventName: string }[]>();
for (const [kind, abi] of Object.entries(KIND_ABIS)) {
  if (kind === 'governor' && !hasGovernorAbi) continue;
  for (const item of abi as readonly { type: string; name?: string }[]) {
    if (item.type !== 'event' || !item.name) continue;
    const sel = toEventSelector(item as never).toLowerCase();
    const list = SELECTORS.get(sel) ?? [];
    list.push({ abi, eventName: item.name });
    SELECTORS.set(sel, list);
  }
}

/** Recursively render bigints as decimal strings so event args survive JSON. */
export function jsonify(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(jsonify);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = jsonify(v);
    return out;
  }
  return value;
}

export interface IndexerStatus {
  lastIndexedBlock: number;
  head: number | null;
  headTimestamp: number | null;
  lastError: string | null;
  lastPollAt: number | null;
  deploymentPresent: boolean;
}

export class Indexer {
  private timer: ReturnType<typeof setInterval> | null = null;
  private polling = false;
  readonly status: IndexerStatus = {
    lastIndexedBlock: 0, head: null, headTimestamp: null, lastError: null, lastPollAt: null, deploymentPresent: false,
  };

  constructor(
    private db: DB,
    private client: PublicClient,
    private config: Config,
  ) {}

  start(): void {
    void this.poll();
    this.timer = setInterval(() => void this.poll(), this.config.pollMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private deployment(): Record<string, string | number> | null {
    return getDeployment(this.config.chainId);
  }

  /** address (lowercase) -> contract kind + owning raise, rebuilt from the DB each poll. */
  private addressKinds(): Map<string, { kind: Kind; raise: string | null }> {
    const map = new Map<string, { kind: Kind; raise: string | null }>();
    const dep = this.deployment();
    if (dep?.factory) map.set(String(dep.factory).toLowerCase(), { kind: 'factory', raise: null });
    if (dep?.attestationBoard) map.set(String(dep.attestationBoard).toLowerCase(), { kind: 'board', raise: null });
    for (const r of this.db.query('SELECT address, pool, vault, governor FROM raises').all() as RaiseRow[]) {
      map.set(r.address.toLowerCase(), { kind: 'raise', raise: r.address });
      map.set(r.pool.toLowerCase(), { kind: 'pool', raise: r.address });
      map.set(r.vault.toLowerCase(), { kind: 'vault', raise: r.address });
      if (r.governor) map.set(r.governor.toLowerCase(), { kind: 'governor', raise: r.address });
    }
    return map;
  }

  /** quote asset address (lowercase) -> decimals, fetched lazily (MockUSDG = 6). */
  private quoteDecimals = new Map<string, number>();

  /** 10^(36 − quoteDecimals): converts quote-atom/token-atom ratios to API prices (1e18-scaled). */
  private priceScale(row: RaiseRow): bigint {
    let asset = '';
    try { asset = String(JSON.parse(row.config).quoteAsset ?? '').toLowerCase(); } catch { /* config pending */ }
    const dec = (asset && this.quoteDecimals.get(asset)) || 6;
    return 10n ** BigInt(36 - dec);
  }

  /** Warm the quote-decimals cache for every indexed raise (async; called once per poll). */
  private async warmQuoteDecimals(): Promise<void> {
    for (const r of this.db.query('SELECT config FROM raises').all() as { config: string }[]) {
      let asset = '';
      try { asset = String(JSON.parse(r.config).quoteAsset ?? '').toLowerCase(); } catch { continue; }
      if (!asset || this.quoteDecimals.has(asset)) continue;
      try {
        const dec = await this.client.readContract({
          address: asset as Address, abi: MockUSDGAbi as Abi, functionName: 'decimals',
        } as never) as number;
        this.quoteDecimals.set(asset, Number(dec));
      } catch { /* keep default 6 */ }
    }
  }

  async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      await this.pollOnce();
      this.status.lastError = null;
    } catch (err) {
      this.status.lastError = err instanceof Error ? err.message : String(err);
    } finally {
      this.status.lastPollAt = Math.floor(Date.now() / 1000);
      this.polling = false;
    }
  }

  private async pollOnce(): Promise<void> {
    const dep = this.deployment();
    this.status.deploymentPresent = !!(dep?.factory && dep?.attestationBoard);
    if (!this.status.deploymentPresent) return; // server runs; health reports it; retry next poll

    await this.warmQuoteDecimals();

    const head = Number(await this.client.getBlockNumber());
    this.status.head = head;
    const genesis = await this.client.getBlock({ blockNumber: 0n });
    const headBlock = await this.client.getBlock({ blockNumber: BigInt(head) }).catch(() => null);
    this.status.headTimestamp = headBlock ? Number(headBlock.timestamp) : null;
    const factory = String(dep!.factory);

    // ---- chain reset detection ------------------------------------------
    const storedFactory = getMeta(this.db, 'factory');
    const storedGenesis = getMeta(this.db, 'genesisHash');
    let lastIndexed = Number(getMeta(this.db, 'lastIndexedBlock') ?? '0');
    if (
      (storedFactory && storedFactory.toLowerCase() !== factory.toLowerCase()) ||
      (storedGenesis && storedGenesis !== genesis.hash) ||
      (lastIndexed > 0 && head < lastIndexed)
    ) {
      this.reset(`chain reset detected (factory ${storedFactory} -> ${factory}, head ${head}, indexed ${lastIndexed})`);
      lastIndexed = 0;
    }
    if (!storedFactory) {
      setMeta(this.db, 'factory', factory);
      setMeta(this.db, 'genesisHash', genesis.hash!);
    }

    // ---- re-org check -----------------------------------------------------
    lastIndexed = Number(getMeta(this.db, 'lastIndexedBlock') ?? '0');
    if (lastIndexed > 0) {
      const fork = await this.findFork(lastIndexed);
      if (fork !== null) {
        this.rollback(fork);
        lastIndexed = fork - 1;
      }
    }

    const target = head - this.config.confirmations;
    if (target <= lastIndexed) {
      this.status.lastIndexedBlock = lastIndexed;
      return;
    }

    // ---- page through [lastIndexed+1, target] ------------------------------
    let from = lastIndexed + 1;
    while (from <= target) {
      const to = Math.min(from + this.config.logPage - 1, target);
      await this.indexRange(from, to);
      from = to + 1;
    }
    this.status.lastIndexedBlock = Number(getMeta(this.db, 'lastIndexedBlock') ?? '0');

    // Repair rows whose live-read config/name was not available at discovery time.
    const incomplete = this.db.query(
      `SELECT address FROM raises WHERE config = '{}' OR deadlineAt = 0 OR name = ''`,
    ).all() as { address: string }[];
    for (const r of incomplete) await this.repairRaise(r.address);
  }

  private reset(reason: string): void {
    console.warn(`[indexer] ${reason} — wiping database and re-indexing`);
    wipeAll(this.db);
    const dep = this.deployment();
    setMeta(this.db, 'factory', String(dep!.factory));
    setMeta(this.db, 'lastIndexedBlock', '0');
  }

  /** Smallest stored block number whose hash no longer matches the chain, or null. */
  private async findFork(lastIndexed: number): Promise<number | null> {
    const rows = this.db.query(
      'SELECT number, hash FROM blocks WHERE number > ? ORDER BY number ASC',
    ).all(Math.max(0, lastIndexed - 64)) as { number: number; hash: string }[];
    if (rows.length === 0) return null;
    const blocks = await Promise.all(
      rows.map((r) => this.client.getBlock({ blockNumber: BigInt(r.number) }).catch(() => null)),
    );
    for (let i = 0; i < rows.length; i++) {
      const b = blocks[i];
      if (!b || !b.hash || b.hash.toLowerCase() !== rows[i].hash.toLowerCase()) return rows[i].number;
    }
    return null;
  }

  private rollback(fromBlock: number): void {
    console.warn(`[indexer] re-org detected at block ${fromBlock} — rolling back`);
    const affected = new Set(
      (this.db.query('SELECT DISTINCT raiseAddr FROM events WHERE blockNumber >= ? AND raiseAddr IS NOT NULL').all(fromBlock) as { raiseAddr: string }[]).map((r) => r.raiseAddr),
    );
    const tx = this.db.transaction(() => {
      for (const t of ['events', 'flows', 'trades', 'price_points', 'blocks']) {
        this.db.query(`DELETE FROM ${t} WHERE blockNumber >= ?`).run(fromBlock);
      }
      this.db.query('DELETE FROM raises WHERE blockNumber >= ?').run(fromBlock);
      for (const addr of affected) this.db.query('DELETE FROM proposals WHERE raiseAddr = ?').run(addr);
      setMeta(this.db, 'lastIndexedBlock', String(fromBlock - 1));
    });
    tx();
    for (const addr of affected) {
      if (getRaise(this.db, addr)) this.recomputeRaise(addr);
    }
  }

  private async indexRange(from: number, to: number): Promise<void> {
    const dep = this.deployment()!;
    const factory = String(dep.factory) as Address;

    // Phase 1: factory logs first — a raise created inside this range must be registered
    // before we choose which addresses to watch, otherwise its own raise/pool/governor
    // events in this same range would never be fetched (the watched set would be stale).
    const factoryLogs = await this.client.getLogs({
      address: factory, fromBlock: BigInt(from), toBlock: BigInt(to),
    });
    await this.ensureBlocks(factoryLogs.map((l) => Number(l.blockNumber)));
    const txFactory = this.db.transaction(() => {
      const kinds = this.addressKinds();
      for (const log of factoryLogs) this.processLog(log, kinds);
    });
    txFactory();

    // Phase 2: everything watched (now including raises created in this range).
    const kinds = this.addressKinds();
    const watched = [...kinds.keys()] as Address[];
    const logs = watched.length
      ? await this.client.getLogs({ address: watched, fromBlock: BigInt(from), toBlock: BigInt(to) })
      : [];
    logs.sort((a, b) => Number(a.blockNumber - b.blockNumber) || Number(a.logIndex - b.logIndex));

    await this.ensureBlocks(logs.map((l) => Number(l.blockNumber)));

    // factory logs arrive twice (phase 1 + watched set) — UNIQUE constraints keep it idempotent.
    const tx = this.db.transaction(() => {
      for (const log of logs) this.processLog(log, kinds);
      setMeta(this.db, 'lastIndexedBlock', String(to));
    });
    tx();
  }

  private async ensureBlocks(numbers: number[]): Promise<void> {
    const missing = [...new Set(numbers)].filter(
      (n) => !this.db.query('SELECT 1 FROM blocks WHERE number = ?').get(n),
    );
    if (missing.length === 0) return;
    const fetched = await Promise.all(
      missing.map((n) => this.client.getBlock({ blockNumber: BigInt(n) })),
    );
    const stmt = this.db.query('INSERT OR IGNORE INTO blocks (number, hash, timestamp) VALUES (?, ?, ?)');
    for (const b of fetched) stmt.run(Number(b.number), b.hash!, Number(b.timestamp));
  }

  private blockTimestamp(n: number): number {
    const row = this.db.query('SELECT timestamp FROM blocks WHERE number = ?').get(n) as { timestamp: number } | null;
    return row?.timestamp ?? 0;
  }

  private decode(log: Log): { name: string; args: Record<string, unknown> } | null {
    const topic0 = log.topics[0]?.toLowerCase();
    if (!topic0) return null;
    const candidates = SELECTORS.get(topic0);
    if (!candidates) return null;
    for (const { abi } of candidates) {
      try {
        const decoded = decodeEventLog({ abi, data: log.data, topics: log.topics as never });
        if (!decoded.eventName) continue;
        return { name: String(decoded.eventName), args: jsonify(decoded.args) as Record<string, unknown> };
      } catch { /* try the next ABI sharing this selector */ }
    }
    return null;
  }

  private processLog(log: Log, kinds: Map<string, { kind: Kind; raise: string | null }>): void {
    const addr = log.address.toLowerCase();
    let entry = kinds.get(addr);
    // factory logs arrive twice (phase 1 + watched set) — UNIQUE constraints keep it idempotent.
    if (!entry) {
      const dep = this.deployment();
      if (dep?.factory && addr === String(dep.factory).toLowerCase()) entry = { kind: 'factory', raise: null };
      else return;
    }
    const kind = entry.kind;
    const decoded = this.decode(log);
    if (!decoded) return;
    const blockNumber = Number(log.blockNumber);
    const logIndex = Number(log.logIndex);
    const ts = this.blockTimestamp(blockNumber);

    // Which raise does this event belong to?
    let raiseAddr: string | null = entry.raise;
    if (kind === 'factory' && decoded.name === 'RaiseCreated') raiseAddr = String(decoded.args.raise).toLowerCase();
    if (kind === 'board' && decoded.args.raise) raiseAddr = String(decoded.args.raise).toLowerCase();

    this.db.query(
      `INSERT OR IGNORE INTO events (raiseAddr, contract, name, args, address, txHash, blockNumber, logIndex, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(raiseAddr, kind, decoded.name, JSON.stringify(decoded.args), addr,
      log.transactionHash, blockNumber, logIndex, ts);

    this.applyDerived(kind, decoded.name, decoded.args, log, blockNumber, logIndex, ts, raiseAddr);
  }

  // ---- derived-table updates ------------------------------------------------

  private applyDerived(
    kind: Kind, name: string, args: Record<string, unknown>,
    log: Log, blockNumber: number, logIndex: number, ts: number,
    raiseAddr: string | null,
  ): void {
    if (kind === 'factory') {
      if (name === 'RaiseCreated') this.onRaiseCreated(args, log, blockNumber, ts);
      return;
    }
    if (kind === 'raise') return this.onRaiseEvent(name, args, log, blockNumber, logIndex, ts);
    if (kind === 'pool' && raiseAddr) return this.onPoolEvent(name, args, log, blockNumber, logIndex, ts, raiseAddr);
    if (kind === 'board') return this.onBoardEvent(name, args);
    if (kind === 'governor' && raiseAddr) return this.onGovernorEvent(name, args, log, blockNumber, raiseAddr);
  }

  private onRaiseCreated(args: Record<string, unknown>, log: Log, blockNumber: number, ts: number): void {
    const raise = String(args.raise);
    const existing = getRaise(this.db, raise);
    if (existing) return;

    const templateId = String(args.templateId).toLowerCase();
    const governor = args.governor && String(args.governor) !== '0x0000000000000000000000000000000000000000'
      ? getAddress(String(args.governor)) : null;
    const templateName = TEMPLATE_IDS[templateId] ?? (governor ? 'MILESTONE_FUNDING' : 'ZERO_EXTRACTION');

    // Name/symbol come from the adjacent RaiseConfigured log in the same tx; fall back to
    // reading the token contract (async work is done outside the sqlite transaction by the
    // caller path — here we synchronously use what the same-tx logs already inserted).
    let name = ''; let symbol = '';
    const cfgLog = this.db.query(
      `SELECT args FROM events WHERE contract = 'factory' AND name = 'RaiseConfigured' AND txHash = ?`,
    ).get(log.transactionHash) as { args: string } | null;
    if (cfgLog) {
      const a = JSON.parse(cfgLog.args) as { tokenName?: string; tokenSymbol?: string };
      name = a.tokenName ?? '';
      symbol = a.tokenSymbol ?? '';
    }

    // Config + start time: read live from the chain (fire-and-forget safe: poll retries on error
    // would leave config '{}', so instead we lazily repair in repairRaise()).
    const row: RaiseRow = {
      address: getAddress(raise),
      builder: getAddress(String(args.builder)),
      templateId, templateName,
      version: Number(args.version),
      name, symbol,
      token: getAddress(String(args.token)),
      pool: getAddress(String(args.pool)),
      vault: getAddress(String(args.vault)),
      governor,
      config: '{}',
      description: '', website: '', profile: '{}',
      state: 'Incubation',
      totalPrincipal: '0', committedPrincipal: '0',
      createdAt: ts, start: ts, deadlineAt: 0,
      commitmentStart: null, commitmentEnd: null, growthStart: null, migrationTime: null,
      bookPrice: null, realRatioBps: null, poolOpen: 0, vetoUntil: 0,
      blockNumber, txHash: log.transactionHash!,
    };
    this.db.query(
      `INSERT OR IGNORE INTO raises (address, builder, templateId, templateName, version, name, symbol,
        token, pool, vault, governor, config, description, website, state, totalPrincipal,
        committedPrincipal, createdAt, start, deadlineAt, blockNumber, txHash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(row.address, row.builder, row.templateId, row.templateName, row.version, row.name,
      row.symbol, row.token, row.pool, row.vault, row.governor, row.config, row.description,
      row.website, row.state, row.totalPrincipal, row.committedPrincipal, row.createdAt,
      row.start, row.deadlineAt, row.blockNumber, row.txHash);
  }

  /** Fill config/name/symbol/start/deadlineAt for a raise row that lacks them (live reads). */
  async repairRaise(address: string): Promise<void> {
    const row = getRaise(this.db, address);
    if (!row) return;
    const needsConfig = row.config === '{}' || row.deadlineAt === 0 || !row.name;
    if (!needsConfig) return;
    const addr = row.address as Address;
    const calls = [
      { address: addr, abi: RaiseAbi as Abi, functionName: 'getConfig' },
      { address: addr, abi: RaiseAbi as Abi, functionName: 'raiseInfo' },
      ...(!row.name ? [
        { address: row.token as Address, abi: ProjectTokenAbi as Abi, functionName: 'name' },
        { address: row.token as Address, abi: ProjectTokenAbi as Abi, functionName: 'symbol' },
      ] : []),
    ];
    const results = await Promise.all(
      calls.map((c) => this.client.readContract(c as never).catch(() => null)),
    );
    const [cfg, info, tokenName, tokenSymbol] = results as [
      Record<string, unknown> | null,
      (Record<string, unknown> & unknown[]) | null,
      string | null, string | null,
    ];
    if (!cfg) return;
    const configJson: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(cfg)) {
      if (typeof v === 'bigint') configJson[k] = v.toString();
      else if (typeof v === 'number' || typeof v === 'string') configJson[k] = v;
      else if (v && typeof v === 'object') {
        // nested struct (e.g. GovernorConfig): stringify one level deep
        const nested: Record<string, string | number> = {};
        for (const [nk, nv] of Object.entries(v as Record<string, unknown>)) {
          if (typeof nv === 'bigint') nested[nk] = nv.toString();
          else if (typeof nv === 'number' || typeof nv === 'string') nested[nk] = nv;
        }
        configJson[k] = nested;
      }
    }
    const start = info ? Number(info.start_ ?? info[1]) : row.start;
    const deadlineAt = start + Number(configJson.deadline ?? 0);
    this.db.query(
      'UPDATE raises SET config = ?, start = ?, deadlineAt = ?, name = ?, symbol = ? WHERE address = ?',
    ).run(JSON.stringify(configJson), start, deadlineAt,
      row.name || tokenName || '', row.symbol || tokenSymbol || '', row.address);
  }

  private setRaiseField(address: string, field: string, value: unknown): void {
    this.db.query(`UPDATE raises SET ${field} = ? WHERE address = ? COLLATE NOCASE`).run(value as never, address);
  }

  private onRaiseEvent(
    name: string, args: Record<string, unknown>, log: Log,
    blockNumber: number, logIndex: number, ts: number,
  ): void {
    const raise = log.address.toLowerCase();
    switch (name) {
      case 'Deposited':
        this.insertFlow(raise, String(args.user), String(args.amount), 'deposit', log, blockNumber, logIndex, ts);
        this.setRaiseField(raise, 'totalPrincipal', String(args.totalPrincipal));
        break;
      case 'Withdrawn':
        this.insertFlow(raise, String(args.user), `-${args.amount}`, 'withdraw', log, blockNumber, logIndex, ts);
        this.setRaiseField(raise, 'totalPrincipal', String(args.totalPrincipal));
        break;
      case 'CommitmentStarted':
        this.setRaiseField(raise, 'state', 'Commitment');
        this.setRaiseField(raise, 'totalPrincipal', String(args.totalPrincipal));
        this.setRaiseField(raise, 'commitmentStart', Number(args.commitmentStart));
        this.setRaiseField(raise, 'commitmentEnd', Number(args.commitmentEnd));
        break;
      case 'GrowthOpened':
        this.setRaiseField(raise, 'state', 'Growth');
        this.setRaiseField(raise, 'growthStart', Number(args.growthStart));
        this.setRaiseField(raise, 'committedPrincipal', String(args.committedPrincipal));
        break;
      case 'Migrated':
        this.setRaiseField(raise, 'state', 'Migrated');
        this.setRaiseField(raise, 'migrationTime', Number(args.migrationTime));
        break;
      case 'RaiseFailed':
        this.setRaiseField(raise, 'state', 'Failed');
        break;
      case 'TrancheCommitted':
        this.bumpBigint(raise, 'committedPrincipal', BigInt(String(args.principal)));
        break;
      case 'TrancheRedeemed':
        this.insertFlow(raise, String(args.user), `-${args.principal}`, 'redeem', log, blockNumber, logIndex, ts);
        this.bumpBigint(raise, 'totalPrincipal', -BigInt(String(args.principal)));
        break;
      case 'GovernorSpend':
        this.bumpBigint(raise, 'totalPrincipal', -BigInt(String(args.amount)));
        break;
      default:
        break;
    }
  }

  private bumpBigint(address: string, field: 'totalPrincipal' | 'committedPrincipal', delta: bigint): void {
    const row = getRaise(this.db, address);
    if (!row) return;
    const cur = BigInt(row[field] || '0');
    let next = cur + delta;
    if (next < 0n) next = 0n;
    this.setRaiseField(address, field, next.toString());
  }

  private insertFlow(
    raise: string, user: string, delta: string, kind: string,
    log: Log, blockNumber: number, logIndex: number, ts: number,
  ): void {
    this.db.query(
      `INSERT OR IGNORE INTO flows (raiseAddr, user, delta, kind, txHash, blockNumber, logIndex, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(raise, getAddress(user), delta, kind, log.transactionHash, blockNumber, logIndex, ts);
  }

  private onPoolEvent(
    name: string, args: Record<string, unknown>, log: Log,
    blockNumber: number, logIndex: number, ts: number, raiseAddr: string,
  ): void {
    const row = getRaise(this.db, raiseAddr);
    if (!row) return;
    const raise = row.address.toLowerCase();

    if (name === 'PoolOpened' || name === 'Converted' || name === 'Buy' || name === 'Sell') {
      const R = name === 'PoolOpened' ? 0n : BigInt(String(args.R));
      const V = name === 'PoolOpened' ? BigInt(String(args.V0)) : BigInt(String(args.V));
      const T = name === 'PoolOpened' ? BigInt(String(args.T0)) : BigInt(String(args.T));
      const scale = this.priceScale(row);
      const price = T > 0n ? ((R + V) * scale / T).toString() : '0';
      const realRatioBps = R + V > 0n ? Number(R * 10000n / (R + V)) : 0;
      this.db.query(
        `INSERT OR IGNORE INTO price_points (raiseAddr, timestamp, price, realRatioBps, R, V, txHash, blockNumber, logIndex)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(row.address, ts, price, realRatioBps, R.toString(), V.toString(),
        log.transactionHash, blockNumber, logIndex);
      this.setRaiseField(raise, 'poolOpen', 1);
      this.setRaiseField(raise, 'bookPrice', price);
      this.setRaiseField(raise, 'realRatioBps', realRatioBps);
    }

    if (name === 'Buy' || name === 'Sell') {
      const quote = BigInt(String(name === 'Buy' ? args.quoteIn : args.quoteOut));
      const tokens = BigInt(String(name === 'Buy' ? args.tokensOut : args.tokensIn));
      const price = tokens > 0n ? (quote * this.priceScale(row) / tokens).toString() : '0';
      this.db.query(
        `INSERT OR IGNORE INTO trades (raiseAddr, type, trader, quote, tokens, price, R, V, T, txHash, blockNumber, logIndex, timestamp)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(row.address, name.toLowerCase(), getAddress(String(args.trader)), quote.toString(),
        tokens.toString(), price, String(args.R), String(args.V), String(args.T),
        log.transactionHash, blockNumber, logIndex, ts);
    }
  }

  private onBoardEvent(name: string, args: Record<string, unknown>): void {
    const raise = args.raise ? String(args.raise) : null;
    if (!raise) return;
    if (name === 'ReportPosted') this.setRaiseField(raise, 'vetoUntil', Number(args.vetoUntil ?? 0));
    if (name === 'VetoCleared') this.setRaiseField(raise, 'vetoUntil', 0);
  }

  /**
   * Rule 2 proposal tracking against the real SpendGovernor ABI:
   * Proposed / Voted / Finalized / Executed / Expired / VoteLockReleased.
   * The stored `state` is the raw on-chain status (Active|Passed|Defeated|Executed|Expired);
   * the API derives the precise public enum (Voting|Dispute|Executable|…) from it and chain time.
   */
  private onGovernorEvent(name: string, args: Record<string, unknown>, log: Log, blockNumber: number, raiseAddr: string): void {
    if (!hasGovernorAbi) return;
    const raise = raiseAddr.toLowerCase();
    const ts = this.blockTimestamp(blockNumber);
    try {
      const id = Number(args.id);
      if (!Number.isFinite(id)) return;
      if (name === 'Proposed') {
        this.db.query(
          `INSERT INTO proposals (raiseAddr, id, amount, uri, state, yesPrincipal, noPrincipal,
             principalSnapshot, createdAt, votingEndsAt, disputeEndsAt, executedTx, blockNumber)
           VALUES (?, ?, ?, ?, 'Active', '0', '0', ?, ?, ?, ?, NULL, ?)
           ON CONFLICT(raiseAddr, id) DO UPDATE SET amount = excluded.amount, uri = excluded.uri,
             principalSnapshot = excluded.principalSnapshot, votingEndsAt = excluded.votingEndsAt,
             disputeEndsAt = excluded.disputeEndsAt`,
        ).run(raise, id, String(args.amount ?? '0'), String(args.uri ?? ''),
          String(args.totalPrincipalSnapshot ?? '0'), ts,
          args.votingEnds !== undefined ? Number(args.votingEnds) : null,
          args.disputeEnds !== undefined ? Number(args.disputeEnds) : null,
          blockNumber);
      } else if (name === 'Voted') {
        const weight = BigInt(String(args.weight ?? '0'));
        const field = args.support ? 'yesPrincipal' : 'noPrincipal';
        const cur = this.db.query('SELECT yesPrincipal, noPrincipal FROM proposals WHERE raiseAddr = ? AND id = ?')
          .get(raise, id) as { yesPrincipal: string; noPrincipal: string } | null;
        if (cur) {
          const next = (BigInt(cur[field] || '0') + weight).toString();
          this.db.query(`UPDATE proposals SET ${field} = ? WHERE raiseAddr = ? AND id = ?`).run(next, raise, id);
        }
      } else if (name === 'Finalized') {
        this.db.query(
          `UPDATE proposals SET state = ?, yesPrincipal = ?, noPrincipal = ? WHERE raiseAddr = ? AND id = ?`,
        ).run(args.passed ? 'Passed' : 'Defeated', String(args.yesPrincipal ?? '0'),
          String(args.noPrincipal ?? '0'), raise, id);
      } else if (name === 'Executed') {
        this.db.query(`UPDATE proposals SET state = 'Executed', executedTx = ? WHERE raiseAddr = ? AND id = ?`)
          .run(log.transactionHash, raise, id);
      } else if (name === 'Expired') {
        this.db.query(`UPDATE proposals SET state = 'Expired' WHERE raiseAddr = ? AND id = ?`).run(raise, id);
      }
      // VoteLockReleased: no proposal-level state change worth storing.
    } catch { /* unknown governor event shape — degrade gracefully */ }
  }

  /** Recompute a raise's aggregate columns by replaying its remaining events (post-rollback). */
  private recomputeRaise(address: string): void {
    const row = getRaise(this.db, address);
    if (!row) return;
    this.db.query(
      `UPDATE raises SET state = 'Incubation', totalPrincipal = '0', committedPrincipal = '0',
       commitmentStart = NULL, commitmentEnd = NULL, growthStart = NULL, migrationTime = NULL,
       bookPrice = NULL, realRatioBps = NULL, poolOpen = 0, vetoUntil = 0 WHERE address = ?`,
    ).run(row.address);
    const events = this.db.query(
      'SELECT contract, name, args, txHash, blockNumber, logIndex, timestamp, address FROM events WHERE raiseAddr = ? ORDER BY blockNumber, logIndex',
    ).all(row.address.toLowerCase()) as {
      contract: string; name: string; args: string; txHash: string; blockNumber: number;
      logIndex: number; timestamp: number; address: string;
    }[];
    for (const e of events) {
      const fakeLog = { address: e.address, transactionHash: e.txHash } as Log;
      if (e.contract === 'raise') this.onRaiseEvent(e.name, JSON.parse(e.args), fakeLog, e.blockNumber, e.logIndex, e.timestamp);
      if (e.contract === 'pool') this.onPoolEvent(e.name, JSON.parse(e.args), fakeLog, e.blockNumber, e.logIndex, e.timestamp, row.address);
      if (e.contract === 'board') this.onBoardEvent(e.name, JSON.parse(e.args));
      if (e.contract === 'governor') this.onGovernorEvent(e.name, JSON.parse(e.args), fakeLog, e.blockNumber, row.address);
    }
  }
}

/** Number of distinct backers (users with a positive net principal position) for a raise. */
export function backerCount(db: DB, raise: string): number {
  const rows = db.query('SELECT user, delta FROM flows WHERE raiseAddr = ? COLLATE NOCASE').all(raise) as { user: string; delta: string }[];
  const totals = new Map<string, bigint>();
  for (const r of rows) totals.set(r.user.toLowerCase(), (totals.get(r.user.toLowerCase()) ?? 0n) + BigInt(r.delta));
  let n = 0;
  for (const v of totals.values()) if (v > 0n) n++;
  return n;
}

export function stateName(n: number): string {
  return STATE_NAMES[n] ?? 'Incubation';
}
