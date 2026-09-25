"use client";

import { ActionButton } from "@/components/action-button";
import { AmountInput } from "@/components/amount-input";
import { CardHeading, QuoteTable, Segmented, type Row } from "@/components/figures";
import { TestUsdgFaucet } from "@/components/test-usdg-faucet";
import { Button } from "@/components/ui/button";
import { erc20Abi } from "@/lib/contracts";
import { displayAmountInput, normalizeAmountEdit } from "@/lib/amount-input";
import { queryKeys, useAllowance, useNow, usePosition, useTx } from "@/lib/hooks";
import {
  executionPrice,
  marketKeys,
  minimumReceived,
  parseSlippage,
  priceImpactBps,
  scaled,
  swapRouterAbi,
  type MarketRow,
} from "@/lib/market";
import { parseTradeAmount } from "@/lib/trade-amount";
import { useNumbers } from "@/lib/use-numbers";
import { cn } from "@/lib/utils";
import { walletSheet } from "@/lib/wallet-sheet";
import { useQuery } from "@tanstack/react-query";
import { Info, RefreshCw, Wallet } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import type { Address } from "viem";
import { useAccount, usePublicClient } from "wagmi";

const SLIPPAGE_PRESETS = ["0.5", "1", "2"];
/** Above this the review shows the impact as a warning. */
const HIGH_IMPACT_BPS = 500;

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return debounced;
}

/**
 * Exact-input swaps through the Portex router: live quote from `quoteExactIn` (simulated), price impact against the
 * pool price, minimum received under the slippage bound, then approve and swap through the transaction drawer.
 */
export function SwapPanel({
  market: m,
  router,
  quote: quoteAddress,
  quoteSymbol,
}: {
  market: MarketRow;
  router: `0x${string}` | null;
  quote: string | null;
  quoteSymbol: string;
}) {
  const t = useTranslations("markets.swap");
  const v = useTranslations("v31");
  const n = useNumbers();
  const locale = useLocale();
  const now = useNow();
  const { address } = useAccount();
  const client = usePublicClient();
  const { send, pending } = useTx();
  const { data: position } = usePosition(m.address, address);
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [amount, setAmount] = useState("");
  const [slippage, setSlippage] = useState("1");
  const buy = side === "buy";
  const parsed = parseTradeAmount(amount, buy);
  const debounced = useDebounced(parsed, 250);
  const inputAsset = (buy ? quoteAddress : m.token) as Address | null;
  const balance = BigInt((buy ? position?.walletQuoteBalance : position?.walletTokenBalance) ?? 0);
  const bps = parseSlippage(slippage);
  const quote = useQuery({
    queryKey: [...marketKeys.market(m.address), "quote", side, debounced.toString(), router],
    queryFn: async () => {
      const { result } = await client!.simulateContract({
        address: router!,
        abi: swapRouterAbi,
        functionName: "quoteExactIn",
        args: [m.token as Address, buy, debounced],
      });
      return result as bigint;
    },
    enabled: Boolean(router && client && debounced > 0n),
    refetchInterval: 10_000,
    retry: false,
  });
  const out = debounced === parsed && parsed > 0n ? quote.data : undefined;
  const allowance = useAllowance(inputAsset ?? undefined, address, router ?? undefined, parsed);
  const priceE18 = scaled(m.price);
  const impact = out !== undefined ? priceImpactBps(buy, parsed, out, priceE18) : null;
  const min = out !== undefined && bps !== null ? minimumReceived(out, bps) : 0n;
  const usd = (x: bigint | string) => `${n.quote(x)} ${quoteSymbol}`;
  const tok = (x: bigint | string) => `${n.token(x)} ${m.symbol}`;
  const rows: Row[] = [];
  if (out !== undefined && out > 0n) {
    rows.push(
      [t("price"), `${n.price(executionPrice(buy, parsed, out))} ${quoteSymbol}`],
      [
        t("priceImpact"),
        impact === null ? "—" : n.pct(impact),
        impact !== null && impact >= HIGH_IMPACT_BPS ? "risk" : undefined,
      ],
      [t("poolFee"), buy ? usd(parsed / 100n) : tok(parsed / 100n)],
      [t("receive"), buy ? tok(out) : usd(out), "total"],
      [t("minimumReceived"), buy ? tok(min) : usd(min)],
      [t("slippage"), bps === null ? "—" : n.pct(bps), "meta"],
      [t("route"), t("routeValue"), "meta"],
    );
  }
  const quota = BigInt(position?.quota ?? 0);
  const reason = !router
    ? t("disabled")
    : parsed <= 0n
      ? v("enterAmount")
      : parsed > balance
        ? v("exceedsBalance")
        : bps === null
          ? t("slippageError")
          : quote.isError
            ? t("quoteError")
            : out === 0n
              ? t("tooSmall")
              : null;
  const label = allowance.needsApproval
    ? t("approve", { symbol: buy ? quoteSymbol : m.symbol })
    : t(side, { symbol: m.symbol });
  const invalidate = [
    ["markets"],
    queryKeys.position(m.address, address),
    queryKeys.raise(m.address),
    ["readContract"],
  ] as const;

  async function submit() {
    if (reason || out === undefined || !router || !address || !inputAsset) return;
    if (allowance.needsApproval) {
      await send(
        { address: inputAsset, abi: erc20Abi, functionName: "approve", args: [router, parsed] },
        {
          label,
          preview: [
            [t("approveSpender"), t("routerName")],
            [v("approveAmount"), buy ? usd(parsed) : tok(parsed), "total"],
          ],
          onSuccess: async () => {
            await allowance.refetch();
          },
        },
      );
      return;
    }
    const deadline = BigInt(Math.max(now, Math.floor(Date.now() / 1000)) + 600);
    await send(
      {
        address: router,
        abi: swapRouterAbi,
        functionName: "swapExactIn",
        args: [m.token, buy, parsed, min, address, deadline],
      },
      {
        label,
        preview: [[t("pay"), buy ? usd(parsed) : tok(parsed)], ...rows],
        invalidate,
        onSuccess: () => setAmount(""),
      },
    );
  }

  return (
    <section className="surface-1 space-y-5 p-5 shadow-[var(--overlay-shadow)] sm:p-6" data-testid="swap-panel">
      <div className="flex items-center justify-between gap-3">
        <h2 className="micro">{t("title")}</h2>
        <span className="text-2xs text-fg-3">{t("routeValue")}</span>
      </div>
      <Segmented
        label={t("title")}
        value={side}
        options={[
          { value: "buy" as const, label: t("buyTab") },
          { value: "sell" as const, label: t("sellTab") },
        ]}
        testId={(x) => `swap-side-${x}`}
        onChange={(x) => {
          setSide(x);
          setAmount("");
        }}
      />
      {buy && address && position?.walletQuoteBalance === "0" ? (
        <TestUsdgFaucet quoteAddress={quoteAddress ?? undefined} />
      ) : null}
      <div className="space-y-1.5">
        <label htmlFor="swap-amount" className="eyebrow block">
          {t("pay")}
        </label>
        <AmountInput
          id="swap-amount"
          value={amount}
          onChange={setAmount}
          symbol={buy ? quoteSymbol : m.symbol}
          balance={address ? balance : undefined}
          balanceDecimals={address ? (buy ? 6 : 18) : undefined}
          balanceLabel={v("walletBalance")}
          maxTestId="swap-max"
          disabled={!router}
        />
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs text-fg-2">{t("slippage")}</span>
        <span className="flex items-center gap-1" role="group" aria-label={t("slippage")}>
          {SLIPPAGE_PRESETS.map((p) => (
            <button
              key={p}
              type="button"
              aria-pressed={slippage === p}
              onClick={() => setSlippage(p)}
              className={cn(
                "num h-7 rounded-[8px] px-2 text-xs transition-colors",
                slippage === p ? "bg-fg/[0.1] text-fg" : "text-fg-3 hover:bg-fg/[0.05] hover:text-fg-2",
              )}
            >
              {displayAmountInput(p, locale)}%
            </button>
          ))}
          <input
            aria-label={t("slippageCustom")}
            data-testid="slippage"
            inputMode="decimal"
            className={cn(
              "num h-7 w-14 rounded-[8px] border bg-transparent px-2 text-right text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
              bps === null ? "border-negative" : "border-fg/[0.1]",
            )}
            value={displayAmountInput(slippage, locale)}
            onChange={(e) => setSlippage(normalizeAmountEdit(e.target.value, locale))}
          />
          <span className="text-xs text-fg-3">%</span>
        </span>
      </div>
      <section className="rounded-[12px] border border-fg/[0.07] bg-fg/[0.02] px-4 py-3" aria-live="polite">
        <CardHeading
          eyebrow={v("quote")}
          aside={
            <button
              type="button"
              onClick={() => quote.refetch()}
              disabled={parsed <= 0n || quote.isFetching || !router}
              className="inline-flex items-center gap-1 text-2xs text-fg-2 transition-colors hover:text-fg disabled:opacity-40"
            >
              <RefreshCw className={cn("size-3", quote.isFetching && "animate-spin")} aria-hidden />
              {v("refreshQuote")}
            </button>
          }
          className="mb-2"
        />
        <QuoteTable rows={rows} testId="swap-quote" empty={router ? t("prompt") : t("disabled")} />
      </section>
      {!buy && quota > 0n ? (
        <p className="flex gap-2 text-xs leading-relaxed text-fg-2" data-testid="quota-note">
          <Info className="mt-0.5 size-3.5 shrink-0 text-fg-3" aria-hidden />
          {t("quotaNote", { quota: n.token(quota), symbol: m.symbol })}
        </p>
      ) : null}
      {!address ? (
        <Button size="lg" className="w-full" data-testid="swap-connect" onClick={walletSheet.open} disabled={!router}>
          <Wallet /> {v("connectCta")}
        </Button>
      ) : (
        <ActionButton
          className="w-full"
          data-testid="swap-submit"
          label={label}
          reason={reason}
          pending={pending || (parsed > 0n && out === undefined && !quote.isError) || allowance.isLoading}
          onClick={submit}
        />
      )}
      <p className="text-2xs leading-relaxed text-fg-3">{t("footnote")}</p>
    </section>
  );
}
