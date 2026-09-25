"use client";

import { getAccount, type Config } from "@wagmi/core";
import { createPublicClient, custom, type EIP1193Provider } from "viem";
import { appChain } from "./chains";

/**
 * A viem client over the connected wallet's own EIP-1193 provider, for transaction-time calls only:
 * simulate before signing, gas estimate, receipt wait, pre-signing checks. The app never sends
 * JSON-RPC to an RPC URL of its own; displayed data comes from the Portex API.
 */
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
