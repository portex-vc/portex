"use client";
import { ActionButton } from "@/components/action-button";
import { AmountInput } from "@/components/amount-input";
import { NativeSelect, QuoteTable, type Row } from "@/components/figures";
import { api, type RaiseDetail, type RaiseSummary, type RolloverKind, type RolloverSource } from "@/lib/api";
import { erc20Abi, routerAbi } from "@/lib/contracts";
import { useAllowance, useApiConfig, useRaises, useRolloverSources, useTx } from "@/lib/hooks";
import { depositQuote, minimumOutput, quoteDeadline } from "@/lib/quotes";
import { parseTradeAmount } from "@/lib/trade-amount";
import { useNumbers } from "@/lib/use-numbers";
import { cn } from "@/lib/utils";
import { Check } from "lucide-react";
import { useTranslations } from "next-intl";
import { useMemo, useState } from "react";
import type { Address } from "viem";
import { useAccount } from "wagmi";
import { raiseInvalidations } from "./common";

/** Contract enum order of RolloverRouterV31.SourceKind. */
const KIND: Record<RolloverKind, number> = { CostExit: 0, ProtectedExit: 1, DissolutionClaim: 2 };
/** Rollover slippage on the target curve and on protected-profit sources (basis points). */
const TOLERANCE_BPS = 50;

type Picked = RolloverSource["positions"][number] & { raise: string; name: string; symbol: string; nonce: string };

function toSource(p: Picked) {
  const payout = BigInt(p.minPayout);
  return {
    raise: p.raise as Address,
    kind: KIND[p.kind],
    id: BigInt(p.id),
    quantity: BigInt(p.tokens),
    // Cost exits and dissolution claims pay an exact amount; protected profit can move with other trades.
    minPayout: p.kind === "ProtectedExit" ? minimumOutput(payout, TOLERANCE_BPS) : payout,
    nonce: BigInt(p.nonce),
  };
}

function useRollover(target: Pick<RaiseSummary, "address">) {
  const { address } = useAccount();
  const { data: config } = useApiConfig();
  const router = (config?.addresses.rolloverRouter ?? undefined) as Address | undefined;
  const { send, pending } = useTx();
  async function roll(
    picked: Picked[],
    topUp: bigint,
    label: string,
    preview: Row[],
    onSuccess?: () => void,
  ): Promise<void> {
    if (!router) return;
    // Fresh terms right before signing: the target's nonce and curve position, and each source's nonce.
    const [live, fresh] = await Promise.all([api.raise(target.address), api.rolloverSources(address!)]);
    const nonces = new Map(fresh.sources.map((s) => [s.raise.toLowerCase(), s.stateNonce]));
    const sources = picked.map((p) => toSource({ ...p, nonce: nonces.get(p.raise.toLowerCase()) ?? p.nonce }));
    const total = picked.reduce((sum, p) => sum + BigInt(p.amount), 0n) + topUp;
    const q = depositQuote(BigInt(live.targetPrice), BigInt(live.allocation), BigInt(live.sold), total);
    await send(
      {
        address: router,
        abi: routerAbi,
        functionName: "rollover",
        args: [
          sources,
          topUp,
          target.address,
          minimumOutput(q.tokens, TOLERANCE_BPS),
          BigInt(live.stateNonce),
          quoteDeadline(live.chainTime),
        ],
      },
      {
        label,
        preview,
        invalidate: [
          ...raiseInvalidations(target.address, address),
          ...picked.map((p) => ["raise", p.raise] as const),
          ["position"],
        ],
        onSuccess,
      },
    );
  }
  return { router, roll, pending, send };
}

/**
 * Deposit into this project from positions in other projects (and optionally the wallet) in one
 * transaction: the router exits or claims each source for the caller and deposits the total here.
 */
export function RolloverIn({ detail: r }: { detail: RaiseDetail }) {
  const v = useTranslations("v31"),
    n = useNumbers();
  const { address } = useAccount();
  const sources = useRolloverSources(address);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [topUpInput, setTopUpInput] = useState("");
  const topUp = parseTradeAmount(topUpInput, true);
  const { router, roll, pending, send } = useRollover(r);
  const allowance = useAllowance(r.quote.address as Address, address, router, topUp);
  const available = (sources.data?.sources ?? []).filter((s) => s.raise.toLowerCase() !== r.address.toLowerCase());
  const flat: Picked[] = available.flatMap((s) =>
    s.positions.map((p) => ({ ...p, raise: s.raise, name: s.name, symbol: s.symbol, nonce: s.stateNonce })),
  );
  const picked = flat.filter((p) => chosen.has(`${p.raise}:${p.id}`));
  const fromPositions = picked.reduce((sum, p) => sum + BigInt(p.amount), 0n);
  const total = fromPositions + topUp;
  const q = useMemo(
    () => (total > 0n ? depositQuote(BigInt(r.targetPrice), BigInt(r.allocation), BigInt(r.sold), total) : undefined),
    [total, r.targetPrice, r.allocation, r.sold],
  );
  const usd = (x: bigint | string) => `${n.quote(x)} ${r.quote.symbol}`;
  const rows: Row[] = q
    ? [
        [v("rolloverSelected"), usd(fromPositions)],
        ...(topUp > 0n ? ([[v("rolloverTopUp"), usd(topUp)]] as Row[]) : []),
        [v("debit"), usd(q.debit)],
        [v("change"), usd(q.change)],
        [v("tokensReceived"), `${n.token(q.tokens)} ${r.symbol}`, "total"],
        [v("minimumOutput"), `${n.token(minimumOutput(q.tokens, TOLERANCE_BPS))} ${r.symbol}`],
      ]
    : [];
  const reason = !address
    ? v("connect")
    : !router
      ? v("unavailable")
      : total <= 0n
        ? v("rolloverEmpty")
        : !q || q.tokens === 0n
          ? v("unavailable")
          : null;
  const toggle = (key: string) =>
    setChosen((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  return (
    <div className="space-y-4" data-testid="rollover-in">
      <p className="text-xs leading-relaxed text-fg-2">{v("rolloverHint")}</p>
      {sources.isLoading ? (
        <div className="skeleton h-20 rounded-[10px]" />
      ) : flat.length ? (
        <ul className="divide-y divide-fg/[0.07] overflow-hidden rounded-[12px] border border-fg/[0.08]">
          {flat.map((p) => {
            const key = `${p.raise}:${p.id}`;
            const on = chosen.has(key);
            return (
              <li key={key}>
                <button
                  type="button"
                  role="checkbox"
                  aria-checked={on}
                  data-testid={`rollover-source-${p.raise.toLowerCase()}-${p.id}`}
                  onClick={() => toggle(key)}
                  className={cn(
                    "flex w-full items-center gap-3 px-3.5 py-3 text-left transition-colors duration-150 ease-out",
                    on ? "bg-protected/[0.06]" : "hover:bg-fg/[0.03]",
                  )}
                >
                  <span
                    aria-hidden
                    className={cn(
                      "flex size-4 shrink-0 items-center justify-center rounded-[5px] border transition-colors duration-150",
                      on ? "border-protected bg-protected text-bg" : "border-fg/25",
                    )}
                  >
                    {on ? <Check className="size-3" strokeWidth={3} /> : null}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[0.8125rem] font-medium">
                      {p.name} <span className="font-mono text-2xs text-fg-3">{p.symbol}</span>
                    </span>
                    <span className="block text-2xs text-fg-3">
                      {v("rolloverPosition", { id: p.id })} · {v(`rolloverKind${p.kind}`)}
                    </span>
                  </span>
                  <span className="num shrink-0 text-sm">
                    {n.quote(p.amount)} <span className="text-2xs text-fg-3">{r.quote.symbol}</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="rounded-[12px] border border-dashed border-fg/[0.12] px-4 py-5 text-center text-xs text-fg-3">
          {v("rolloverNone")}
        </p>
      )}
      <div className="space-y-1.5">
        <label htmlFor="rollover-topup" className="eyebrow block">
          {v("rolloverTopUp")}
        </label>
        <AmountInput id="rollover-topup" value={topUpInput} onChange={setTopUpInput} symbol={r.quote.symbol} />
      </div>
      {rows.length ? <QuoteTable rows={rows} testId="rollover-preview" /> : null}
      <ActionButton
        className="w-full"
        data-testid="rollover-submit"
        label={allowance.needsApproval ? v("approve") : v("rolloverSubmit")}
        reason={reason}
        pending={pending || allowance.isLoading}
        onClick={async () => {
          if (reason || !q) return;
          if (allowance.needsApproval) {
            await send(
              { address: r.quote.address as Address, abi: erc20Abi, functionName: "approve", args: [router, topUp] },
              { label: v("approve"), preview: [[v("approveAmount"), usd(topUp), "total"]] },
            );
            await allowance.refetch();
            return;
          }
          await roll(
            picked,
            topUp,
            v("rolloverSubmit"),
            [...rows, [v("tolerance"), `${n.number(TOLERANCE_BPS / 100, 2)}%`, "meta"]],
            () => {
              setChosen(new Set());
              setTopUpInput("");
            },
          );
        }}
      />
      <p className="text-2xs leading-relaxed text-fg-3">{v("rolloverReturned")}</p>
    </div>
  );
}

/**
 * A dissolved project: move every remaining claim into a project in Stage 1, in one transaction.
 */
export function RolloverOut({ detail: r, claims }: { detail: RaiseDetail; claims: { id: string; amount: string }[] }) {
  const v = useTranslations("v31"),
    n = useNumbers();
  const { data: raises } = useRaises();
  const targets = (raises ?? []).filter(
    (x) =>
      x.phase === "Stage1" &&
      x.chainTime < x.deadlines.stage1End &&
      x.address.toLowerCase() !== r.address.toLowerCase(),
  );
  const [pickedTarget, setPickedTarget] = useState("");
  const target = targets.find((x) => x.address === pickedTarget) ?? targets[0];
  const { router, roll, pending } = useRollover(target ?? { address: r.address });
  const total = claims.reduce((sum, c) => sum + BigInt(c.amount), 0n);
  const q = target
    ? depositQuote(BigInt(target.targetPrice), BigInt(target.allocation), BigInt(target.sold), total)
    : null;
  const usd = (x: bigint | string) => `${n.quote(x)} ${r.quote.symbol}`;
  const rows: Row[] =
    target && q
      ? [
          [v("rolloverSelected"), usd(total)],
          [v("debit"), usd(q.debit)],
          [v("change"), usd(q.change)],
          [v("tokensReceived"), `${n.token(q.tokens)} ${target.symbol}`, "total"],
        ]
      : [];
  if (!claims.length) return null;
  return (
    <div className="space-y-3 border-t border-fg/[0.07] pt-4" data-testid="rollover-out">
      <div className="space-y-1">
        <p className="text-sm font-medium">{v("rolloverOut")}</p>
        <p className="text-xs leading-relaxed text-fg-2">{v("rolloverOutHint")}</p>
      </div>
      {targets.length ? (
        <>
          <label className="block space-y-1.5">
            <span className="eyebrow block">{v("rolloverPick")}</span>
            <NativeSelect
              data-testid="rollover-target"
              value={target?.address ?? ""}
              onChange={(e) => setPickedTarget(e.target.value)}
            >
              {targets.map((x) => (
                <option key={x.address} value={x.address}>
                  {x.name} · {x.symbol}
                </option>
              ))}
            </NativeSelect>
          </label>
          <QuoteTable rows={rows} testId="rollover-out-preview" />
          <ActionButton
            className="w-full"
            variant="outline"
            data-testid="rollover-out-submit"
            label={v("rolloverOut")}
            reason={!router ? v("unavailable") : !q || q.tokens === 0n ? v("unavailable") : null}
            pending={pending}
            onClick={() =>
              target &&
              roll(
                claims.map((c) => ({
                  id: c.id,
                  kind: "DissolutionClaim" as const,
                  amount: c.amount,
                  tokens: "0",
                  minPayout: "0",
                  raise: r.address,
                  name: r.name,
                  symbol: r.symbol,
                  nonce: "0",
                })),
                0n,
                v("rolloverOut"),
                rows,
              )
            }
          />
        </>
      ) : (
        <p className="text-xs text-fg-3">{v("rolloverNoTargets")}</p>
      )}
    </div>
  );
}
