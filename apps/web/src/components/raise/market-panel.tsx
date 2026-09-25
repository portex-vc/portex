"use client";
import { TradesTable } from "./market-trades";
import { PriceChart } from "./market-panel-chart";
import type { RaiseDetail } from "@/lib/api";
import { useNumbers } from "@/lib/use-numbers";
import { useTranslations } from "next-intl";
import { shortAddress } from "@/lib/utils";
export function MarketPanel({ detail: r }: { detail: RaiseDetail }) {
  const v = useTranslations("v31"),
    tm = useTranslations("market"),
    n = useNumbers();
  return (
    <div className="space-y-5">
      <section className="surface-1 p-5 sm:p-6">
        <PriceChart detail={r} />
      </section>
      {r.phase === "Stage3" && r.listingRecord ? (
        <dl className="grid grid-cols-2 gap-x-6 gap-y-4 px-1 py-2 sm:grid-cols-4" data-testid="listing-record">
          {[
            [v("poolQuote"), `${n.quote(r.listingRecord.usedQuote)} ${r.quote.symbol}`],
            [v("poolTokens"), `${n.token(r.listingRecord.usedToken)} ${r.symbol}`],
            [v("poolPosition"), `#${shortId(r.listingRecord.positionId)}`],
            [v("poolOwner"), shortAddress(r.listingRecord.owner)],
          ].map(([label, value]) => (
            <div key={label}>
              <dt className="text-xs text-fg-3">{label}</dt>
              <dd className="num mt-1 break-all text-sm text-fg-2" title={value}>
                {value}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
      <section className="surface-1 p-5 sm:p-6">
        <h3 className="mb-3 text-sm font-medium">{tm("trades")}</h3>
        <TradesTable detail={r} />
      </section>
    </div>
  );
}

function shortId(id: string) {
  return id.length > 12 ? `${id.slice(0, 6)}…${id.slice(-4)}` : id;
}
