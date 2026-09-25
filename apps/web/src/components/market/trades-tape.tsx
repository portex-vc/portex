"use client";

import { Mark } from "@/components/brand/logo";
import { explorerUrl } from "@/lib/chains";
import { usePoolTrades } from "@/lib/market";
import { cn, shortAddress } from "@/lib/utils";
import { ArrowUpRight } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { useAccount } from "wagmi";

/** Recent pool trades, newest first: time, side, fill price, size, total and trader. */
export function TradesTape({ address, symbol, quoteSymbol }: { address: string; symbol: string; quoteSymbol: string }) {
  const t = useTranslations("markets.tape");
  const format = useFormatter();
  const { address: user } = useAccount();
  const { data: trades, isLoading } = usePoolTrades(address);
  const num = (value: string, digits: number) =>
    format.number(Number(value), { maximumFractionDigits: digits, minimumFractionDigits: Math.min(digits, 2) });
  return (
    <section className="surface-1 p-5 sm:p-6" data-testid="trades-tape">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-medium">{t("title")}</h2>
        <span className="text-2xs text-fg-3">{t("utc")}</span>
      </div>
      {isLoading ? (
        <div className="space-y-2" aria-busy>
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="skeleton h-8 w-full" />
          ))}
        </div>
      ) : !trades?.length ? (
        <div className="flex flex-col items-center gap-2 py-8 text-center" data-testid="tape-empty">
          <Mark size={24} className="text-fg-3" />
          <p className="text-sm text-fg-2">{t("empty")}</p>
        </div>
      ) : (
        <div className="scroll-thin -mx-1 max-h-[26rem] overflow-auto px-1">
          <table className="w-full text-xs">
            <thead className="sticky top-0 z-[1] bg-surface-1 text-left text-fg-3">
              <tr>
                <th className="py-2 pr-3 font-normal">{t("time")}</th>
                <th className="py-2 pr-3 font-normal">{t("side")}</th>
                <th className="py-2 pr-3 text-right font-normal">{t("price")}</th>
                <th className="py-2 pr-3 text-right font-normal">{symbol}</th>
                <th className="hidden py-2 pr-3 text-right font-normal sm:table-cell">{quoteSymbol}</th>
                <th className="hidden py-2 text-right font-normal md:table-cell">{t("trader")}</th>
              </tr>
            </thead>
            <tbody>
              {trades.map((tr) => {
                const mine = user && tr.trader.toLowerCase() === user.toLowerCase();
                return (
                  <tr
                    key={`${tr.txHash}-${tr.logIndex}`}
                    data-testid="tape-row"
                    data-side={tr.side}
                    className="border-t border-fg/[0.06] transition-colors hover:bg-fg/[0.025]"
                  >
                    <td className="num whitespace-nowrap py-2.5 pr-3 text-fg-3">
                      {explorerUrl ? (
                        <a
                          href={`${explorerUrl}/tx/${tr.txHash}`}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1 hover:text-fg"
                        >
                          {format.dateTime(new Date(tr.time * 1000), {
                            month: "short",
                            day: "numeric",
                            hour: "2-digit",
                            minute: "2-digit",
                            timeZone: "UTC",
                          })}
                          <ArrowUpRight className="size-3" aria-hidden />
                        </a>
                      ) : (
                        format.dateTime(new Date(tr.time * 1000), {
                          month: "short",
                          day: "numeric",
                          hour: "2-digit",
                          minute: "2-digit",
                          timeZone: "UTC",
                        })
                      )}
                    </td>
                    <td className="py-2.5 pr-3">
                      <span
                        className={cn(
                          "inline-flex items-center gap-2 whitespace-nowrap font-medium",
                          tr.side === "buy" ? "text-positive" : "text-negative",
                        )}
                      >
                        <span
                          aria-hidden
                          className={cn("size-1.5 rounded-full", tr.side === "buy" ? "bg-positive" : "bg-negative")}
                        />
                        {t(tr.side)}
                      </span>
                    </td>
                    <td className="num py-2.5 pr-3 text-right">
                      {format.number(Number(tr.price), { maximumSignificantDigits: 6 })}
                    </td>
                    <td className="num py-2.5 pr-3 text-right">{num(tr.amountToken, 4)}</td>
                    <td className="num hidden py-2.5 pr-3 text-right sm:table-cell">{num(tr.amountQuote, 2)}</td>
                    <td className="hidden py-2.5 text-right md:table-cell">
                      {mine ? (
                        <span className="font-medium text-fg">{t("you")}</span>
                      ) : (
                        <span className="font-mono text-fg-2" title={tr.viaRouter ? tr.trader : t("otherRouter")}>
                          {shortAddress(tr.trader)}
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
