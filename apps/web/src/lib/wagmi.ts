"use client";

import { custom } from "viem";
import { createConfig, createStorage, type CreateConnectorFn } from "wagmi";
import { injected, walletConnect } from "wagmi/connectors";
import { appChain, chains } from "./chains";
import { localAccountsConnector } from "./local-connector";
import { env, isLocalChain } from "./env";

export const OKX_CONNECTOR_ID = "okxWallet";
export const OKX_RDNS = "com.okex.wallet";
export const OKX_INSTALL_URL = "https://web3.okx.com/download";

type OkxWindow = { okxwallet?: unknown };

/**
 * Wallet connectors, in the order the wallet sheet lists them:
 * OKX Wallet · browser wallets (EIP-6963 discovery + generic injected) · WalletConnect (only with a
 * configured project id). On chain 31337 a local test-account connector is also registered; it is
 * chosen from the Dev page, never from the header.
 */
const connectors: CreateConnectorFn[] = [
  injected({
    target: {
      id: OKX_CONNECTOR_ID,
      name: "OKX Wallet",
      provider: (window) => (window as unknown as OkxWindow | undefined)?.okxwallet as never,
    },
  }),
  injected(),
  ...(env.walletConnectProjectId
    ? [
        walletConnect({
          projectId: env.walletConnectProjectId,
          showQrModal: true,
          metadata: {
            name: "Portex",
            description: "Escrow-backed on-chain incubation on X Layer",
            url: typeof window === "undefined" ? "https://portex.app" : window.location.origin,
            icons: [],
          },
        }),
      ]
    : []),
  ...(isLocalChain ? [localAccountsConnector()] : []),
];

/**
 * The browser never talks to an RPC endpoint: displayed data comes from the Portex API, and transaction-time
 * calls (simulate, gas estimate, receipt wait) go through the connected wallet's own provider
 * (`lib/wallet-client.ts`). So wagmi's own public client gets a transport that makes no request at all, and a
 * stray read fails loudly here instead of reaching an RPC. The chain's public RPC URL stays only as
 * EIP-3085 metadata for `wallet_addEthereumChain`.
 */
const noRpc = custom({
  async request({ method }: { method: string }) {
    throw new Error(`Portex does not send "${method}" to an RPC endpoint; chain data comes from the Portex API.`);
  },
});

export const wagmiConfig = createConfig({
  // The app chain first: wagmi uses the first chain as the default for new connections.
  chains,
  connectors,
  transports: {
    [appChain.id]: noRpc,
  },
  ssr: true,
  storage: createStorage({
    storage: typeof window === "undefined" ? undefined : window.localStorage,
  }),
});

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}

export { chains };
