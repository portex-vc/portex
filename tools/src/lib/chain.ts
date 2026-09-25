// Chain connection, anvil well-known accounts, and low-level RPC helpers
// (time travel, snapshots, balances) shared by every scenario and the seeder.
import {
  createPublicClient,
  createWalletClient,
  http,
  defineChain,
  type PublicClient,
  type WalletClient,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';

export const portexLocal = defineChain({
  id: 31337,
  name: 'Portex Local',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: ['http://127.0.0.1:8545'] } },
});

// The ten well-known anvil accounts (deterministic from the default mnemonic).
const ANVIL_KEYS: Hex[] = [
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80', // 0 deployer/curator
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d', // 1 attester
  '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a', // 2 council
  '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6', // 3 builder
  '0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a', // 4 backer
  '0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba', // 5 backer
  '0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e', // 6 backer
  '0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356', // 7 backer
  '0xdbda1821b80551c9d65939329250298aa3472ba22feea921c0cf5d620ea67b97', // 8 backer
  '0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6', // 9 whale
];

const ROLE_LABELS = [
  'deployer', 'attester', 'council', 'builder',
  'backer1', 'backer2', 'backer3', 'backer4', 'backer5', 'whale',
];

export interface Actor {
  index: number; // -1 for fresh (non-anvil) wallets
  label: string;
  address: Address;
  privateKey: Hex;
  account: ReturnType<typeof privateKeyToAccount>;
}

export const ACTORS: Actor[] = ANVIL_KEYS.map((key, i) => {
  const account = privateKeyToAccount(key);
  return { index: i, label: ROLE_LABELS[i], address: account.address, privateKey: key, account };
});

export const DEPLOYER = ACTORS[0];
export const ATTESTER = ACTORS[1];
export const COUNCIL = ACTORS[2];
export const BUILDER = ACTORS[3];
export const BACKERS = ACTORS.slice(4, 9);
export const WHALE = ACTORS[9];

export function freshWallet(label: string): Actor {
  const privateKey = generatePrivateKey();
  const account = privateKeyToAccount(privateKey);
  return { index: -1, label, address: account.address, privateKey, account };
}

export function makePublicClient(rpcUrl: string): PublicClient {
  return createPublicClient({ chain: portexLocal, transport: http(rpcUrl), pollingInterval: 50 }) as PublicClient;
}

export function makeWalletClient(actor: Actor, rpcUrl: string): WalletClient {
  return createWalletClient({
    account: actor.account,
    chain: portexLocal,
    transport: http(rpcUrl),
    pollingInterval: 50,
  });
}

// ---- low-level anvil RPC ----

async function rpc(client: PublicClient, method: string, params: unknown[] = []): Promise<unknown> {
  return client.request({ method, params } as never);
}

/** evm_increaseTime + evm_mine. Returns the new block timestamp. */
export async function warp(client: PublicClient, seconds: number | bigint): Promise<bigint> {
  await rpc(client, 'evm_increaseTime', [Number(seconds)]);
  await rpc(client, 'evm_mine', []);
  const block = await client.getBlock();
  return block.timestamp;
}

export async function now(client: PublicClient): Promise<bigint> {
  const block = await client.getBlock();
  return block.timestamp;
}

export async function snapshot(client: PublicClient): Promise<Hex> {
  return (await rpc(client, 'evm_snapshot', [])) as Hex;
}

export async function revert(client: PublicClient, id: Hex): Promise<void> {
  await rpc(client, 'evm_revert', [id]);
}

export async function setBalance(client: PublicClient, addr: Address, wei: bigint): Promise<void> {
  await rpc(client, 'anvil_setBalance', [addr, `0x${wei.toString(16)}`]);
}

/** True if something answers JSON-RPC at the given URL. */
export async function rpcReachable(rpcUrl: string): Promise<boolean> {
  try {
    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'web3_clientVersion', params: [] }),
      signal: AbortSignal.timeout(1500),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** True if a TCP port has a listener. */
export async function portListening(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'web3_clientVersion', params: [] }),
      signal: AbortSignal.timeout(800),
    });
    return res.ok;
  } catch {
    return false;
  }
}
