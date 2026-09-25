/** Public, non-secret build-time environment. The app defaults to X Layer testnet. */
export const env = {
  apiUrl: process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8790",
  chainId: Number(process.env.NEXT_PUBLIC_CHAIN_ID ?? "1952"),
  rpcLocal: process.env.NEXT_PUBLIC_RPC_LOCAL ?? "http://127.0.0.1:8545",
  /** WalletConnect Cloud project id. Without it the WalletConnect option is hidden; never invent one. */
  walletConnectProjectId: process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID?.trim() || null,
};

export const isLocalChain = env.chainId === 31337;
