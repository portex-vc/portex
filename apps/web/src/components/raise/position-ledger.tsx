"use client";
import { QuoteTable, type Row } from "@/components/figures";
import { ConnectPrompt } from "@/components/shell/wallet";
import type { Position, RaiseSummary } from "@/lib/api";
import { usePosition } from "@/lib/hooks";
import { useNumbers } from "@/lib/use-numbers";
import { useTranslations } from "next-intl";
import { useAccount } from "wagmi";

export function PositionLedger({ detail: r }: { detail: RaiseSummary }) {
  const { address } = useAccount();
  const { data: p, isError, refetch } = usePosition(r.address, address);
  const v = useTranslations("v31");
  const common = useTranslations("common");
  if (!address) return <ConnectPrompt text={v("connect")} />;
  if (isError)
    return (
      <div className="space-y-2">
        <p className="text-sm text-negative">{v("quoteError")}</p>
        <button type="button" className="link text-xs" onClick={() => refetch()}>
          {common("retry")}
        </button>
      </div>
    );
  if (!p) return <div className="skeleton h-24 rounded-[10px]" />;
  return <PositionRecords raise={r} position={p} />;
}

export function PositionRecords({ raise: r, position: p }: { raise: RaiseSummary; position: Position }) {
  const n = useNumbers(),
    v = useTranslations("v31");
  const terminal = p.phase === "Stage3";
  const refunded = p.phase === "Dissolved";
  const usd = (x: bigint | string) => `${n.quote(x)} ${r.quote.symbol}`;
  const tok = (x: bigint | string) => `${n.token(x)} ${r.symbol}`;
  const wallet: Row[] = [
    [v("walletTokens"), tok(p.walletTokenBalance)],
    [v("quota"), tok(p.quota)],
    [v("rewardTokens"), tok(p.pendingRewards.tokens)],
    [v("rewardQuote"), usd(p.pendingRewards.quote)],
  ];
  const buyerTokens = BigInt(p.buyerLedger.tokens);
  // Outside purchases have no claim at cost: before listing they are shown once, as the buyer ledger.
  const records = terminal ? p.positions : p.positions.filter((x) => x.positionState.class !== "Buyer");
  return (
    <div className="space-y-5" data-testid="position-ledger">
      {terminal ? (
        <div className="space-y-2">
          <QuoteTable rows={wallet} />
          <p className="text-2xs leading-relaxed text-fg-3">{v("frozenRecords")}</p>
        </div>
      ) : null}
      {records.length ? (
        <ul className="space-y-4">
          {records.map((x) => {
            const rows: Row[] = [[v(terminal ? "deliveredTokens" : "tokens"), tok(x.positionState.tokens)]];
            if (!refunded)
              rows.push([
                v("validUntil"),
                BigInt(x.guaranteedClaim.validUntil) > 0n
                  ? n.date(Number(x.guaranteedClaim.validUntil))
                  : v("unscheduled"),
              ]);
            if (!terminal && !refunded)
              rows.push(
                [
                  v("costExitQuote"),
                  "result" in x.redeemQuote ? usd(x.redeemQuote.result.payout) : v("unavailableShort"),
                ],
                ...(x.positionState.class === "Backer"
                  ? ([
                      [
                        v("protectedExitQuote"),
                        x.protectedExitQuote && "result" in x.protectedExitQuote
                          ? usd(x.protectedExitQuote.result.payout)
                          : v("unavailableShort"),
                      ],
                    ] as Row[])
                  : []),
                [v("basisReduction"), usd(x.atRiskBasis)],
                [v("quota"), tok(x.positionState.quota)],
              );
            return (
              <li
                key={x.id}
                data-testid={`position-${x.id}`}
                className="space-y-2 border-t border-hairline pt-4 first:border-0 first:pt-0"
              >
                <div className="flex items-baseline justify-between gap-3">
                  <h3 className="text-xs font-medium text-fg-2">
                    #{x.id} · {v(`class${x.positionState.class}`)}
                  </h3>
                  {!terminal ? (
                    <p className="num text-right">
                      <span className="block text-2xs text-fg-3">
                        {v(refunded ? "refundTotal" : "guaranteedClaim")}
                      </span>
                      <span className="text-base font-medium text-protected">{n.quote(x.guaranteedClaim.amount)}</span>{" "}
                      <span className="text-xs text-fg-3">{r.quote.symbol}</span>
                    </p>
                  ) : null}
                </div>
                <QuoteTable rows={rows} />
              </li>
            );
          })}
        </ul>
      ) : !terminal && buyerTokens === 0n ? (
        <p className="text-sm leading-relaxed text-fg-2">{v("noPositions")}</p>
      ) : null}
      {buyerTokens > 0n && !terminal ? (
        <div className="space-y-1 border-t border-hairline pt-4 first:border-0 first:pt-0" data-testid="buyer-ledger">
          <h3 className="text-xs font-medium text-fg-2">{v("buyerLedger")}</h3>
          <QuoteTable rows={[[v("tokens"), tok(buyerTokens)]]} />
          <p className="text-2xs leading-relaxed text-fg-3">{v("buyerLedgerNote")}</p>
        </div>
      ) : null}
      {!terminal && !refunded && records.length ? (
        <p className="text-2xs leading-relaxed text-fg-3">{v("claimValidity")}</p>
      ) : null}
      {BigInt(p.vesting.grant) > 0n ? (
        <div className="border-t border-hairline pt-4">
          <QuoteTable
            rows={[
              [v("vestingGrant"), tok(p.vesting.grant)],
              [v("vestingClaimable"), tok(p.vesting.claimable)],
            ]}
          />
        </div>
      ) : null}
    </div>
  );
}
