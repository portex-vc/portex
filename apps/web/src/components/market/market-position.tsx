"use client";

import { ConnectPrompt } from "@/components/shell/wallet";
import { useConnectedAddress, usePosition } from "@/lib/hooks";
import { scaled, type MarketRow } from "@/lib/market";
import { useNumbers } from "@/lib/use-numbers";
import { useTranslations } from "next-intl";

/** The connected wallet in this market: token balance, its value at the pool price, reward quota and USDG. */
export function MarketPosition({ market: m, quoteSymbol }: { market: MarketRow; quoteSymbol: string }) {
  const t = useTranslations("markets.position");
  const n = useNumbers();
  const address = useConnectedAddress();
  const { data: p, isLoading } = usePosition(m.address, address);
  if (!address) {
    return (
      <section className="surface-1 p-5 sm:p-6" data-testid="market-position">
        <h2 className="micro mb-3">{t("title")}</h2>
        <ConnectPrompt text={t("connect")} />
      </section>
    );
  }
  const tokens = BigInt(p?.walletTokenBalance ?? 0);
  const value = (tokens * scaled(m.price)) / 10n ** 30n;
  const quota = BigInt(p?.quota ?? 0);
  const rows: [string, string, string, string?][] = [
    [t("balance"), n.token(tokens), m.symbol, "position-balance"],
    [t("value"), n.quote(value), quoteSymbol, "position-value"],
    ...(quota > 0n ? ([[t("quota"), n.token(quota), m.symbol]] as [string, string, string][]) : []),
    [t("cash"), n.quote(p?.walletQuoteBalance ?? "0"), quoteSymbol],
  ];
  return (
    <section className="surface-1 p-5 sm:p-6" data-testid="market-position">
      <h2 className="micro mb-4">{t("title")}</h2>
      <dl className="space-y-3 text-sm">
        {rows.map(([label, figure, unit, testId]) => (
          <div key={label} className="flex items-baseline justify-between gap-4">
            <dt className="text-fg-2">{label}</dt>
            <dd className="num text-right" data-testid={testId}>
              {isLoading ? <span className="skeleton inline-block h-4 w-20 align-middle" /> : figure}
              <span className="ml-1.5 text-xs text-fg-3">{unit}</span>
            </dd>
          </div>
        ))}
      </dl>
      {quota > 0n ? <p className="mt-4 text-xs leading-relaxed text-fg-3">{t("quotaHint")}</p> : null}
    </section>
  );
}
