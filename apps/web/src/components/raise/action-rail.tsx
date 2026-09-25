"use client";
import { TestUsdgFaucet } from "@/components/test-usdg-faucet";
import { ActionButton } from "@/components/action-button";
import { AmountInput } from "@/components/amount-input";
import { CardHeading, Fig, NativeSelect, QuoteTable, Segmented, type Row } from "@/components/figures";
import { ConnectPrompt } from "@/components/shell/wallet";
import { Button } from "@/components/ui/button";
import { walletSheet } from "@/lib/wallet-sheet";
import { ArrowRight, Wallet } from "lucide-react";
import { useTradeHref } from "@/lib/trade-link";
import { spotlight } from "@/lib/spotlight";
import { ProjectAvatar } from "./project-avatar";
import type { Position, RaiseDetail } from "@/lib/api";
import { claimsAbi, erc20Abi, raiseAbi, tokenAbi, vestingAbi } from "@/lib/contracts";
import { useAllowance, useNow, usePosition, useTx } from "@/lib/hooks";
import { minimumOutput, parseTolerance } from "@/lib/quotes";
import { useActionQuote, type MoneyAction } from "@/lib/use-action-quote";
import { parseTradeAmount } from "@/lib/trade-amount";
import { useNumbers } from "@/lib/use-numbers";
import { cn } from "@/lib/utils";
import { displayAmountInput, normalizeAmountEdit } from "@/lib/amount-input";
import { RefreshCw } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import Link from "next/link";
import { useState } from "react";
import type { Abi, Address } from "viem";
import { useAccount } from "wagmi";
import { raiseInvalidations } from "./common";
import { PositionLedger } from "./position-ledger";
import { ProtectionBoundary } from "./type-badge";
import { RolloverIn, RolloverOut } from "./rollover";

export function ActionRail({ detail: r }: { detail: RaiseDetail }) {
  const v = useTranslations("v31"),
    t = useTranslations("raise.rail");
  const { address } = useAccount();
  const { data: p } = usePosition(r.address, address);
  const builder = address && [r.builder, ...r.config.builders].some((a) => a.toLowerCase() === address.toLowerCase());
  return (
    <aside
      id="action-rail"
      data-testid="action-rail"
      aria-label={t("title")}
      className="order-first flex min-w-0 flex-col gap-4 self-start lg:sticky lg:top-24 lg:order-last"
    >
      <section className="surface-1 p-5 shadow-[var(--overlay-shadow)] sm:p-6">
        <h2 className="micro mb-3">{t("title")}</h2>
        {r.phase === "Stage3" || r.phase === "Dissolved" ? null : (
          <ProtectionBoundary template={r.template} className="mb-5 border-b border-fg/[0.07] pb-4 text-fg-3" />
        )}
        {r.phase === "Stage3" ? (
          <>
            <TradeEntry detail={r} />
            <TerminalActions detail={r} position={p} />
          </>
        ) : r.phase === "Dissolved" ? (
          <DissolvedActions detail={r} position={p} />
        ) : (
          <>
            <LifecycleActions detail={r} />
            <MoneyForm key={`${r.address}-${address}-${r.phase}`} detail={r} position={p} builder={Boolean(builder)} />
          </>
        )}
      </section>
      <section className="surface-1 p-5 sm:p-6">
        <h2 className="micro mb-4">{t("position")}</h2>
        <PositionLedger detail={r} />
      </section>
      {address?.toLowerCase() === r.builder.toLowerCase() ? (
        <Link
          href={`/raise/${r.address}/manage`}
          onPointerMove={spotlight}
          className="surface-1 card-interactive group flex items-center justify-between gap-3 p-5 text-sm"
        >
          <span>
            <span className="eyebrow block">{t("roleBuilder")}</span>
            <span className="mt-1 block font-medium">{t("manage")}</span>
          </span>
          <ArrowRight
            aria-hidden
            className="size-4 text-fg-3 transition-[transform,color] duration-200 ease-out group-hover:translate-x-0.5 group-hover:text-fg"
          />
        </Link>
      ) : null}
      {r.vetoActive ? <p className="px-1 text-xs leading-relaxed text-fg-2">{v("vetoDisplay")}</p> : null}
    </aside>
  );
}

/** Stage 3: the project trades on the open market; one clear way in from the rail. */
function TradeEntry({ detail: r }: { detail: RaiseDetail }) {
  const t = useTranslations("raise");
  const href = useTradeHref(r);
  if (!href) return null;
  return (
    <Link
      href={href}
      data-testid="trade-entry"
      className="group mb-6 flex items-center gap-3 rounded-[12px] border border-fg/[0.08] bg-fg/[0.025] p-3 transition-[border-color,background-color,transform] duration-200 ease-out hover:border-fg/[0.16] hover:bg-fg/[0.045] active:scale-[0.99]"
    >
      <ProjectAvatar symbol={r.symbol} profile={r.profile} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-fg">
          {r.symbol} <span className="font-normal text-fg-3">/ {r.quote.symbol}</span>
        </span>
        <span className="mt-0.5 block truncate text-xs text-fg-3">{t("tradeHint")}</span>
      </span>
      <span className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-[9px] bg-fg px-3 text-[0.8125rem] font-medium text-bg shadow-[inset_0_1px_0_rgb(255_255_255/0.14),0_1px_2px_rgb(0_0_0/0.18)] transition-colors group-hover:bg-fg/90">
        {t("trade")}
        <ArrowRight
          className="size-3.5 transition-transform duration-200 ease-out group-hover:translate-x-0.5"
          aria-hidden
        />
      </span>
    </Link>
  );
}

function MoneyForm({
  detail: r,
  position: p,
  builder,
}: {
  detail: RaiseDetail;
  position?: Position;
  builder: boolean;
}) {
  const v = useTranslations("v31"),
    n = useNumbers();
  const now = useNow();
  const { address } = useAccount();
  const { send, pending } = useTx();
  const positions =
    p?.positions.filter((x) => x.positionState.class !== "Buyer" && BigInt(x.positionState.tokens) > 0n) ?? [];
  const choices: MoneyAction[] = [
    ...(r.phase === "Stage1" && now < r.deadlines.stage1End ? ["deposit" as const] : []),
    ...(positions.length ? ["exitAtCost" as const] : []),
    ...(r.phase === "Stage2" && positions.some((x) => x.positionState.class === "Backer")
      ? ["protectedExit" as const]
      : []),
    ...(r.phase === "Stage2" && !builder ? ["buy" as const] : []),
    ...(BigInt(p?.buyerLedger.tokens ?? 0n) > 0n ? ["sell" as const] : []),
  ];
  const [selected, setSelected] = useState<MoneyAction | null>(null);
  const action = selected && choices.includes(selected) ? selected : (choices[0] ?? "exitAtCost");
  const eligible = positions.filter((x) => action !== "protectedExit" || x.positionState.class === "Backer");
  const [picked, setPicked] = useState("");
  const selectedPosition = eligible.find((x) => x.id === picked) ?? eligible[0];
  const [amount, setAmount] = useState("");
  const [tolerance, setTolerance] = useState("0.5");
  const [payFrom, setPayFrom] = useState<"wallet" | "positions">("wallet");
  const rolling = action === "deposit" && payFrom === "positions" && Boolean(address);
  const locale = useLocale();
  const inputQuote = action === "deposit" || action === "buy";
  const parsed = parseTradeAmount(amount, inputQuote);
  const isExit = action === "exitAtCost" || action === "protectedExit";
  const maximum = inputQuote
    ? BigInt(p?.walletQuoteBalance ?? 0n)
    : BigInt(isExit ? (selectedPosition?.positionState.tokens ?? 0) : (p?.buyerLedger.tokens ?? 0n));
  const quote = useActionQuote(r, action, parsed, selectedPosition?.id ?? "0", address);
  const bps = parseTolerance(tolerance);
  const q = quote.data;
  const min = q && bps !== null ? minimumOutput(q.output, bps) : 0n;
  const allowance = useAllowance(r.quote.address as Address, address, r.address as Address, inputQuote ? parsed : 0n);
  const usd = (x: bigint | string) => `${n.quote(x)} ${r.quote.symbol}`;
  const tok = (x: bigint | string) => `${n.token(x)} ${r.symbol}`;
  const rows: Row[] = [];
  if (q?.available) {
    if (q.debit !== undefined)
      rows.push(
        [v("debit"), usd(q.debit)],
        [v("unitCost"), `${n.price(q.unitCost ?? 0n)} ${r.quote.symbol}`],
        [v("change"), usd(q.change ?? 0n)],
      );
    // Stage 1 exits burn nothing: the tokens go back on sale for other backers.
    if (q.exit && r.phase === "Stage1")
      rows.push([v("returnedToSale"), tok(parsed)], [v("cost"), usd(q.exit.cost), "protected"]);
    else if (q.exit)
      rows.push(
        [v("qSold"), tok(q.exit.qSold)],
        [v("burn"), tok(q.exit.burn)],
        [v("cost"), usd(q.exit.cost), "protected"],
        [v("premium"), usd(q.exit.premium)],
        [v("profit"), usd(q.exit.profit)],
      );
    if (q.trade)
      rows.push([v("fee"), usd(q.trade.fees.total)], [v("priceImpact"), n.pct(Number(q.trade.priceImpactBps))]);
    rows.push(
      [v(inputQuote ? "tokensReceived" : "payout"), inputQuote ? tok(q.output) : usd(q.output), "total"],
      [v("minimumOutput"), inputQuote ? tok(min) : usd(min)],
      [v("nonce"), `#${q.nonce.toString()}`, "meta"],
      [v("quoteExpires"), n.date(Number(q.deadline)), "meta"],
    );
  }
  const reason = !address
    ? null
    : !choices.length
      ? v("noActions")
      : parsed <= 0n
        ? v("enterAmount")
        : parsed > maximum
          ? v("exceedsBalance")
          : bps === null
            ? v("toleranceError")
            : quote.isError
              ? v("quoteError")
              : !q?.available
                ? v("unavailable")
                : now >= Number(q.deadline)
                  ? v("quoteExpired")
                  : null;
  async function submit() {
    if (reason || !q) return;
    if (allowance.needsApproval) {
      await send(
        { address: r.quote.address as Address, abi: erc20Abi, functionName: "approve", args: [r.address, parsed] },
        {
          label: v("approve"),
          preview: [[v("approveAmount"), usd(parsed), "total"]],
          onSuccess: async () => {
            await allowance.refetch();
          },
        },
      );
      return;
    }
    const args = isExit
      ? [BigInt(selectedPosition!.id), parsed, min, q.nonce, q.deadline]
      : [parsed, min, q.nonce, q.deadline];
    await send(
      { address: r.address as Address, abi: raiseAbi, functionName: action, args },
      {
        label: v(action),
        preview: [
          ...(isExit && selectedPosition
            ? ([
                [v("position"), `#${selectedPosition.id} · ${v(`class${selectedPosition.positionState.class}`)}`],
              ] as Row[])
            : []),
          [v(inputQuote ? "amount" : "quantity"), inputQuote ? usd(parsed) : tok(parsed)],
          ...rows,
          [v("tolerance"), `${n.number(Number(tolerance), 2)}%`, "meta"],
        ],
        invalidate: [...raiseInvalidations(r.address, address), ["action-quote"]],
        onSuccess: () => setAmount(""),
      },
    );
  }
  if (!address && !choices.length)
    return r.phase === "ListingPending" || (r.phase === "Stage1" && now >= r.deadlines.stage1End) ? null : (
      <ConnectPrompt text={v("connectToAct")} />
    );
  if (!choices.length) return <p className="text-sm leading-relaxed text-fg-2">{v("noActions")}</p>;
  return (
    <div className="space-y-5" data-testid="money-form">
      {action === "deposit" && p?.walletQuoteBalance === "0" ? <TestUsdgFaucet quoteAddress={r.quote.address} /> : null}
      <div className="space-y-2.5">
        {choices.length > 1 ? (
          <Segmented
            label={v("action")}
            value={action}
            options={choices.map((x) => ({ value: x, label: v(x) }))}
            testId={(x) => `action-${x}`}
            onChange={(x) => {
              setSelected(x);
              setAmount("");
            }}
          />
        ) : (
          <h3 className="text-base font-medium tracking-[-0.01em]" data-testid={`action-${action}`}>
            {v(action)}
          </h3>
        )}
        <p className="text-xs leading-relaxed text-fg-2">{v(`explain.${action}`)}</p>
      </div>
      {action === "deposit" && address ? (
        <div className="space-y-1.5">
          <p className="eyebrow">{v("payFrom")}</p>
          <Segmented
            label={v("payFrom")}
            value={payFrom}
            options={[
              { value: "wallet" as const, label: v("payWallet") },
              { value: "positions" as const, label: v("payPositions") },
            ]}
            testId={(x) => `pay-from-${x}`}
            onChange={setPayFrom}
          />
        </div>
      ) : null}
      {rolling ? <RolloverIn detail={r} /> : null}
      {rolling ? null : (
        <>
          {isExit ? (
            <label className="block space-y-1.5">
              <span className="eyebrow block">{v("position")}</span>
              <NativeSelect
                data-testid="position-picker"
                value={selectedPosition?.id ?? ""}
                onChange={(e) => {
                  setPicked(e.target.value);
                  setAmount("");
                }}
              >
                {eligible.map((x) => (
                  <option key={x.id} value={x.id}>
                    #{x.id} · {v(`class${x.positionState.class}`)} · {n.token(x.positionState.tokens)} {r.symbol}
                  </option>
                ))}
              </NativeSelect>
            </label>
          ) : null}
          <div className="space-y-1.5">
            <label htmlFor="action-amount" className="eyebrow block">
              {v(inputQuote ? "amount" : "quantity")}
            </label>
            <AmountInput
              id="action-amount"
              value={amount}
              onChange={setAmount}
              symbol={inputQuote ? r.quote.symbol : r.symbol}
              balance={address ? maximum : undefined}
              balanceDecimals={address ? (inputQuote ? 6 : 18) : undefined}
              balanceLabel={v(inputQuote ? "walletBalance" : isExit ? "positionTokens" : "ledgerTokens")}
              maxTestId={inputQuote ? undefined : "quantity-all"}
            />
          </div>
          <label className="flex items-center justify-between gap-3">
            <span className="text-xs text-fg-2">{v("tolerance")}</span>
            <span className="flex items-center gap-1.5">
              <input
                aria-label={v("tolerance")}
                data-testid="tolerance"
                className={cn(
                  "num h-8 w-16 rounded-md border bg-transparent px-2 text-right text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                  bps === null ? "border-negative" : "border-hairline",
                )}
                inputMode="decimal"
                value={displayAmountInput(tolerance, locale)}
                onChange={(e) => setTolerance(normalizeAmountEdit(e.target.value, locale))}
              />
              <span className="text-xs text-fg-3">%</span>
            </span>
          </label>
          <section className="rounded-[12px] border border-fg/[0.07] bg-fg/[0.02] px-4 py-3" aria-live="polite">
            <CardHeading
              eyebrow={v("quote")}
              aside={
                <button
                  type="button"
                  onClick={() => quote.refetch()}
                  disabled={parsed <= 0n || quote.isFetching}
                  className="inline-flex items-center gap-1 text-2xs text-fg-2 transition-colors hover:text-fg disabled:opacity-40"
                >
                  <RefreshCw className={cn("size-3", quote.isFetching && "animate-spin")} aria-hidden />
                  {v("refreshQuote")}
                </button>
              }
              className="mb-2"
            />
            <QuoteTable rows={rows} testId="quote-preview" empty={v("quotePrompt")} />
          </section>
          {!address ? (
            <Button size="lg" className="w-full" data-testid="submit-connect" onClick={walletSheet.open}>
              <Wallet /> {v("connectCta")}
            </Button>
          ) : (
            <ActionButton
              className="w-full"
              data-testid="submit-action"
              label={v(allowance.needsApproval ? "approve" : action)}
              reason={reason}
              pending={pending || (parsed > 0n && quote.isFetching && !q) || allowance.isLoading}
              onClick={submit}
            />
          )}
        </>
      )}
      <p className="text-2xs leading-relaxed text-fg-3">{v("noDemand")}</p>
    </div>
  );
}

function LifecycleActions({ detail: r }: { detail: RaiseDetail }) {
  const now = useNow(),
    v = useTranslations("v31"),
    n = useNumbers();
  const { address } = useAccount();
  const { send, pending } = useTx();
  const listing = r.phase === "ListingPending";
  const due = r.phase === "Stage1" && now >= r.deadlines.stage1End;
  if (!listing && !due) return null;
  const preview = r.listingPreview && "price" in r.listingPreview ? r.listingPreview : null;
  const rows: Row[] = preview
    ? [
        [v("listingQuote"), `${n.quote(preview.usedQuote)} ${r.quote.symbol}`],
        [v("listingTokens"), `${n.token(preview.usedToken)} ${r.symbol}`],
        [v("branch"), v(`branch${preview.branch}`)],
        [v("listingPrice"), `${n.price(preview.price)} ${r.quote.symbol}`, "total"],
      ]
    : [];
  // Stage 1 exits return allocation to the sale: the project graduates if backers hold at least 95% of it.
  const gates =
    BigInt(r.sold) * 10000n >= BigInt(r.allocation) * 9500n &&
    r.backers >= r.governance.config.parameters.minimumBackers &&
    BigInt(r.E) > 0n;
  const vetoBlocks = due && gates && now < r.deadlines.vetoUntil;
  return (
    <div
      className="mb-5 space-y-4 border-b border-fg/[0.07] pb-5 last:mb-0 last:border-b-0 last:pb-0"
      data-testid={listing ? "listing-card" : "close-stage1-card"}
    >
      <CardHeading
        eyebrow={v(listing ? "listingEyebrow" : "stage1DueEyebrow")}
        title={v(listing ? "listingTitle" : "stage1DueTitle")}
      />
      {listing ? (
        preview ? (
          <>
            <Fig label={v("listingPrice")} value={n.price(preview.price)} unit={r.quote.symbol} size="lg" />
            <QuoteTable rows={rows.slice(0, 3)} />
          </>
        ) : (
          <p className="text-xs text-fg-2">{v("unavailable")}</p>
        )
      ) : (
        <p className="text-xs leading-relaxed text-fg-2">{v(gates ? "stage1Success" : "stage1WillRefund")}</p>
      )}
      {listing ? <p className="text-xs leading-relaxed text-fg-2">{v("listingBoundary")}</p> : null}
      {!address ? (
        <Button size="lg" className="w-full" data-testid="submit-connect" onClick={walletSheet.open}>
          <Wallet /> {v("connectCta")}
        </Button>
      ) : (
        <ActionButton
          className="w-full"
          data-testid={listing ? "list-action" : "close-stage1"}
          label={v(listing ? "list" : "closeStage1")}
          pending={pending}
          reason={
            listing && !preview?.validity.available
              ? v("unavailable")
              : vetoBlocks
                ? v("vetoUntil", { date: n.date(r.deadlines.vetoUntil) })
                : null
          }
          onClick={() =>
            send(
              { address: r.address as Address, abi: raiseAbi, functionName: listing ? "list" : "advanceStage1" },
              {
                label: v(listing ? "list" : "closeStage1"),
                preview: listing ? rows : [[v("outcome"), v(gates ? "outcomeStage2" : "outcomeRefund"), "total"]],
                invalidate: raiseInvalidations(r.address, address),
              },
            )
          }
        />
      )}
    </div>
  );
}

/** Dissolved: take back each position at cost, or move everything into a project in Stage 1 in one transaction. */
function DissolvedActions({ detail: r, position: p }: { detail: RaiseDetail; position?: Position }) {
  const v = useTranslations("v31"),
    n = useNumbers();
  const { address } = useAccount();
  const { send, pending } = useTx();
  const records = p?.positions.filter((x) => BigInt(x.guaranteedClaim.amount) > 0n) ?? [];
  const total = records.reduce((sum, x) => sum + BigInt(x.guaranteedClaim.amount), 0n);
  return (
    <div className="space-y-4" data-testid="dissolved-card">
      <CardHeading eyebrow={v("refundEyebrow")} title={v("refundTitle")} />
      <p className="text-xs leading-relaxed text-fg-2">{v("refundExplanation")}</p>
      {!address ? (
        <ConnectPrompt text={v("connectToRefund")} />
      ) : !p ? (
        <div className="skeleton h-16 rounded-[10px]" />
      ) : records.length ? (
        <>
          <Fig label={v("refundTotal")} value={n.quote(total)} unit={r.quote.symbol} tone="protected" size="lg" />
          <ul className="divide-y divide-hairline border-y border-hairline">
            {records.map((x) => (
              <li key={x.id} className="flex items-center justify-between gap-3 py-3">
                <div className="min-w-0">
                  <p className="text-xs text-fg-2">
                    #{x.id} · {v(`class${x.positionState.class}`)}
                  </p>
                  <p className="num text-sm font-medium">
                    {n.quote(x.guaranteedClaim.amount)} <span className="text-xs text-fg-3">{r.quote.symbol}</span>
                  </p>
                </div>
                <ActionButton
                  size="sm"
                  data-testid={`refund-${x.id}`}
                  label={v("claimRefund")}
                  pending={pending}
                  onClick={() =>
                    send(
                      {
                        address: r.modules.claims as Address,
                        abi: claimsAbi,
                        functionName: "claim",
                        args: [BigInt(x.id)],
                      },
                      {
                        label: v("claimRefund"),
                        preview: [
                          [v("position"), `#${x.id} · ${v(`class${x.positionState.class}`)}`],
                          [v("payout"), `${n.quote(x.guaranteedClaim.amount)} ${r.quote.symbol}`, "total"],
                        ],
                        invalidate: raiseInvalidations(r.address, address),
                      },
                    )
                  }
                />
              </li>
            ))}
          </ul>
          <RolloverOut detail={r} claims={records.map((x) => ({ id: x.id, amount: x.guaranteedClaim.amount }))} />
        </>
      ) : (
        <p className="text-sm text-fg-2">{v("noRefund")}</p>
      )}
    </div>
  );
}

export function TerminalActions({ detail: r, position: p }: { detail: RaiseDetail; position?: Position }) {
  const v = useTranslations("v31"),
    n = useNumbers();
  const { address } = useAccount();
  const { send, pending } = useTx();
  const builder = address && [r.builder, ...r.config.builders].some((x) => x.toLowerCase() === address.toLowerCase());
  const rewardTokens = BigInt(p?.pendingRewards.tokens ?? 0n),
    rewardQuote = BigInt(p?.pendingRewards.quote ?? 0n);
  const rows: Row[] = [
    [v("rewardTokens"), `${n.token(rewardTokens)} ${r.symbol}`],
    [v("rewardQuote"), `${n.quote(rewardQuote)} ${r.quote.symbol}`],
    [v("quota"), `${n.token(p?.quota ?? 0n)} ${r.symbol}`, "meta"],
  ];
  const call = (abi: Abi, target: string, functionName: string, label: string, args: unknown[] = [], preview = rows) =>
    send(
      { address: target as Address, abi, functionName, args },
      { label: v(label), preview, invalidate: raiseInvalidations(r.address, address) },
    );
  return (
    <div className="space-y-5" data-testid="rewards-card">
      <CardHeading eyebrow={v("rewardsEyebrow")} title={v("rewardsTitle")} />
      {!address ? (
        <ConnectPrompt text={v("connectToRewards")} />
      ) : (
        <>
          <dl className="grid grid-cols-2 gap-4">
            <Fig label={v("rewardTokens")} value={n.token(rewardTokens)} unit={r.symbol} />
            <Fig label={v("rewardQuote")} value={n.quote(rewardQuote)} unit={r.quote.symbol} />
            <Fig className="col-span-2" label={v("quota")} value={n.token(p?.quota ?? 0n)} unit={r.symbol} size="sm" />
          </dl>
          <div className="space-y-2">
            <ActionButton
              className="w-full"
              data-testid="claim-rewards"
              label={v("claimRewards")}
              reason={rewardTokens + rewardQuote === 0n ? v("noRewards") : null}
              pending={pending}
              onClick={() => call(tokenAbi, r.token, "claimRewards", "claimRewards")}
            />
            <ActionButton
              className="w-full"
              variant="outline"
              label={v("checkpoint")}
              pending={pending}
              onClick={() => call(tokenAbi, r.token, "checkpoint", "checkpoint", [address])}
            />
          </div>
        </>
      )}
      <p className="text-2xs leading-relaxed text-fg-3">{v("rewardsBoundary")}</p>
      {builder ? (
        <div className="space-y-3 border-t border-hairline pt-4">
          <CardHeading eyebrow={v("vestingEyebrow")} />
          <Fig label={v("vestingClaimable")} value={n.token(p?.vesting.claimable ?? 0n)} unit={r.symbol} size="sm" />
          <ActionButton
            className="w-full"
            variant="outline"
            label={v("claimVesting")}
            reason={BigInt(p?.vesting.claimable ?? 0n) === 0n ? v("noVesting") : null}
            pending={pending}
            onClick={() =>
              call(
                vestingAbi,
                r.modules.vesting,
                "claim",
                "claimVesting",
                [address],
                [[v("claimVesting"), `${n.token(p?.vesting.claimable ?? 0n)} ${r.symbol}`, "total"]],
              )
            }
          />
        </div>
      ) : null}
    </div>
  );
}
