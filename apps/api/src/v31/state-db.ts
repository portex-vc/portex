/**
 * Materialized chain state (additive schema). Written only by the indexer: event-derived ERC-20 balances and
 * allowances in the same transaction as the events, and batched view results (`v31_state`) after each page.
 */
import { getAddress } from 'viem';
import type { DB } from '../db.ts';

export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
export const MAX_UINT256 = (1n << 256n) - 1n;

export function migrateStateV31(db: DB): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS v31_state (
      kind TEXT NOT NULL, raiseAddr TEXT NOT NULL COLLATE NOCASE, key TEXT NOT NULL COLLATE NOCASE,
      blockNumber INTEGER NOT NULL, chainTime INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(kind, raiseAddr, key)
    );
    CREATE TABLE IF NOT EXISTS v31_dirty (raiseAddr TEXT PRIMARY KEY COLLATE NOCASE);
    CREATE TABLE IF NOT EXISTS v31_balances (
      token TEXT NOT NULL COLLATE NOCASE, holder TEXT NOT NULL COLLATE NOCASE, amount TEXT NOT NULL, PRIMARY KEY(token, holder)
    );
    CREATE INDEX IF NOT EXISTS v31_balances_holder ON v31_balances(holder);
    CREATE TABLE IF NOT EXISTS v31_allowances (
      token TEXT NOT NULL COLLATE NOCASE, owner TEXT NOT NULL COLLATE NOCASE, spender TEXT NOT NULL COLLATE NOCASE,
      amount TEXT NOT NULL, blockNumber INTEGER NOT NULL, logIndex INTEGER NOT NULL, PRIMARY KEY(token, owner, spender)
    );
    CREATE INDEX IF NOT EXISTS v31_allowances_owner ON v31_allowances(owner);
    CREATE TABLE IF NOT EXISTS v31_allowance_dirty (
      token TEXT NOT NULL COLLATE NOCASE, owner TEXT NOT NULL COLLATE NOCASE, PRIMARY KEY(token, owner)
    );
    CREATE TABLE IF NOT EXISTS v31_materialized (
      raiseAddr TEXT NOT NULL COLLATE NOCASE, holder TEXT NOT NULL COLLATE NOCASE, PRIMARY KEY(raiseAddr, holder)
    );
    CREATE INDEX IF NOT EXISTS v31_events_name ON v31_events(contract, name, blockNumber);
  `);
}

/** JSON for view results: bigints as decimal strings (the API's typed() output uses the same encoding). */
export function stringify(value: unknown): string {
  return JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
}

// ------------------------------------------------------------------------------------------------ ERC-20 ledger

function addBalance(db: DB, token: string, holder: string, delta: bigint): void {
  const row = db.query('SELECT amount FROM v31_balances WHERE token=? AND holder=?').get(token, holder) as { amount: string } | null;
  db.query('INSERT OR REPLACE INTO v31_balances VALUES (?,?,?)').run(token, holder, (BigInt(row?.amount ?? 0) + delta).toString());
}

/** Writes an allowance unless a newer observation (later log or later exact read) already exists. */
export function setAllowance(db: DB, token: string, owner: string, spender: string, amount: bigint, blockNumber: number, logIndex: number): void {
  const row = db.query('SELECT blockNumber, logIndex FROM v31_allowances WHERE token=? AND owner=? AND spender=?').get(token, owner, spender) as
    { blockNumber: number; logIndex: number } | null;
  if (row && (row.blockNumber > blockNumber || (row.blockNumber === blockNumber && row.logIndex > logIndex))) return;
  db.query('INSERT OR REPLACE INTO v31_allowances VALUES (?,?,?,?,?,?)').run(token, owner, spender, amount.toString(), blockNumber, logIndex);
}

/**
 * Applies one ERC-20 Transfer/Approval (quote token or project token). OpenZeppelin 5 spends allowances in
 * `transferFrom` without an Approval event, so an outgoing transfer marks the owner's finite allowances for an exact
 * re-read in the next batched refresh. A project-token transfer out of its raise is the holder's lazy listing delivery.
 */
export function applyErc20(db: DB, token: string, raise: string | null, name: string, a: Record<string, any>, blockNumber: number, logIndex: number): void {
  if (name === 'Transfer') {
    const from = getAddress(a.from), to = getAddress(a.to), value = BigInt(a.value);
    if (from !== ZERO_ADDRESS) addBalance(db, token, from, -value);
    if (to !== ZERO_ADDRESS) addBalance(db, token, to, value);
    if (raise && from.toLowerCase() === raise.toLowerCase() && to !== ZERO_ADDRESS) {
      db.query('INSERT OR IGNORE INTO v31_materialized VALUES (?,?)').run(raise, to);
    }
    if (from !== ZERO_ADDRESS) {
      const finite = db.query("SELECT 1 FROM v31_allowances WHERE token=? AND owner=? AND amount!='0' AND amount!=? LIMIT 1").get(token, from, MAX_UINT256.toString());
      if (finite) db.query('INSERT OR IGNORE INTO v31_allowance_dirty VALUES (?,?)').run(token, from);
    }
  } else if (name === 'Approval') {
    setAllowance(db, token, getAddress(a.owner), getAddress(a.spender), BigInt(a.value), blockNumber, logIndex);
  }
}

export function balanceOf(db: DB, token: string, holder: string): bigint {
  const row = db.query('SELECT amount FROM v31_balances WHERE token=? AND holder=?').get(token, holder) as { amount: string } | null;
  return BigInt(row?.amount ?? 0);
}

export function allowancesOf(db: DB, token: string, owner: string): Record<string, string> {
  const rows = db.query('SELECT spender, amount FROM v31_allowances WHERE token=? AND owner=? ORDER BY spender').all(token, owner) as { spender: string; amount: string }[];
  return Object.fromEntries(rows.map((r) => [getAddress(r.spender), r.amount]));
}

export function isMaterialized(db: DB, raise: string, holder: string): boolean {
  return !!db.query('SELECT 1 FROM v31_materialized WHERE raiseAddr=? AND holder=?').get(raise, holder);
}

/** False while the one-time quote-token / pool-liquidity backfill of an upgraded database is still running. */
export function historySynced(db: DB): boolean {
  const get = (k: string) => (db.query('SELECT value FROM v31_meta WHERE key=?').get(k) as { value: string } | null)?.value;
  const to = get('backfill:to');
  return to === undefined || Number(get('backfill:next') ?? 0) > Number(to);
}

// ------------------------------------------------------------------------------------------------ dirty marks

export function markDirty(db: DB, raise: string): void {
  db.query('INSERT OR IGNORE INTO v31_dirty VALUES (?)').run(raise);
}
export function markAllDirty(db: DB): void {
  db.exec('INSERT OR IGNORE INTO v31_dirty SELECT address FROM v31_raises');
  db.query("INSERT OR REPLACE INTO v31_meta VALUES ('configDirty','1')").run();
}
export function dirtyRaises(db: DB): string[] {
  return (db.query('SELECT raiseAddr FROM v31_dirty').all() as { raiseAddr: string }[]).map((r) => r.raiseAddr);
}

// ------------------------------------------------------------------------------------------------ state rows

export interface StateRow { kind: string; raiseAddr: string; key: string; blockNumber: number; chainTime: number; data: string }
export function stateRow(db: DB, kind: string, raise: string, key = ''): StateRow | null {
  return db.query('SELECT * FROM v31_state WHERE kind=? AND raiseAddr=? AND key=?').get(kind, raise, key) as StateRow | null;
}
export function stateRows(db: DB, kind: string, raise: string): StateRow[] {
  return db.query('SELECT * FROM v31_state WHERE kind=? AND raiseAddr=?').all(kind, raise) as StateRow[];
}
