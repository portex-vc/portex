"use client";
import { ActionButton } from "@/components/action-button";
import { AmountInput } from "@/components/amount-input";
import type { Row } from "@/components/figures";
import { Input } from "@/components/ui/input";
import { raiseInvalidations } from "@/components/raise/common";
import type { RaiseDetail } from "@/lib/api";
import { governanceAbi } from "@/lib/contracts";
import { useNow, useProposals, useTx } from "@/lib/hooks";
import { parseTradeAmount } from "@/lib/trade-amount";
import { useNumbers } from "@/lib/use-numbers";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { isAddress, type Address } from "viem";
import { useAccount } from "wagmi";

/**
 * Builder-only treasury spend proposal (base layer): Stage 2 pays USDG fee income by capital vote;
 * Stage 3 pays USDG and unlocked tokens by token-holder vote.
 */
export function SpendEditor({ detail: r }: { detail: RaiseDetail }) {
  const v = useTranslations("v31"),
    n = useNumbers(),
    now = useNow();
  const { address } = useAccount();
  const { send, pending } = useTx();
  const { data: proposals } = useProposals(r.address, true);
  const [recipient, setRecipient] = useState("");
  const [quoteInput, setQuoteInput] = useState("");
  const [tokenInput, setTokenInput] = useState("");
  const [uri, setUri] = useState("");
  const quoteAmount = parseTradeAmount(quoteInput, true);
  const tokenAmount = parseTradeAmount(tokenInput, false);
  const lastProposalAt = Number(r.governance.state.lastProposalAt ?? 0);
  const params = r.governance.config.parameters;
  const listed = r.phase === "Stage3";
  const required = Number(params.voting) + Number(params.dispute) + Number(params.execution);
  const available = BigInt(r.treasury.availableQuote);
  const spendableTokens = listed ? BigInt(r.treasury.spendableTokens) : 0n;
  const reason =
    r.phase !== "Stage2" && !listed
      ? v("unavailable")
      : proposals?.some((p) => ["Voting", "AwaitingFinalization", "Dispute", "Executable"].includes(p.state))
        ? v("proposalActive")
        : lastProposalAt > 0 && now < lastProposalAt + Number(params.proposalInterval)
          ? v("proposalCooldown")
          : !listed && now + required > r.deadlines.stage2End
            ? v("proposalTooLate")
            : !isAddress(recipient) || recipient.toLowerCase() === r.treasury.address.toLowerCase()
              ? v("recipientError")
              : quoteAmount + tokenAmount <= 0n
                ? v("enterAmount")
                : quoteAmount > available || tokenAmount > spendableTokens
                  ? v("spendError")
                  : uri.trim().length === 0
                    ? v("enterUri")
                    : null;
  if (address?.toLowerCase() !== r.builder.toLowerCase()) return null;
  return (
    <form
      className="space-y-3 border-t border-hairline pt-4 first:border-t-0 first:pt-0"
      data-testid="spend-editor"
      onSubmit={(e) => {
        e.preventDefault();
        if (!reason)
          void send(
            {
              address: r.modules.governor as Address,
              abi: governanceAbi,
              functionName: "proposeSpend",
              args: [recipient as Address, quoteAmount, tokenAmount, uri.trim()],
            },
            {
              label: v("proposeSpend"),
              preview: [
                [v("recipient"), recipient],
                ...(quoteAmount > 0n ? ([[v("amount"), `${n.quote(quoteAmount)} ${r.quote.symbol}`]] as Row[]) : []),
                ...(tokenAmount > 0n ? ([[v("spendTokens"), `${n.token(tokenAmount)} ${r.symbol}`]] as Row[]) : []),
                [v("uri"), uri],
                [v(listed ? "modeToken" : "modeCapital"), v("spendHint"), "meta"],
              ],
              invalidate: raiseInvalidations(r.address, address),
              onSuccess: () => {
                setQuoteInput("");
                setTokenInput("");
                setUri("");
              },
            },
          );
      }}
    >
      <div className="space-y-1">
        <p className="eyebrow">{v("builderOnly")}</p>
        <h3 className="text-sm font-medium">{v("proposeSpend")}</h3>
        <p className="text-2xs leading-relaxed text-fg-3">{v("spendHint")}</p>
      </div>
      <label className="block space-y-1.5">
        <span className="eyebrow block">{v("recipient")}</span>
        <Input
          id="spend-recipient"
          value={recipient}
          spellCheck={false}
          placeholder="0x…"
          className="font-mono"
          onChange={(e) => setRecipient(e.target.value.trim())}
        />
      </label>
      <div className="space-y-1.5">
        <label htmlFor="spend-quote" className="eyebrow block">
          {v("amount")}
        </label>
        <AmountInput
          id="spend-quote"
          value={quoteInput}
          onChange={setQuoteInput}
          symbol={r.quote.symbol}
          balance={available}
          balanceDecimals={6}
          balanceLabel={v("treasuryQuote")}
        />
      </div>
      {listed ? (
        <div className="space-y-1.5">
          <label htmlFor="spend-tokens" className="eyebrow block">
            {v("spendTokens")}
          </label>
          <AmountInput
            id="spend-tokens"
            value={tokenInput}
            onChange={setTokenInput}
            symbol={r.symbol}
            balance={spendableTokens}
            balanceDecimals={18}
            balanceLabel={v("treasuryUnlocked")}
          />
        </div>
      ) : null}
      <label className="block space-y-1.5">
        <span className="eyebrow block">{v("uri")}</span>
        <Input
          id="spend-uri"
          value={uri}
          maxLength={2000}
          placeholder="https://…"
          onChange={(e) => setUri(e.target.value)}
        />
        <span className="block text-2xs text-fg-3">{v("uriHint")}</span>
      </label>
      <ActionButton
        type="submit"
        data-testid="propose-spend"
        label={v("proposeSpend")}
        reason={reason}
        pending={pending}
      />
    </form>
  );
}
