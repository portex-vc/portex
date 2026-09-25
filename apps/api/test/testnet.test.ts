import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { PublicClient } from 'viem';
import { loadConfig } from '../src/config.ts';
import { makeChain } from '../src/chain.ts';
import { openDb } from '../src/db.ts';
import { getDeploymentV31 } from '../src/v31/deployment.ts';
import { IndexerV31 } from '../src/v31/indexer.ts';

test('testnet defaults, Alchemy network selection, RPC override and explicit local opt-in', () => {
  expect(loadConfig({}).chainId).toBe(1952);
  expect(loadConfig({}).isLocal).toBe(false);
  expect(loadConfig({}).attesterPrivateKey).toBeNull();
  for (const [id, network] of [[1952, 'testnet'], [196, 'mainnet']] as const) {
    const config = loadConfig({ PORTEX_CHAIN_ID: String(id), ALCHEMY_API_KEY: 'fixture-only' });
    expect(config.rpcUrl).toBe(`https://xlayer-${network}.g.alchemy.com/v2/fixture-only`);
    expect(makeChain(config).nativeCurrency.symbol).toBe('OKB');
    expect(loadConfig({ PORTEX_CHAIN_ID: String(id), ALCHEMY_API_KEY: 'fixture-only', RPC_URL: 'http://override.invalid' }).rpcUrl).toBe('http://override.invalid');
  }
  expect(loadConfig({ PORTEX_CHAIN_ID: '31337' }).isLocal).toBe(true);
  expect(() => loadConfig({ PORTEX_CHAIN_ID: '1' })).toThrow('Unsupported PORTEX_CHAIN_ID');
});

test('manifest validation and indexer start/restart/reorg respect deployment block', async () => {
  const base = resolve(import.meta.dir, '../data');
  mkdirSync(base, { recursive: true });
  const directory = mkdtempSync(resolve(base, 'testnet-config-'));
  const previous = process.env.PORTEX_DEPLOYMENTS_DIR;
  process.env.PORTEX_DEPLOYMENTS_DIR = directory;
  const file = resolve(directory, '1952-v31.json');
  const manifest = { chainId: 1952, simulated: false, deploymentBlock: 5000000, factory: '0x0000000000000000000000000000000000000001' };
  const db = openDb(':memory:');
  try {
    expect(getDeploymentV31(1952)).toBeNull();
    writeFileSync(file, JSON.stringify({ ...manifest, simulated: true }));
    expect(getDeploymentV31(1952)).toBeNull();
    writeFileSync(file, JSON.stringify({ ...manifest, chainId: 196 }));
    expect(() => getDeploymentV31(1952)).toThrow('chain mismatch');
    writeFileSync(file, JSON.stringify({ ...manifest, deploymentBlock: undefined }));
    expect(() => getDeploymentV31(1952)).toThrow('deploymentBlock');
    writeFileSync(file, JSON.stringify(manifest));
    const ranges: number[][] = [];
    let branch = 0;
    const client = {
      getChainId: async () => 1952,
      getBlock: async ({ blockNumber }: { blockNumber?: bigint }) => {
        const n = blockNumber ?? 5000002n;
        return { number: n, timestamp: n, hash: `0x${n}-${n === 0n ? 0 : branch}` };
      },
      getCode: async () => '0x6000',
      getLogs: async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => {
        ranges.push([Number(fromBlock), Number(toBlock)]);
        return [];
      },
    } as unknown as PublicClient;
    const config = loadConfig({});
    const indexer = new IndexerV31(db, client, config);
    await indexer.poll();
    expect(indexer.status.lastError).toBeNull();
    expect(indexer.status.lastIndexedBlock).toBe(5000002);
    expect(ranges).toEqual([[5000000, 5000002], [5000000, 5000002]]);
    ranges.length = 0;
    await new IndexerV31(db, client, config).poll();
    expect(ranges).toEqual([]);
    branch++;
    await indexer.poll();
    expect(indexer.status.lastError).toBeNull();
    expect(ranges).toEqual([[5000000, 5000002], [5000000, 5000002]]);
  } finally {
    db.close();
    if (previous === undefined) delete process.env.PORTEX_DEPLOYMENTS_DIR;
    else process.env.PORTEX_DEPLOYMENTS_DIR = previous;
  }
});
