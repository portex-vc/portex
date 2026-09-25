"use client";

import { getAccount, type Config } from "@wagmi/core";
import {
  BaseError,
  ContractFunctionRevertedError,
  ExecutionRevertedError,
  InsufficientFundsError,
  createPublicClient,
  custom,
  fallback,
  http,
  type EIP1193Provider,
  type PublicClient,
} from "viem";
import { appChain } from "./chains";
import { isLocalChain } from "./env";

/**
 * Keyless public RPC endpoints of each X Layer chain. The browser uses them only while a transaction is in flight
 * (simulate, gas estimate, receipt); everything the app displays comes from the Portex API. No URL carries a key.
 */
const PUBLIC_RPCS: Record<number, readonly string[]> = {
  1952: ["https://testrpc.xlayer.tech/terigon", "https://testrpc.xlayer.tech", "https://xlayertestrpc.okx.com"],
  196: ["https://rpc.xlayer.tech", "https://xlayerrpc.okx.com"],
};

/** A viem client over the connected wallet's own EIP-1193 provider. */
export async function walletPublicClient(config: Config) {
  const { connector, chainId } = getAccount(config);
  if (!connector) throw new Error("Connect a wallet first.");
  if (chainId !== appChain.id) throw new Error(`Switch the wallet to ${appChain.name} first.`);
  const provider = (await connector.getProvider({ chainId: appChain.id })) as EIP1193Provider;
  return createPublicClient({
    chain: appChain,
    transport: custom(provider, { retryCount: 1 }),
    // Receipts appear within a block or two on X Layer; poll the wallet once a second meanwhile.
    pollingInterval: 1_000,
  });
}

/**
 * The client for transaction-time calls: simulate, gas estimate and receipt wait. On X Layer these go to the chain's
 * keyless public RPCs, because a browser wallet's own node connection can stall them without ever showing the user
 * a prompt; the wallet only signs and sends. On the local chain the burner wallet answers them itself.
 */
export async function txPublicClient(config: Config): Promise<PublicClient> {
  if (isLocalChain) return (await walletPublicClient(config)) as unknown as PublicClient;
  const urls = PUBLIC_RPCS[appChain.id] ?? appChain.rpcUrls.default.http;
  return createPublicClient({
    chain: appChain,
    transport: fallback(urls.map((url) => http(url, { timeout: 10_000, retryCount: 1 }))),
    pollingInterval: 1_000,
  }) as PublicClient;
}

/** True when a simulate or estimate failed because the contract or the account refuses, not because of the RPC. */
export function isRefusal(err: unknown): boolean {
  return (
    err instanceof BaseError &&
    Boolean(
      err.walk(
        (e) =>
          e instanceof ContractFunctionRevertedError ||
          e instanceof ExecutionRevertedError ||
          e instanceof InsufficientFundsError,
      ),
    )
  );
}

/** Rejects with "timeout" when `promise` has not settled after `ms`. */
export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
