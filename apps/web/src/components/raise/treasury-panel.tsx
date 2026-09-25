"use client";
import { ActionButton } from "@/components/action-button";
import { CardHeading, Fig } from "@/components/figures";
import type { RaiseDetail } from "@/lib/api";
import { raiseAbi, tokenAbi } from "@/lib/contracts";
import { useTx } from "@/lib/hooks";
import { useNumbers } from "@/lib/use-numbers";
import { useTranslations } from "next-intl";
import type { Abi, Address } from "viem";
import { useAccount, useReadContract } from "wagmi";
import { raiseInvalidations } from "./common";

const YEAR = 365 * 24 * 60 * 60;

/**
 * The launch's governed treasury (base layer): every fee and the 10% allocation land here, and
 * nothing leaves without an executed proposal. The allocation unlocks on a straight line from listing.
 */
export function TreasuryPanel({ detail: r }: { detail: RaiseDetail }) {
  const v = useTranslations("v31"),
    n = useNumbers();
  const { address } = useAccount();
  const { send, pending } = useTx();
  const t = r.treasury;
  const listed = r.phase === "Stage3";
  const allocation = BigInt(t.allocation);
  const locked = listed ? BigInt(t.lockedTokens) : allocation;
  const unlockedPct = allocation > 0n ? Number(((allocation - locked) * 10000n) / allocation) / 100 : 0;
  const years = Number(t.vestingDuration) / YEAR;
  const pendingFees = BigInt(r.feeAccruals.treasury);
  const disposed = useReadContract({
    address: r.token as Address,
    abi: tokenAbi,
    functionName: "disposedQuote",
    query: { enabled: listed, refetchInterval: 15000 },
  });
  const sweep = (abi: Abi, target: string, fn: string, label: string, value: string) =>
    send(
      { address: target as Address, abi, functionName: fn, args: [] },
      {
        label: v(label),
        preview: [
          [v("treasury"), t.address],
          [v("payout"), value, "total"],
        ],
        invalidate: raiseInvalidations(r.address, address),
      },
    );
  return (
    <section className="surface-1 space-y-5 p-5" data-testid="treasury-panel">
      <CardHeading eyebrow={v("treasuryTitle")} title={v("treasuryIntro")} />
      <dl className="grid grid-cols-2 gap-5 sm:grid-cols-4">
        <Fig label={v("treasuryQuote")} value={n.quote(t.availableQuote)} unit={r.quote.symbol} tone="protected" />
        <Fig label={v("treasuryAllocation")} value={n.token(allocation)} unit={r.symbol} />
        <Fig label={v("treasuryUnlocked")} value={n.token(listed ? t.spendableTokens : 0n)} unit={r.symbol} />
        <Fig
          label={v("treasurySpent")}
          value={
            <>
              {n.quote(t.spentQuote)}
              <span className="ml-1 text-xs font-normal tracking-normal text-fg-3">{r.quote.symbol}</span>
              {BigInt(t.spentTokens) > 0n ? (
                <span className="block text-xs font-normal text-fg-3">
                  + {n.token(t.spentTokens)} {r.symbol}
                </span>
              ) : null}
            </>
          }
        />
      </dl>
      <div className="space-y-2">
        <div className="flex items-baseline justify-between text-xs">
          <span className="text-fg-3">{v("treasuryLocked")}</span>
          <span className="num text-fg-2">
            {n.token(locked)} {r.symbol}
          </span>
        </div>
        <div
          className="relative h-1.5 overflow-hidden rounded-full bg-fg/[0.08]"
          role="meter"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(unlockedPct)}
          aria-label={v("treasuryUnlocked")}
        >
          <div
            className="absolute inset-y-0 left-0 rounded-full bg-protected transition-[width] duration-700 ease-out"
            style={{ width: `${unlockedPct}%` }}
          />
        </div>
        <p className="text-2xs leading-relaxed text-fg-3">
          {listed
            ? v("treasurySchedule", { years: n.number(years, 0), pct: n.pct(Math.round(1000 / years)) })
            : v("treasuryBeforeListing", { years: n.number(years, 0) })}
        </p>
      </div>
      {address && (pendingFees > 0n || listed) ? (
        <div className="flex flex-wrap gap-2 border-t border-fg/[0.07] pt-4" data-testid="treasury-actions">
          {pendingFees > 0n ? (
            <ActionButton
              size="sm"
              variant="outline"
              label={v("claimFees")}
              pending={pending}
              onClick={() => sweep(raiseAbi, r.address, "claimTreasuryFees", "claimFees", n.quote(pendingFees))}
            />
          ) : null}
          {listed ? (
            <ActionButton
              size="sm"
              variant="outline"
              label={v("collectLPFees")}
              pending={pending}
              onClick={() => sweep(raiseAbi, r.address, "collectLPFees", "collectLPFees", "—")}
            />
          ) : null}
          {listed && disposed.data ? (
            <ActionButton
              size="sm"
              variant="outline"
              label={v("claimDisposed")}
              pending={pending}
              onClick={() =>
                sweep(tokenAbi, r.token, "claimDisposed", "claimDisposed", n.quote(disposed.data as bigint))
              }
            />
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
