import {
  createPublicClient, createWalletClient, http, defineChain,
  type PublicClient, type WalletClient, type Abi, type Address,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { Config } from './config.ts';
import { deployments } from './generated/deployments.ts';
import { countRpcBody } from './lib/rpc-metrics.ts';

export function makeChain(config: Config) {
  return defineChain({
    id: config.chainId,
    name: config.isLocal ? 'anvil' : config.chainId === 196 ? 'X Layer' : 'X Layer testnet',
    nativeCurrency: { name: config.chainId === 31337 ? 'Ether' : 'OKB', symbol: config.chainId === 31337 ? 'ETH' : 'OKB', decimals: 18 },
    rpcUrls: { default: { http: [config.rpcUrl] } },
  });
}

export type Clients = {
  public: PublicClient;
  wallet: WalletClient | null;          // attester wallet (null if no key)
  attesterAddress: Address | null;
};

export function makeClients(config: Config): Clients {
  const chain = makeChain(config);
  // Every JSON-RPC call is counted (see lib/rpc-metrics.ts); the hook leaves the request unchanged.
  const transport = http(config.rpcUrl, { timeout: 15_000, onFetchRequest: (_request, init) => { countRpcBody(init.body); } });
  const publicClient = createPublicClient({ chain, transport });
  if (!config.attesterPrivateKey) return { public: publicClient, wallet: null, attesterAddress: null };
  const account = privateKeyToAccount(config.attesterPrivateKey);
  const wallet = createWalletClient({ account, chain, transport });
  return { public: publicClient, wallet, attesterAddress: account.address };
}

/** Live deployment record for the configured chain (null when not deployed yet). */
export function getDeployment(chainId: number): Record<string, string | number> | null {
  const d = (deployments as Record<string, Record<string, string | number>>)[String(chainId)];
  return d ?? null;
}

/**
 * Multicall-style batched read: uses the Multicall3 aggregate when available on the chain
 * (anvil deploys it), falling back to concurrent plain reads when it is not.
 */
export async function batchRead<T>(
  client: PublicClient,
  calls: { address: Address; abi: Abi; functionName: string; args?: readonly unknown[] }[],
): Promise<T[]> {
  try {
    const results = await client.multicall({
      contracts: calls.map((c) => ({ ...c, args: (c.args ?? []) as readonly unknown[] })) as never,
      allowFailure: false,
    });
    return results as T[];
  } catch {
    return Promise.all(
      calls.map((c) =>
        client.readContract({
          address: c.address, abi: c.abi, functionName: c.functionName, args: c.args ?? [],
        } as never) as Promise<T>,
      ),
    );
  }
}
