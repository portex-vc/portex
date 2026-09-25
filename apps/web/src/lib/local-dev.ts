import { mnemonicToAccount } from "viem/accounts";
import { toHex } from "viem";
import type { DevAccount, LocalAccountRole } from "./api";
import { isLocalChain, env } from "./env";

/** The public test mnemonic of the local chain. Never used on X Layer. */
const TEST_MNEMONIC = "test test test test test test test test test test test junk";

/**
 * The local test accounts, in display order. Indices follow the seed script:
 * 0 deployer, 1 attester, 2 council, 3 builder, 4–13 backers 1–10, 14 buyer, 15 whale.
 */
const LAYOUT: { index: number; role: LocalAccountRole; ordinal?: number }[] = [
  { index: 0, role: "deployer" },
  { index: 1, role: "attester" },
  { index: 2, role: "council" },
  { index: 3, role: "builder" },
  ...Array.from({ length: 10 }, (_, i) => ({ index: 4 + i, role: "backer" as const, ordinal: i + 1 })),
  { index: 14, role: "buyer" },
  { index: 15, role: "whale" },
];

let cache: DevAccount[] | null = null;

/** Local test accounts; empty unless the app runs on chain 31337. */
export async function localAccounts(): Promise<DevAccount[]> {
  if (!isLocalChain) return [];
  cache ??= LAYOUT.map(({ index, role, ordinal }) => {
    const account = mnemonicToAccount(TEST_MNEMONIC, { addressIndex: index });
    return { index, role, ordinal, address: account.address, privateKey: toHex(account.getHdKey().privateKey!) };
  });
  return cache;
}

/** Advance the local chain clock and mine a block (local chain only). */
export async function localWarp(seconds: number) {
  if (!isLocalChain) throw new Error("Local chain only");
  for (const [method, params] of [
    ["evm_increaseTime", [seconds]],
    ["evm_mine", []],
  ] as const) {
    const response = await fetch(env.rpcLocal, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    const result = await response.json();
    if (result.error) throw new Error(result.error.message);
  }
}
