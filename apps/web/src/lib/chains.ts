import { defineChain, type Chain } from "viem";
import { env } from "./env";

export const localhost = defineChain({
  id: 31337,
  name: "Local",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [env.rpcLocal] } },
});

export const xLayerTestnet = defineChain({
  id: 1952,
  name: "X Layer testnet",
  nativeCurrency: { name: "OKB", symbol: "OKB", decimals: 18 },
  rpcUrls: { default: { http: ["https://testrpc.xlayer.tech/terigon"] } },
  blockExplorers: { default: { name: "OKLink", url: "https://www.oklink.com/xlayer-test" } },
  testnet: true,
});

export const xLayer = defineChain({
  id: 196,
  name: "X Layer",
  nativeCurrency: { name: "OKB", symbol: "OKB", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.xlayer.tech"] } },
  blockExplorers: { default: { name: "OKLink", url: "https://www.oklink.com/xlayer" } },
});

const supportedChains = [localhost, xLayerTestnet, xLayer] as const;

/** The chain this deployment of the app runs on. */
const selectedChain = supportedChains.find((c) => c.id === env.chainId);
if (!selectedChain) throw new Error("Unsupported NEXT_PUBLIC_CHAIN_ID");
export const appChain: Chain = selectedChain;
export const chains = [appChain] as const;

/** Explicit EIP-3085 metadata used by wagmi when the wallet reports an unknown chain. */
export const appChainSwitch = {
  chainId: appChain.id,
  addEthereumChainParameter: {
    chainName: appChain.name,
    nativeCurrency: appChain.nativeCurrency,
    rpcUrls: [...appChain.rpcUrls.default.http],
    blockExplorerUrls: appChain.blockExplorers ? [appChain.blockExplorers.default.url] : undefined,
  },
};

/** OKLink base URL for the app chain; null on the local chain. */
export const explorerUrl: string | null = appChain.blockExplorers?.default.url ?? null;
