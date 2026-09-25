"use client";

import { fillCandles, INTERVAL_SECONDS, INTERVALS, useCandles, type Bar, type Interval } from "@/lib/market";
import { cn } from "@/lib/utils";
import {
  CandlestickSeries,
  ColorType,
  createChart,
  createSeriesMarkers,
  HistogramSeries,
  LineStyle,
  TickMarkType,
  type IChartApi,
  type ISeriesApi,
  type MouseEventParams,
  type UTCTimestamp,
} from "lightweight-charts";
import { useFormatter, useLocale, useTranslations } from "next-intl";
import { useTheme } from "next-themes";
import { useEffect, useMemo, useRef, useState } from "react";

/** Theme token as an rgba() string lightweight-charts can parse. */
function token(name: string, alpha = 1) {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(`--${name}`).trim() || "128 128 128";
  const [r, g, b] = raw.split(/\s+/).map(Number);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/**
 * Candlesticks of the project's whole market life: the Stage 2 book (muted) up to the listing marker, then the
 * Uniswap v4 pool. Monochrome: up candles solid foreground, down candles hollow. Volume sits under the price.
 */
export function CandleChart({
  address,
  interval,
  onInterval,
  now,
  quoteSymbol,
}: {
  address: string;
  interval: Interval;
  onInterval: (interval: Interval) => void;
  now: number;
  quoteSymbol: string;
}) {
  const t = useTranslations("markets.chart");
  const locale = useLocale();
  const format = useFormatter();
  const { resolvedTheme } = useTheme();
  const { data, isLoading } = useCandles(address, interval);
  const host = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<Bar | null>(null);
  const seconds = INTERVAL_SECONDS[interval];
  const bars = useMemo(() => fillCandles(data?.candles ?? [], seconds, now), [data, seconds, now]);
  const poolTrades = (data?.candles ?? []).reduce((sum, c) => sum + (c.venue === "pool" ? c.trades : 0), 0);
  const listingTime = data?.listing ? Math.floor(data.listing.time / seconds) * seconds : null;
  const last = bars.at(-1) ?? null;
  const shown = hover ?? last;
  const price = (value: number) => format.number(Math.abs(value) < 1e-12 ? 0 : value, { maximumSignificantDigits: 6 });

  useEffect(() => {
    if (!host.current) return;
    const fg = token("fg");
    const muted = token("fg-3");
    const chart: IChartApi = createChart(host.current, {
      autoSize: true,
      localization: {
        locale,
        priceFormatter: price,
        timeFormatter: (time: number) =>
          new Intl.DateTimeFormat(locale, {
            month: "short",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit",
            timeZone: "UTC",
          }).format(new Date(time * 1000)),
      },
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: muted,
        fontFamily: getComputedStyle(document.body).fontFamily,
        fontSize: 11,
        attributionLogo: false,
      },
      grid: { vertLines: { visible: false }, horzLines: { color: token("fg", 0.05) } },
      rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.08, bottom: 0.24 } },
      timeScale: {
        borderVisible: false,
        timeVisible: seconds < 86400,
        rightOffset: 4,
        minBarSpacing: 2,
        tickMarkFormatter: (time: number, type: TickMarkType) =>
          new Intl.DateTimeFormat(
            locale,
            type === TickMarkType.Time || type === TickMarkType.TimeWithSeconds
              ? { hour: "2-digit", minute: "2-digit", timeZone: "UTC" }
              : { month: "short", day: "numeric", timeZone: "UTC" },
          ).format(new Date(time * 1000)),
      },
      crosshair: {
        vertLine: {
          color: token("fg", 0.2),
          width: 1,
          style: LineStyle.Solid,
          labelBackgroundColor: token("surface-3"),
        },
        horzLine: { color: token("fg", 0.14), labelBackgroundColor: token("surface-3") },
      },
    });
    const candle = (up: string, down: string) => ({
      upColor: up,
      downColor: "rgba(0, 0, 0, 0)",
      borderUpColor: up,
      borderDownColor: down,
      wickUpColor: up,
      wickDownColor: down,
      borderVisible: true,
      priceLineVisible: false,
      lastValueVisible: false,
    });
    const stage2: ISeriesApi<"Candlestick"> = chart.addSeries(CandlestickSeries, candle(muted, muted));
    const pool: ISeriesApi<"Candlestick"> = chart.addSeries(CandlestickSeries, {
      ...candle(fg, token("fg", 0.62)),
      lastValueVisible: true,
      priceLineVisible: true,
      priceLineColor: token("fg", 0.35),
      priceLineStyle: LineStyle.Dotted,
    });
    const volume = chart.addSeries(HistogramSeries, {
      priceScaleId: "volume",
      priceFormat: { type: "volume" },
      lastValueVisible: false,
      priceLineVisible: false,
    });
    chart.priceScale("volume").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 }, visible: false });
    const ohlc = (b: Bar) => ({ time: b.time as UTCTimestamp, open: b.open, high: b.high, low: b.low, close: b.close });
    stage2.setData(bars.filter((b) => b.venue === "stage2").map(ohlc));
    pool.setData(bars.filter((b) => b.venue === "pool").map(ohlc));
    // One volume column per time: the listing bucket may hold a Stage 2 and a pool candle.
    const byTime = new Map<number, Bar & { total: number }>();
    for (const b of bars) {
      const prior = byTime.get(b.time);
      byTime.set(b.time, { ...b, total: (prior?.total ?? 0) + b.volume });
    }
    volume.setData(
      [...byTime.values()].map((b) => ({
        time: b.time as UTCTimestamp,
        value: b.total,
        color: b.close >= b.open ? token("fg", b.venue === "pool" ? 0.26 : 0.14) : token("fg", 0.1),
      })),
    );
    if (listingTime !== null)
      createSeriesMarkers(pool, [
        { time: listingTime as UTCTimestamp, position: "aboveBar", shape: "arrowDown", color: fg, text: t("listed") },
      ]);
    const byBar = new Map(bars.map((b) => [b.time, b]));
    const move = (param: MouseEventParams) => {
      const time = typeof param.time === "number" ? param.time : null;
      const pooled = time === null ? null : bars.find((b) => b.time === time && b.venue === "pool");
      setHover(time === null ? null : (pooled ?? byBar.get(time) ?? null));
    };
    chart.subscribeCrosshairMove(move);
    // About six pixels per bar: phones show the recent weeks, desktops more history; scroll for the rest.
    const visible = Math.min(bars.length, Math.max(30, Math.floor((host.current.clientWidth || 600) / 6)));
    if (bars.length > visible)
      chart.timeScale().setVisibleLogicalRange({ from: bars.length - visible, to: bars.length + 3 });
    else chart.timeScale().fitContent();
    return () => {
      chart.unsubscribeCrosshairMove(move);
      chart.remove();
    };
    // `price` depends only on the locale formatter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bars, listingTime, seconds, locale, resolvedTheme, t]);

  const change = shown ? (shown.open > 0 ? ((shown.close - shown.open) / shown.open) * 10000 : 0) : null;
  return (
    <div className="flex flex-col gap-4" data-testid="market-chart">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div role="group" aria-label={t("interval")} className="flex gap-0.5 rounded-[10px] bg-fg/[0.05] p-[3px]">
          {INTERVALS.map((i) => (
            <button
              key={i}
              type="button"
              aria-pressed={i === interval}
              data-testid={`interval-${i}`}
              onClick={() => onInterval(i)}
              className={cn(
                "num min-h-7 rounded-[7px] px-2.5 text-xs font-medium transition-colors duration-150",
                i === interval
                  ? "bg-surface-1 text-fg shadow-[0_1px_2px_rgb(0_0_0/0.12)] ring-1 ring-fg/[0.08]"
                  : "text-fg-3 hover:text-fg-2",
              )}
            >
              {i}
            </button>
          ))}
        </div>
        {shown ? (
          <dl className="num flex flex-wrap gap-x-3 gap-y-1 text-xs text-fg-3" data-testid="chart-legend">
            {(
              [
                ["open", shown.open],
                ["high", shown.high],
                ["low", shown.low],
                ["close", shown.close],
              ] as const
            ).map(([k, value]) => (
              <div key={k} className="flex gap-1">
                <dt>{t(k)}</dt>
                <dd className="text-fg-2">{price(value)}</dd>
              </div>
            ))}
            <div className="flex gap-1">
              <dt>{t("volume")}</dt>
              <dd className="text-fg-2">
                {format.number(shown.volume, { maximumFractionDigits: shown.volume >= 1000 ? 0 : 2 })} {quoteSymbol}
              </dd>
            </div>
            {change !== null && !shown.filled ? (
              <dd className={cn(change >= 0 ? "text-fg" : "text-fg-2")}>
                {format.number(change / 10000, { style: "percent", maximumFractionDigits: 2, signDisplay: "always" })}
              </dd>
            ) : null}
          </dl>
        ) : null}
      </div>
      <div className="relative">
        <div
          ref={host}
          className="h-72 w-full sm:h-[23rem]"
          data-testid="candles"
          data-bars={bars.length}
          data-trades={poolTrades}
        />
        {isLoading && !data ? <div className="skeleton absolute inset-0 rounded-[10px]" aria-hidden /> : null}
        {data && bars.length === 0 ? (
          <p className="absolute inset-0 flex items-center justify-center text-center text-xs text-fg-3">
            {t("empty")}
          </p>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-fg/[0.07] pt-3.5 text-xs text-fg-2">
        <span className="inline-flex items-center gap-2">
          <span aria-hidden className="inline-block h-3 w-1.5 rounded-[1px] bg-fg-3" />
          {t("stage2")}
        </span>
        <span className="inline-flex items-center gap-2">
          <span aria-hidden className="inline-block h-3 w-1.5 rounded-[1px] bg-fg" />
          {t("pool")}
        </span>
        <span className="inline-flex items-center gap-2">
          <span aria-hidden className="inline-block h-3 w-1.5 rounded-[1px] border border-fg/60" />
          {t("down")}
        </span>
        {data?.listing ? (
          <span className="inline-flex items-center gap-2">
            <span aria-hidden className="text-[0.625rem] leading-none text-fg">
              ▼
            </span>
            {t("listingAt", { price: price(Number(data.listing.price)), unit: quoteSymbol })}
          </span>
        ) : null}
        <span className="ml-auto text-fg-3">{t("utc")}</span>
      </div>
    </div>
  );
}
