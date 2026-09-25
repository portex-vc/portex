import { describe, test, expect, afterAll } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.ts';
import { migrateV31 } from '../src/v31/db.ts';
import { protocolAddresses } from '../src/v31/analyst.ts';
import { scoreHeuristic } from '../src/analyst/heuristic.ts';
import type { ScorerInput } from '../src/analyst/types.ts';

const a = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;
const usdg = (x: number) => String(BigInt(x) * 1_000_000n);

describe('analyst funding attribution (false sybil warnings, 25 September)', () => {
  // A report named the Uniswap PoolManager as the common funder of "1 wallets ... one actor behind many wallets".
  test('one wallet with its own funder is not a cluster', () => {
    const backers = [
      { user: a(1), principal: usdg(4500) },
      { user: a(2), principal: usdg(3000) },
      { user: a(3), principal: usdg(2346) },
    ];
    const input: ScorerInput = {
      raise: a(99), builder: a(98), backers,
      deposits: backers.map((b, i) => ({ user: b.user, amount: b.principal, timestamp: 1_800_000_000 + i * 3600 })),
      funding: [{ user: a(1), funder: a(50) }, { user: a(2), funder: null }, { user: a(3), funder: a(51) }],
      feedback: [], minIncubationSec: 3600, startedAtSec: 1_800_000_000, nowSec: 1_800_010_000,
    };
    const r = scoreHeuristic(input);
    expect(r.metrics.clusterShareBps).toBe(0);
    expect(r.findings.map((f) => f.title)).not.toContain('Several wallets funded by one address');
    // Two wallets from the same sender still form a cluster.
    const pair = scoreHeuristic({ ...input, funding: [{ user: a(1), funder: a(50) }, { user: a(2), funder: a(50) }, { user: a(3), funder: null }] });
    expect(pair.metrics.clusterSize).toBe(2);
    expect(pair.metrics.clusterShareBps).toBeGreaterThan(0);
  });

  const dir = mkdtempSync(join(tmpdir(), 'portex-funders-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test('protocol contracts are never a wallet funder; people are', () => {
    const previous = process.env.PORTEX_DEPLOYMENTS_DIR;
    process.env.PORTEX_DEPLOYMENTS_DIR = dir;
    writeFileSync(join(dir, '31337-v31.json'), JSON.stringify({
      chainId: 31337, simulated: false, deployer: a(7), attester: a(8), council: a(9),
      poolManager: a(10), router: a(11), rolloverRouter: a(12), factory: a(13), registry: a(14), quote: a(15),
    }));
    const db = openDb(':memory:');
    migrateV31(db);
    db.query(`INSERT INTO v31_raises (address,builder,templateId,version,token,governor,vesting,claims,adapter,config,state,createdAt,blockNumber,txHash)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(a(20), a(30), '0x0', 1, a(21), a(22), a(23), a(24), a(25), JSON.stringify({ treasury: a(26) }), '{}', 0, 1, '0x0');
    const set = protocolAddresses(db, 31337);
    for (const n of [10, 11, 12, 13, 14, 20, 21, 22, 23, 24, 25, 26]) expect(set.has(a(n))).toBe(true);
    // The deployer and role holders are people, and the builder may really fund backers: never excluded.
    for (const n of [7, 8, 9, 30]) expect(set.has(a(n))).toBe(false);
    if (previous === undefined) delete process.env.PORTEX_DEPLOYMENTS_DIR;
    else process.env.PORTEX_DEPLOYMENTS_DIR = previous;
  });
});
