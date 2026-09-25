/**
 * Stand-in for `local-connector.ts` in every build that is not the local chain (31337): `next.config.ts` swaps it
 * in, so the burner wallet (and the public test mnemonic behind it) is never bundled into testnet or mainnet.
 */
export const LOCAL_CONNECTOR_ID = "portex-local-accounts";

export function setSelectedLocalAccountIndex(): void {}

export function localAccountsConnector(): never {
  throw new Error("Local test accounts exist only in local-chain builds.");
}
