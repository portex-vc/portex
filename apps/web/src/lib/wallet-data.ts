import type { UserWallet } from "./api";

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** The allowance of `token` to `spender` in an indexed wallet snapshot (`/v2/users/:u/wallet`); 0 when absent. */
export function walletAllowance(wallet: UserWallet | undefined, token: string, spender: string): bigint {
  if (!wallet) return 0n;
  const allowances = same(wallet.quote.address, token)
    ? wallet.quote.allowances
    : wallet.tokens.find((t) => same(t.token, token))?.allowances;
  const entry = Object.entries(allowances ?? {}).find(([key]) => same(key, spender));
  return entry ? BigInt(entry[1]) : 0n;
}
