import type { DB } from '../db.ts';

/** Secondary-market tables. Pools are deterministic (token, quote, hook) and survive reorgs; swaps are rolled back. */
export function migrateMarketV31(db: DB): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS v31_pools (
      raiseAddr TEXT PRIMARY KEY COLLATE NOCASE, poolId TEXT NOT NULL COLLATE NOCASE, token TEXT NOT NULL,
      quote TEXT NOT NULL, adapter TEXT NOT NULL, tokenIsCurrency0 INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS v31_pools_id ON v31_pools(poolId);
    CREATE TABLE IF NOT EXISTS v31_pool_swaps (
      raiseAddr TEXT NOT NULL COLLATE NOCASE, poolId TEXT NOT NULL COLLATE NOCASE, side TEXT NOT NULL,
      amountQuote TEXT NOT NULL, amountToken TEXT NOT NULL, price TEXT NOT NULL, spot TEXT NOT NULL,
      sqrtPriceX96 TEXT NOT NULL, liquidity TEXT NOT NULL, tick INTEGER NOT NULL, fee INTEGER NOT NULL,
      sender TEXT NOT NULL, trader TEXT NOT NULL, recipient TEXT, viaRouter INTEGER NOT NULL,
      timestamp INTEGER NOT NULL, txHash TEXT NOT NULL, blockNumber INTEGER NOT NULL, logIndex INTEGER NOT NULL,
      PRIMARY KEY(txHash, logIndex)
    );
    CREATE INDEX IF NOT EXISTS v31_pool_swaps_raise ON v31_pool_swaps(raiseAddr, blockNumber, logIndex);
    CREATE INDEX IF NOT EXISTS v31_pool_swaps_block ON v31_pool_swaps(blockNumber);
    -- PoolManager ModifyLiquidity of Portex pools: the initialized ticks a Stage 3 quote walks (rolled back with swaps).
    CREATE TABLE IF NOT EXISTS v31_pool_liquidity (
      raiseAddr TEXT NOT NULL COLLATE NOCASE, poolId TEXT NOT NULL COLLATE NOCASE, sender TEXT NOT NULL,
      tickLower INTEGER NOT NULL, tickUpper INTEGER NOT NULL, liquidityDelta TEXT NOT NULL, salt TEXT NOT NULL,
      txHash TEXT NOT NULL, blockNumber INTEGER NOT NULL, logIndex INTEGER NOT NULL, PRIMARY KEY(txHash, logIndex)
    );
    CREATE INDEX IF NOT EXISTS v31_pool_liquidity_pool ON v31_pool_liquidity(poolId, blockNumber);
  `);
}
