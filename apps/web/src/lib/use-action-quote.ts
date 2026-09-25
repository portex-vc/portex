"use client";
import { useQuery } from "@tanstack/react-query";
import type { Address } from "viem";
import { api, type ExitResultV2, type RaiseDetail, type TradeQuoteV2 } from "./api";
import { depositQuote, quoteDeadline } from "./quotes";
export type MoneyAction = "deposit" | "exitAtCost" | "protectedExit" | "buy" | "sell";
type Validity = { available: boolean; stateNonce: bigint };
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
  return useQuery({
    queryKey: ["action-quote", detail.address, action, amount.toString(), positionId, owner, detail.stateNonce],
    // Deposit and buy quotes need no account, so a visitor can preview terms before connecting.
    enabled: amount > 0n && Boolean(owner || action === "deposit" || action === "buy"),
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
      // The API mirrors the contract's quote views at one block; the wallet re-checks at signing.
      const exit = action === "exitAtCost" || action === "protectedExit";
      const quote = await api.raiseQuote(detail.address, {
        side: action === "buy" ? "buy" : "sell",
        amount,
        ...(exit
          ? { position: positionId, exit: action === "exitAtCost" ? ("cost" as const) : ("protected" as const) }
          : { owner }),
      });
      const chainTime = quote.chainTime;
      const validity = toValidity(quote.validity);
      const deadline = quoteDeadline(chainTime);
      if (exit) {
        const result = "result" in quote ? toExit(quote.result) : undefined;
        return {
          available: validity.available && Boolean(result),
          nonce: validity.stateNonce,
          deadline,
          output: validity.available && result ? result.payout : 0n,
          exit: validity.available ? result : undefined,
        };
      }
      const trade = "gross" in quote ? toTrade(quote, validity) : undefined;
      return {
        available: validity.available && Boolean(trade),
        nonce: validity.stateNonce,
        deadline,
        output: validity.available && trade ? (action === "buy" ? trade.tokens : trade.net) : 0n,
        trade: validity.available ? trade : undefined,
      };
    },
  });
}

function toValidity(v: { available: boolean; stateNonce: string }): Validity {
  return { available: v.available, stateNonce: BigInt(v.stateNonce) };
}

function toExit(r: ExitResultV2): Exit["result"] {
  return {
    cost: BigInt(r.cost),
    value: BigInt(r.value),
    premium: BigInt(r.premium),
    cap: BigInt(r.cap),
    profit: BigInt(r.profit),
    qSold: BigInt(r.qSold),
    burn: BigInt(r.burn),
    payout: BigInt(r.payout),
  };
}

function toTrade(q: Extract<TradeQuoteV2, { gross: string }>, validity: Validity): Trade {
  return {
    validity,
    gross: BigInt(q.gross),
    ammAmount: BigInt(q.ammAmount),
    tokens: BigInt(q.tokens),
    net: BigInt(q.net),
    fees: {
      total: BigInt(q.fees.total),
      reserve: BigInt(q.fees.reserve),
      reward: BigInt(q.fees.reward),
      treasury: BigInt(q.fees.treasury),
    },
    priceImpactBps: BigInt(q.priceImpactBps),
  };
}
