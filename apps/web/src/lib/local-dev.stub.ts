import type { DevAccount } from "./api";

/**
 * Stand-in for `local-dev.ts` in every build that is not the local chain (31337); see `next.config.ts`.
 * No test mnemonic and no node endpoint are bundled.
 */
export async function localAccounts(): Promise<DevAccount[]> {
  return [];
}

export async function localWarp(): Promise<void> {
  throw new Error("Local chain only");
}
