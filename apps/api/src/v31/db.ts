import type { DB } from '../db.ts';
import { migrateStateV31 } from './state-db.ts';

export interface RaiseV31Row {
  address: string; builder: string; templateId: string; version: number;
  token: string; governor: string; vesting: string; claims: string; adapter: string;
  name: string; symbol: string; config: string; state: string;
  createdAt: number; blockNumber: number; txHash: string;
}
export interface EventV31Row {
  raiseAddr: string | null; contract: string; name: string; args: string; address: string;
  txHash: string; blockNumber: number; logIndex: number; timestamp: number;
}
export function migrateV31(db: DB): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS v31_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS v31_blocks (number INTEGER PRIMARY KEY, hash TEXT NOT NULL, timestamp INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS v31_raises (
      address TEXT PRIMARY KEY COLLATE NOCASE, builder TEXT NOT NULL, templateId TEXT NOT NULL,
      version INTEGER NOT NULL, token TEXT NOT NULL, governor TEXT NOT NULL, vesting TEXT NOT NULL,
      claims TEXT NOT NULL, adapter TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', symbol TEXT NOT NULL DEFAULT '',
      config TEXT NOT NULL DEFAULT '{}', state TEXT NOT NULL DEFAULT '{}',
      createdAt INTEGER NOT NULL, blockNumber INTEGER NOT NULL, txHash TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS v31_events (
      raiseAddr TEXT COLLATE NOCASE, contract TEXT NOT NULL, name TEXT NOT NULL, args TEXT NOT NULL,
      address TEXT NOT NULL, txHash TEXT NOT NULL, blockNumber INTEGER NOT NULL, logIndex INTEGER NOT NULL,
      timestamp INTEGER NOT NULL, PRIMARY KEY(txHash, logIndex)
    );
    CREATE INDEX IF NOT EXISTS v31_events_raise ON v31_events(raiseAddr, blockNumber, logIndex);
    CREATE TABLE IF NOT EXISTS v31_positions (
      raiseAddr TEXT COLLATE NOCASE, id TEXT NOT NULL, owner TEXT COLLATE NOCASE NOT NULL,
      class INTEGER NOT NULL, tokens TEXT NOT NULL, PRIMARY KEY(raiseAddr,id)
    );
    CREATE INDEX IF NOT EXISTS v31_positions_owner ON v31_positions(owner,raiseAddr);
    CREATE TABLE IF NOT EXISTS v31_prices (
      raiseAddr TEXT COLLATE NOCASE, kind TEXT NOT NULL, price TEXT, curvePrice TEXT NOT NULL,
      balances TEXT NOT NULL, event TEXT NOT NULL, timestamp INTEGER NOT NULL,
      txHash TEXT NOT NULL, blockNumber INTEGER NOT NULL, logIndex INTEGER NOT NULL,
      PRIMARY KEY(txHash,logIndex)
    );
    CREATE TABLE IF NOT EXISTS v31_trades (
      raiseAddr TEXT COLLATE NOCASE, type TEXT NOT NULL, trader TEXT NOT NULL, positionId TEXT NOT NULL,
      quote TEXT NOT NULL, tokens TEXT NOT NULL, price TEXT, data TEXT NOT NULL,
      timestamp INTEGER NOT NULL, txHash TEXT NOT NULL, blockNumber INTEGER NOT NULL, logIndex INTEGER NOT NULL,
      PRIMARY KEY(txHash,logIndex)
    );
    CREATE TABLE IF NOT EXISTS v31_proposals (
      raiseAddr TEXT COLLATE NOCASE, id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(raiseAddr,id)
    );
    CREATE TABLE IF NOT EXISTS v31_profiles (
      raiseAddr TEXT PRIMARY KEY COLLATE NOCASE, profile TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS v31_reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT, raiseAddr TEXT NOT NULL COLLATE NOCASE, createdAt INTEGER NOT NULL,
      riskScoreBps INTEGER NOT NULL, veto INTEGER NOT NULL, findings TEXT NOT NULL, metrics TEXT NOT NULL,
      panel TEXT NOT NULL, reportHash TEXT NOT NULL, uri TEXT NOT NULL, postedTx TEXT,
      builderResponse TEXT, builderResponseAt INTEGER
    );
    CREATE TABLE IF NOT EXISTS v31_feedback (
      id INTEGER PRIMARY KEY AUTOINCREMENT, raiseAddr TEXT NOT NULL COLLATE NOCASE, author TEXT NOT NULL,
      createdAt INTEGER NOT NULL, rating INTEGER NOT NULL, text TEXT NOT NULL, isBacker INTEGER NOT NULL,
      signature TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS v31_updates (
      id INTEGER PRIMARY KEY AUTOINCREMENT, raiseAddr TEXT NOT NULL COLLATE NOCASE, author TEXT NOT NULL,
      createdAt INTEGER NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, kind TEXT NOT NULL, signature TEXT NOT NULL
    );
  `);
  migrateStateV31(db);
}
export function getRaiseV31(db: DB, address: string): RaiseV31Row | null {
  return db.query('SELECT * FROM v31_raises WHERE address = ?').get(address) as RaiseV31Row | null;
}
export function listRaisesV31(db: DB): RaiseV31Row[] {
  return db.query('SELECT * FROM v31_raises ORDER BY blockNumber DESC, address').all() as RaiseV31Row[];
}
export function positionIds(db: DB, raise: string, owner?: string): { id: string; owner: string; class: number; tokens: string }[] {
  const sql = 'SELECT id, owner, class, tokens FROM v31_positions WHERE raiseAddr = ?';
  return (owner ? db.query(`${sql} AND owner = ?`).all(raise, owner) : db.query(sql).all(raise)) as never;
}
