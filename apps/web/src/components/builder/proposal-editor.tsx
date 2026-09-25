"use client";
import { ActionButton } from "@/components/action-button";
import { AmountInput } from "@/components/amount-input";
import { Input } from "@/components/ui/input";
import type { RaiseDetail } from "@/lib/api";
import { governanceAbi } from "@/lib/contracts";
import { useNow, useProposals, useTx } from "@/lib/hooks";
import { parseTradeAmount } from "@/lib/trade-amount";
import { useNumbers } from "@/lib/use-numbers";
import { raiseInvalidations } from "@/components/raise/common";
import { useTranslations } from "next-intl";
import { useState } from "react";
import type { Address } from "viem";
import { useAccount } from "wagmi";
export function ProposalEditor({ detail: r }: { detail: RaiseDetail }) {
  const v = useTranslations("v31"),
    n = useNumbers(),
    now = useNow();
  const { address } = useAccount();
  const { send, pending } = useTx();
  const { data: proposals } = useProposals(r.address, true);
  const [amount, setAmount] = useState(""),
    [uri, setUri] = useState("");
  const value = parseTradeAmount(amount, true);
  const lastProposalAt = Number(r.governance.state.lastProposalAt ?? 0);
  const params = r.governance.config.parameters;
  const remaining = BigInt(r.governance.state.remainingCeiling),
    escrow = BigInt(r.E);
  const ceiling = remaining < escrow ? remaining : escrow;
  const required = Number(params.voting) + Number(params.dispute) + Number(params.execution);
  const reason =
    r.phase !== "Stage2"
      ? v("stage2Only")
      : proposals?.some((p) => ["Voting", "AwaitingFinalization", "Dispute", "Executable"].includes(p.state))
        ? v("proposalActive")
        : lastProposalAt > 0 && now < lastProposalAt + Number(params.proposalInterval)
          ? v("proposalCooldown")
          : now + required > r.deadlines.stage2End
            ? v("proposalTooLate")
            : value <= 0n
              ? v("enterAmount")
              : value > BigInt(r.governance.state.remainingCeiling) || value > BigInt(r.E)
                ? v("budgetExceeded")
                : uri.trim().length === 0
                  ? v("enterUri")
                  : null;
  if (address?.toLowerCase() !== r.builder.toLowerCase() || !r.governance.config.enabled) return null;
  return (
    <form
      className="space-y-3 border-t border-hairline pt-4 first:border-t-0 first:pt-0"
      onSubmit={(e) => {
        e.preventDefault();
        if (!reason)
          void send(
            {
              address: r.modules.governor as Address,
              abi: governanceAbi,
              functionName: "propose",
              args: [value, uri.trim()],
            },
            {
              label: v("propose"),
              preview: [
                [v("amount"), `${n.quote(value)} ${r.quote.symbol}`, "total"],
                [v("uri"), uri],
                [v("haircut"), v("haircutShort")],
              ],
              invalidate: raiseInvalidations(r.address, address),
            },
          );
      }}
    >
      <div className="space-y-1">
        <p className="eyebrow">{v("builderOnly")}</p>
        <h3 className="text-sm font-medium">{v("propose")}</h3>
      </div>
      <label htmlFor="proposal-amount" className="eyebrow block">
        {v("amount")}
      </label>
      <AmountInput
        id="proposal-amount"
        value={amount}
        onChange={setAmount}
        symbol={r.quote.symbol}
        balance={ceiling}
        balanceDecimals={6}
        balanceLabel={v("remainingBudget")}
      />
      <label className="block space-y-1.5">
        <span className="eyebrow block">{v("uri")}</span>
        <Input
          id="proposal-uri"
          value={uri}
          maxLength={2000}
          placeholder="https://…"
          onChange={(e) => setUri(e.target.value)}
        />
        <span className="block text-2xs text-fg-3">{v("uriHint")}</span>
      </label>
      <ActionButton type="submit" data-testid="propose" label={v("propose")} reason={reason} pending={pending} />
    </form>
  );
}
