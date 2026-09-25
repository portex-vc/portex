"use client";

import { CandleChart } from "@/components/market/candle-chart";
import { MarketHeader } from "@/components/market/market-header";
import { MarketPosition } from "@/components/market/market-position";
import { PoolFacts } from "@/components/market/pool-facts";
import { SwapPanel } from "@/components/market/swap-panel";
import { TradesTape } from "@/components/market/trades-tape";
import { DrawnMark } from "@/components/brand/logo";
import { NotFoundView } from "@/components/not-found-view";
import { ErrorState } from "@/components/states";
import { Button } from "@/components/ui/button";
import { defaultInterval, liveRouter, useCandles, useMarket, type Interval } from "@/lib/market";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";

const QUOTE_SYMBOL = "USDG";

/** The trading page of a graduated project: chart, swap, position, trades and pool facts. */
export default function MarketDetailPage() {
  const { address } = useParams<{ address: string }>();
  const t = useTranslations("markets.page");
  const { data, isLoading, isError, error, refetch } = useMarket(address);
  const [picked, setPicked] = useState<Interval | null>(null);
  const interval = picked ?? defaultInterval(data?.market.listedAt, data?.chainTime ?? 0);
  const candles = useCandles(address, interval);

  if (!data) {
    if (isError) {
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
      if (code === "RAISE_NOT_FOUND" || code === "INVALID_ADDRESS") return <NotFoundView kind="raise" />;
      if (code === "NOT_LISTED")
        return (
          <section
            className="mx-auto flex max-w-xl flex-col items-center gap-4 px-6 py-20 text-center"
            data-testid="market-not-listed"
          >
            <DrawnMark size={44} className="text-fg-2" />
            <h1 className="t-title">{t("notListedTitle")}</h1>
            <p className="max-w-sm text-sm leading-relaxed text-fg-2">{t("notListedBody")}</p>
            <div className="flex flex-wrap justify-center gap-2 pt-2">
              <Button asChild>
                <Link href={`/raise/${address}`}>{t("projectPage")}</Link>
              </Button>
              <Button asChild variant="outline">
                <Link href="/markets">{t("back")}</Link>
              </Button>
            </div>
          </section>
        );
      return <ErrorState error={error} retry={() => refetch()} />;
    }
    return isLoading ? <MarketSkeleton /> : null;
  }

  const m = data.market;
  const router = liveRouter(data.router);
  return (
    <div className="flex flex-col gap-10 pt-4 lg:pt-6" data-testid="market-page">
      <MarketHeader market={m} quoteSymbol={QUOTE_SYMBOL} />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_23rem] lg:grid-rows-[auto_auto_1fr] xl:gap-x-12">
        <section className="surface-1 min-w-0 p-5 sm:p-6 lg:col-start-1 lg:row-start-1">
          <CandleChart
            address={m.address}
            interval={interval}
            onInterval={setPicked}
            now={data.chainTime}
            quoteSymbol={QUOTE_SYMBOL}
          />
        </section>
        <aside
          aria-label={t("trade")}
          className="flex min-w-0 flex-col gap-4 self-start lg:sticky lg:top-24 lg:col-start-2 lg:row-span-3 lg:row-start-1"
        >
          <SwapPanel market={m} router={router} quote={data.quote} quoteSymbol={QUOTE_SYMBOL} />
          <MarketPosition market={m} quoteSymbol={QUOTE_SYMBOL} />
        </aside>
        <div className="min-w-0 lg:col-start-1 lg:row-start-2">
          <TradesTape address={m.address} symbol={m.symbol} quoteSymbol={QUOTE_SYMBOL} />
        </div>
        <div className="min-w-0 lg:col-start-1 lg:row-start-3">
          <PoolFacts
            market={m}
            poolManager={data.poolManager}
            listing={candles.data?.listing}
            quoteSymbol={QUOTE_SYMBOL}
          />
        </div>
      </div>
    </div>
  );
}

function MarketSkeleton() {
  return (
    <div className="flex flex-col gap-10 pt-4 lg:pt-6" aria-busy data-testid="market-loading">
      <div className="skeleton h-3 w-16" />
      <div className="flex items-center gap-4">
        <div className="skeleton size-14 rounded-[15px]" />
        <div className="flex flex-col gap-2.5">
          <div className="skeleton h-7 w-56" />
          <div className="skeleton h-3.5 w-40" />
        </div>
      </div>
      <div className="flex gap-10">
        <div className="skeleton h-12 w-64" />
        <div className="skeleton hidden h-12 w-40 md:block" />
        <div className="skeleton hidden h-12 w-40 md:block" />
      </div>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_23rem] xl:gap-x-12">
        <div className="skeleton h-[28rem] rounded-[14px]" />
        <div className="skeleton h-[28rem] rounded-[14px]" />
      </div>
    </div>
  );
}
