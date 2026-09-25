"use client";

import { createConfig, createStorage, http, type CreateConnectorFn } from "wagmi";
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

export const wagmiConfig = createConfig({
  // The app chain first: wagmi uses the first chain as the default for new connections.
  chains,
  connectors,
  transports: {
    [appChain.id]: http(appChain.rpcUrls.default.http[0]),
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
