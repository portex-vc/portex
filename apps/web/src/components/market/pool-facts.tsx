"use client";

import { explorerUrl } from "@/lib/chains";
import type { CandlesResponse, MarketRow } from "@/lib/market";
import { shortAddress } from "@/lib/utils";
import { ArrowUpRight, Check, Copy } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { useState } from "react";
import { useMarketFormat } from "./markets-table";

/** The facts of the Portex pool: fee, the permanently locked listing liquidity, where fees go, and its identity. */
export function PoolFacts({
  market: m,
  poolManager,
  listing,
  quoteSymbol,
}: {
  market: MarketRow;
  poolManager: string | null;
  listing: CandlesResponse["listing"] | undefined;
  quoteSymbol: string;
}) {
  const t = useTranslations("markets.pool");
  const f = useMarketFormat();
  const format = useFormatter();
  const [copied, setCopied] = useState(false);
  const rows: [string, React.ReactNode][] = [
    [t("fee"), t("feeValue")],
    [t("principal"), t("principalValue")],
    [t("lpFees"), t("lpFeesValue")],
    [
      t("reserves"),
      <span key="reserves" className="num">
        {f.usd(m.reserves.quote)} {quoteSymbol}
        <span className="text-fg-3"> · </span>
        {format.number(Number(m.reserves.token), { maximumFractionDigits: 0 })} {m.symbol}
      </span>,
    ],
  ];
  return (
    <section className="surface-1 p-5 sm:p-6" data-testid="pool-facts">
      <h2 className="micro mb-4">{t("title")}</h2>
      <dl className="grid gap-x-8 gap-y-4 text-sm sm:grid-cols-2 xl:grid-cols-3">
        {rows.map(([label, value]) => (
          <div key={label} className="flex flex-col gap-0.5">
            <dt className="text-xs text-fg-3">{label}</dt>
            <dd className="text-fg-2">{value}</dd>
          </div>
        ))}
        {m.poolId ? (
          <div className="flex flex-col gap-1">
            <dt className="text-xs text-fg-3">{t("poolId")}</dt>
            <dd className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <button
                type="button"
                data-testid="pool-id"
                title={m.poolId}
                className="inline-flex items-center gap-1.5 font-mono text-xs text-fg-2 hover:text-fg"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(m.poolId!);
                    setCopied(true);
                    window.setTimeout(() => setCopied(false), 1200);
                  } catch {
                    setCopied(false);
                  }
                }}
              >
                {shortAddress(m.poolId, 6)}
                {copied ? <Check className="size-3" aria-hidden /> : <Copy className="size-3" aria-hidden />}
              </button>
              {explorerUrl && poolManager ? (
                <a
                  href={`${explorerUrl}/address/${poolManager}`}
                  target="_blank"
                  rel="noreferrer"
                  data-testid="pool-explorer"
                  className="inline-flex items-center gap-1 text-xs text-fg-2 hover:text-fg"
                >
                  {t("manager")}
                  <ArrowUpRight className="size-3" aria-hidden />
                </a>
              ) : null}
            </dd>
          </div>
        ) : null}
        {listing ? (
          <div className="flex flex-col gap-0.5">
            <dt className="text-xs text-fg-3">{t("listing")}</dt>
            <dd className="num text-fg-2">
              {explorerUrl ? (
                <a
                  href={`${explorerUrl}/tx/${listing.txHash}`}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 hover:text-fg"
                >
                  {format.dateTime(new Date(listing.time * 1000), {
                    month: "short",
                    day: "numeric",
                    year: "numeric",
                    hour: "2-digit",
                    minute: "2-digit",
                    timeZone: "UTC",
                  })}
                  <ArrowUpRight className="size-3" aria-hidden />
                </a>
              ) : (
                format.dateTime(new Date(listing.time * 1000), {
                  month: "short",
                  day: "numeric",
                  year: "numeric",
                  hour: "2-digit",
                  minute: "2-digit",
                  timeZone: "UTC",
                })
              )}
              <span className="text-fg-3">
                {" · "}
                {t("listingPrice", { price: f.price(listing.price), unit: quoteSymbol })}
              </span>
            </dd>
          </div>
        ) : null}
      </dl>
      {!explorerUrl ? <p className="mt-4 text-2xs text-fg-3">{t("localChain")}</p> : null}
    </section>
  );
}
