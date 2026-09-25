import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type DB = Database;

export function openDb(path: string): DB {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  migrate(db);
  return db;
}

function migrate(db: DB): void {
  db.exec(`
  CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS blocks (
    number INTEGER PRIMARY KEY,
    hash TEXT NOT NULL,
    timestamp INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS raises (
    address TEXT PRIMARY KEY,
    builder TEXT NOT NULL,
    templateId TEXT NOT NULL,
    templateName TEXT NOT NULL,
    version INTEGER NOT NULL,
    name TEXT NOT NULL,
    symbol TEXT NOT NULL,
    token TEXT NOT NULL,
    pool TEXT NOT NULL,
    vault TEXT NOT NULL,
    governor TEXT,
    config TEXT NOT NULL,              -- JSON: RaiseConfig, uint values as decimal strings
    description TEXT NOT NULL DEFAULT '',
    website TEXT NOT NULL DEFAULT '',
    state TEXT NOT NULL DEFAULT 'Incubation',
    totalPrincipal TEXT NOT NULL DEFAULT '0',
    committedPrincipal TEXT NOT NULL DEFAULT '0',
    createdAt INTEGER NOT NULL,
    start INTEGER NOT NULL,
    deadlineAt INTEGER NOT NULL,
    commitmentStart INTEGER,
    commitmentEnd INTEGER,
    growthStart INTEGER,
    migrationTime INTEGER,
    bookPrice TEXT,
    realRatioBps INTEGER,
    poolOpen INTEGER NOT NULL DEFAULT 0,
    vetoUntil INTEGER NOT NULL DEFAULT 0,
    blockNumber INTEGER NOT NULL,
    txHash TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    raiseAddr TEXT,
    contract TEXT NOT NULL,            -- factory|raise|pool|vault|board|governor
    name TEXT NOT NULL,
    args TEXT NOT NULL,                -- JSON (bigints rendered as decimal strings)
    address TEXT NOT NULL,
    txHash TEXT NOT NULL,
    blockNumber INTEGER NOT NULL,
    logIndex INTEGER NOT NULL,
    timestamp INTEGER NOT NULL,
    UNIQUE(txHash, logIndex)
  );
  CREATE INDEX IF NOT EXISTS idx_events_raise ON events(raiseAddr, blockNumber, logIndex);
  CREATE INDEX IF NOT EXISTS idx_events_block ON events(blockNumber);
  CREATE TABLE IF NOT EXISTS flows (   -- signed principal movements per user (deposit/withdraw/redeem)
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    raiseAddr TEXT NOT NULL,
    user TEXT NOT NULL,
    delta TEXT NOT NULL,               -- signed decimal string (quote units)
    kind TEXT NOT NULL,
    txHash TEXT NOT NULL,
    blockNumber INTEGER NOT NULL,
    logIndex INTEGER NOT NULL,
    timestamp INTEGER NOT NULL,
    UNIQUE(txHash, logIndex)
  );
  CREATE INDEX IF NOT EXISTS idx_flows_raise ON flows(raiseAddr, user);
  CREATE TABLE IF NOT EXISTS trades (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    raiseAddr TEXT NOT NULL,
    type TEXT NOT NULL,                -- buy|sell
    trader TEXT NOT NULL,
    quote TEXT NOT NULL,
    tokens TEXT NOT NULL,
    price TEXT NOT NULL,               -- quote per whole token, 1e18-scaled
    R TEXT NOT NULL, V TEXT NOT NULL, T TEXT NOT NULL,
    txHash TEXT NOT NULL,
    blockNumber INTEGER NOT NULL,
    logIndex INTEGER NOT NULL,
    timestamp INTEGER NOT NULL,
    UNIQUE(txHash, logIndex)
  );
  CREATE INDEX IF NOT EXISTS idx_trades_raise ON trades(raiseAddr, blockNumber DESC);
  CREATE TABLE IF NOT EXISTS price_points (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    raiseAddr TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    price TEXT NOT NULL,
    realRatioBps INTEGER NOT NULL,
    R TEXT NOT NULL, V TEXT NOT NULL,
    txHash TEXT NOT NULL,
    blockNumber INTEGER NOT NULL,
    logIndex INTEGER NOT NULL,
    UNIQUE(txHash, logIndex)
  );
  CREATE INDEX IF NOT EXISTS idx_pp_raise ON price_points(raiseAddr, blockNumber);
  CREATE TABLE IF NOT EXISTS reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    raiseAddr TEXT NOT NULL,
    createdAt INTEGER NOT NULL,
    riskScoreBps INTEGER NOT NULL,
    veto INTEGER NOT NULL,
    findings TEXT NOT NULL,            -- JSON
    metrics TEXT NOT NULL,             -- JSON
    panel TEXT NOT NULL,               -- JSON
    reportHash TEXT NOT NULL,
    uri TEXT NOT NULL,
    postedTx TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_reports_raise ON reports(raiseAddr, id DESC);
  CREATE TABLE IF NOT EXISTS feedback (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    raiseAddr TEXT NOT NULL,
    author TEXT NOT NULL,
    createdAt INTEGER NOT NULL,
    rating INTEGER NOT NULL,
    text TEXT NOT NULL,
    isBacker INTEGER NOT NULL,
    signature TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_feedback_raise ON feedback(raiseAddr, id DESC);
  CREATE TABLE IF NOT EXISTS proposals (
    raiseAddr TEXT NOT NULL,
    id INTEGER NOT NULL,
    amount TEXT,
    uri TEXT,
    state TEXT,                        -- raw on-chain status: Active|Passed|Defeated|Executed|Expired
    yesPrincipal TEXT,
    noPrincipal TEXT,
    principalSnapshot TEXT NOT NULL DEFAULT '0',
    createdAt INTEGER NOT NULL DEFAULT 0,
    votingEndsAt INTEGER,
    disputeEndsAt INTEGER,
    executedTx TEXT,
    blockNumber INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY(raiseAddr, id)
  );
  CREATE TABLE IF NOT EXISTS quote_funding (  -- cache: who funded a wallet with quote tokens
    user TEXT PRIMARY KEY,
    funder TEXT,                       -- null => self/mint (no single external funder)
    amount TEXT NOT NULL DEFAULT '0'
  );
  CREATE TABLE IF NOT EXISTS updates (  -- builder-posted project updates (off-chain, signed)
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    raiseAddr TEXT NOT NULL,
    author TEXT NOT NULL,
    createdAt INTEGER NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    kind TEXT NOT NULL,                -- milestone|update|incident
    signature TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_updates_raise ON updates(raiseAddr, id DESC);
  `);
  // Additive migrations for databases created before these columns existed.
  for (const ddl of [
    `ALTER TABLE proposals ADD COLUMN principalSnapshot TEXT NOT NULL DEFAULT '0'`,
    `ALTER TABLE proposals ADD COLUMN createdAt INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE raises ADD COLUMN profile TEXT NOT NULL DEFAULT '{}'`,
    `ALTER TABLE reports ADD COLUMN builderResponse TEXT`,
    `ALTER TABLE reports ADD COLUMN builderResponseAt INTEGER`,
  ]) {
    try { db.exec(ddl); } catch { /* column already present */ }
  }
}

// ---- meta helpers ----------------------------------------------------------

export function getMeta(db: DB, key: string): string | null {
  const row = db.query('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | null;
  return row?.value ?? null;
}

export function setMeta(db: DB, key: string, value: string): void {
  db.query('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, value);
}

export function wipeAll(db: DB): void {
  db.exec(`
    DELETE FROM blocks; DELETE FROM raises; DELETE FROM events; DELETE FROM flows;
    DELETE FROM trades; DELETE FROM price_points; DELETE FROM reports; DELETE FROM feedback;
    DELETE FROM proposals; DELETE FROM quote_funding; DELETE FROM updates; DELETE FROM meta;
  `);
}

// ---- misc row types ----------------------------------------------------------

export interface RaiseRow {
  address: string; builder: string; templateId: string; templateName: string; version: number;
  name: string; symbol: string; token: string; pool: string; vault: string; governor: string | null;
  config: string; description: string; website: string; profile: string; state: string;
  totalPrincipal: string; committedPrincipal: string;
  createdAt: number; start: number; deadlineAt: number;
  commitmentStart: number | null; commitmentEnd: number | null;
  growthStart: number | null; migrationTime: number | null;
  bookPrice: string | null; realRatioBps: number | null; poolOpen: number; vetoUntil: number;
  blockNumber: number; txHash: string;
}

export function getRaise(db: DB, address: string): RaiseRow | null {
  return (db.query('SELECT * FROM raises WHERE address = ? COLLATE NOCASE').get(address) as RaiseRow | null) ?? null;
}

export function listRaises(db: DB, state?: string): RaiseRow[] {
  if (state) {
    return db.query('SELECT * FROM raises WHERE state = ? ORDER BY createdAt DESC, blockNumber DESC').all(state) as RaiseRow[];
  }
  return db.query('SELECT * FROM raises ORDER BY createdAt DESC, blockNumber DESC').all() as RaiseRow[];
}
