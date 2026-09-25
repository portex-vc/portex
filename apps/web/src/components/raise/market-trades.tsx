"use client";

import { Mark } from "@/components/brand/logo";
import type { RaiseDetail } from "@/lib/api";
import { useTrades } from "@/lib/hooks";
import { useNumbers } from "@/lib/use-numbers";
import { cn, shortAddress } from "@/lib/utils";
import { useTranslations } from "next-intl";

const TONE: Record<string, [string, string]> = {
  deposit: ["text-fg-2", "bg-fg-3"],
  buy: ["text-positive", "bg-positive"],
  sell: ["text-negative", "bg-negative"],
  costExit: ["text-protected", "bg-protected"],
  protectedExit: ["text-protected", "bg-protected"],
};

/** Average price of a record without an event price: quote (6 dp) per token (18 dp), 1e18-scaled. */
function unitPrice(quote: string, tokens: string) {
  return BigInt(tokens) > 0n ? (BigInt(quote) * 10n ** 30n) / BigInt(tokens) : null;
}

export function TradesTable({ detail }: { detail: RaiseDetail }) {
  const t = useTranslations("market");
  const n = useNumbers();
  const v = useTranslations("v31");
  const { data: trades, isLoading } = useTrades(detail.address);
  if (isLoading) {
    return (
      <div className="space-y-2.5 pt-1" aria-busy>
        <div className="skeleton h-4 w-full rounded-[6px] opacity-60" />
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="skeleton h-7 w-full rounded-[6px]" />
        ))}
      </div>
    );
  }
  if (!trades || trades.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 py-6 text-center">
        <Mark size={24} />
        <p className="text-sm text-fg-2">{t("noTrades")}</p>
        <a href="#action-rail" className="link text-xs">
          {t("action")}
        </a>
      </div>
    );
  }
  return (
    <div className="scroll-thin -mx-1 max-h-80 overflow-auto px-1">
      <table className="w-full text-xs sm:min-w-[34rem]">
        <thead className="sticky top-0 bg-surface-1 text-left text-xs text-fg-3">
          <tr>
            <th className="py-2 pr-3 font-normal">{t("side")}</th>
            <th className="hidden py-2 pr-3 font-normal sm:table-cell">{t("trader")}</th>
            <th className="py-2 pr-3 text-right font-normal">{detail.quote.symbol}</th>
            <th className="hidden py-2 pr-3 text-right font-normal sm:table-cell">{detail.symbol}</th>
            <th className="py-2 pr-3 text-right font-normal">{t("price")}</th>
            <th className="py-2 text-right font-normal">{t("time")}</th>
          </tr>
        </thead>
        <tbody>
          {trades.slice(0, 50).map((tr) => (
            <tr
              key={`${tr.txHash}-${tr.logIndex}`}
              className="border-t border-fg/[0.06] transition-colors hover:bg-fg/[0.025]"
            >
              <td className="py-2.5 pr-3">
                <span
                  className={cn("inline-flex items-center gap-2 whitespace-nowrap font-medium", TONE[tr.type]?.[0])}
                >
                  <span aria-hidden className={cn("size-1.5 rounded-full", TONE[tr.type]?.[1])} />
                  {v(`trade.${tr.type}`)}
                </span>
              </td>
              <td className="hidden py-2.5 pr-3 font-mono text-fg-2 sm:table-cell">{shortAddress(tr.trader)}</td>
              <td className="num py-2.5 pr-3 text-right">{n.quote(tr.quote)}</td>
              <td className="num hidden py-2.5 pr-3 text-right sm:table-cell">{n.token(tr.tokens)}</td>
              <td className="num py-2.5 pr-3 text-right">{n.price(tr.price ?? unitPrice(tr.quote, tr.tokens))}</td>
              <td className="num whitespace-nowrap py-2.5 text-right text-fg-3">{n.date(tr.timestamp)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {trades.length > 8 ? (
        <div
          aria-hidden
          className="pointer-events-none sticky bottom-0 h-8 bg-gradient-to-t from-surface-1 to-transparent"
        />
      ) : null}
    </div>
  );
}
