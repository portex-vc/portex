import { describe, expect, test } from "bun:test";
import type { UserWallet } from "../src/lib/api";
import { walletAllowance } from "../src/lib/wallet-data";

const wallet: UserWallet = {
  blockNumber: 12,
  quote: {
    address: "0xQuoteAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaa01",
    balance: "5000000",
    allowances: { "0xraise00000000000000000000000000000000001": "2500000" },
  },
  tokens: [
    {
      raise: "0xraise00000000000000000000000000000000001",
      token: "0xTOKEN00000000000000000000000000000000001",
      symbol: "CART",
      balance: "7",
      allowances: { "0xROUTER0000000000000000000000000000000001": "3" },
    },
  ],
  native: { balance: "0" },
};

describe("walletAllowance", () => {
  test("reads quote and project-token allowances, ignoring address case", () => {
    expect(
      walletAllowance(
        wallet,
        "0xquoteaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa01",
        "0xRAISE00000000000000000000000000000000001",
      ),
    ).toBe(2_500_000n);
    expect(
      walletAllowance(
        wallet,
        "0xtoken00000000000000000000000000000000001",
        "0xrouter0000000000000000000000000000000001",
      ),
    ).toBe(3n);
  });
  test("is 0 for an unknown spender, an unknown token, or no snapshot yet", () => {
    expect(walletAllowance(wallet, wallet.quote.address, "0x0000000000000000000000000000000000000009")).toBe(0n);
    expect(walletAllowance(wallet, "0x0000000000000000000000000000000000000008", wallet.quote.address)).toBe(0n);
    expect(walletAllowance(undefined, wallet.quote.address, "0xraise00000000000000000000000000000000001")).toBe(0n);
  });
});
