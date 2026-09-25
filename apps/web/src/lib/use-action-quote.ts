"use client";
import { useQuery } from "@tanstack/react-query";
import { usePublicClient } from "wagmi";
import type { Address } from "viem";
import { api, type RaiseDetail } from "./api";
import { raiseAbi } from "./contracts";
import { depositQuote, quoteDeadline } from "./quotes";
export type MoneyAction = "deposit" | "exitAtCost" | "protectedExit" | "buy" | "sell";
type Validity = { available: boolean; reason: number; phase: number; stateNonce: bigint };
type Exit = {
  validity: Validity;
  result: {
    cost: bigint;
    value: bigint;
    premium: bigint;
    cap: bigint;
    profit: bigint;
    qSold: bigint;
    burn: bigint;
    payout: bigint;
  };
};
type Trade = {
  validity: Validity;
  gross: bigint;
  ammAmount: bigint;
  tokens: bigint;
  net: bigint;
  fees: { total: bigint; reserve: bigint; reward: bigint; treasury: bigint };
  priceImpactBps: bigint;
};
export interface ActionQuote {
  available: boolean;
  nonce: bigint;
  deadline: bigint;
  output: bigint;
  debit?: bigint;
  unitCost?: bigint;
  change?: bigint;
  exit?: Exit["result"];
  trade?: Trade;
}
export function useActionQuote(
  detail: RaiseDetail,
  action: MoneyAction,
  amount: bigint,
  positionId: string,
  owner?: Address,
) {
  const client = usePublicClient();
  return useQuery({
    queryKey: ["action-quote", detail.address, action, amount.toString(), positionId, owner, detail.stateNonce],
    // Deposit and buy quotes need no account, so a visitor can preview terms before connecting.
    enabled: Boolean(client && amount > 0n && (owner || action === "deposit" || action === "buy")),
    refetchInterval: 5000,
    retry: 1,
    queryFn: async (): Promise<ActionQuote> => {
      if (action === "deposit") {
        const live = await api.raise(detail.address);
        const q = depositQuote(BigInt(live.targetPrice), BigInt(live.allocation), BigInt(live.sold), amount);
        return {
          available: live.phase === "Stage1" && live.chainTime < live.deadlines.stage1End && q.tokens > 0n,
          nonce: BigInt(live.stateNonce),
          deadline: quoteDeadline(live.chainTime),
          output: q.tokens,
          debit: q.debit,
          unitCost: q.unitCost,
          change: q.change,
        };
      }
      const block = await client!.getBlock();
      const read = (functionName: string, args: unknown[] = []) =>
        client!.readContract({
          address: detail.address as Address,
          abi: raiseAbi,
          functionName,
          args,
          blockNumber: block.number,
        });
      const nonce = (await read("stateNonce")) as bigint;
      const deadline = quoteDeadline(Number(block.timestamp));
      if (action === "exitAtCost" || action === "protectedExit") {
        const quote = (await read(
          action === "exitAtCost" ? "redeemQuote" : "protectedExitQuote",
          action === "exitAtCost" ? [BigInt(positionId), amount, nonce] : [BigInt(positionId), amount],
        )) as Exit;
        return {
          available: quote.validity.available,
          nonce: quote.validity.stateNonce,
          deadline,
          output: quote.validity.available ? quote.result.payout : 0n,
          exit: quote.validity.available ? quote.result : undefined,
        };
      }
      const quote = (await read(
        action === "buy" ? "marketBuyQuote" : "marketExitQuote",
        action === "buy" ? [amount] : [owner, amount],
      )) as Trade;
      return {
        available: quote.validity.available,
        nonce: quote.validity.stateNonce,
        deadline,
        output: quote.validity.available ? (action === "buy" ? quote.tokens : quote.net) : 0n,
        trade: quote.validity.available ? quote : undefined,
      };
    },
  });
}
