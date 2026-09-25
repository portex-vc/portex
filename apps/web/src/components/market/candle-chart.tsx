"use client";

import { fillCandles, INTERVAL_SECONDS, INTERVALS, useCandles, type Bar, type Interval } from "@/lib/market";
import { cn } from "@/lib/utils";
import {
  CandlestickSeries,
  ColorType,
  createChart,
  HistogramSeries,
  LineStyle,
  TickMarkType,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type MouseEventParams,
  type UTCTimestamp,
} from "lightweight-charts";
import { useFormatter, useLocale, useTranslations } from "next-intl";
import { useTheme } from "next-themes";
import { useEffect, useMemo, useRef, useState } from "react";
import { ListingMarker } from "./listing-marker";

/** Theme token as an rgba() string lightweight-charts can parse. */
function token(name: string, alpha = 1) {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(`--${name}`).trim() || "128 128 128";
  const [r, g, b] = raw.split(/\s+/).map(Number);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

interface ChartParts {
  chart: IChartApi;
  stage2: ISeriesApi<"Candlestick">;
  pool: ISeriesApi<"Candlestick">;
  volume: ISeriesApi<"Histogram">;
  marker: ListingMarker;
  listingLine: IPriceLine | null;
  up: (alpha?: number) => string;
  down: (alpha?: number) => string;
  idle: string;
  listing: string;
}

/**
 * Legend values have fixed widths so the legend never changes size while it updates. A price of at most 8
 * characters is at most 7 tabular digits (0.58em each in the UI face) plus a narrow separator: 4.4em holds it,
 * and 3.75em holds the 7-character phone form. Volume is at most "999,999" or a compact "1.23M".
 */
const PRICE_CHARS = 8;
const PHONE_PRICE_CHARS = 7;

/**
 * Candlesticks of the project's whole market life: the Stage 2 book (faded) up to the listing line, then the
 * Uniswap v4 pool. Up candles use the positive token (green), down candles the negative token (red); teal stays
 * reserved for protected principal. Volume sits under the price in the matching colour at low opacity.
 *
 * The chart is created once per locale and theme and fed new data in place, so refetches never reset the
 * user's scroll position. The header has a fixed geometry: the legend is one line of fixed-width fields, so
 * hovering or dragging the timeline can never change the card's height.
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
  const parts = useRef<ChartParts | null>(null);
  const lookup = useRef(new Map<number, Bar>());
  /** Bucket size the visible range was last framed for; a new interval frames the recent bars once. */
  const framed = useRef<number | null>(null);
  const [hover, setHover] = useState<Bar | null>(null);
  // The candles' own bucket size: while a newly picked interval loads, the previous candles stay as they were.
  const seconds = data?.seconds ?? INTERVAL_SECONDS[interval];
  const bars = useMemo(() => fillCandles(data?.candles ?? [], seconds, now), [data, seconds, now]);
  const poolTrades = (data?.candles ?? []).reduce((sum, c) => sum + (c.venue === "pool" ? c.trades : 0), 0);
  const listingTime = data?.listing ? Math.floor(data.listing.time / seconds) * seconds : null;
  const listingPrice = data?.listing ? Number(data.listing.price) : null;
  const last = bars.at(-1) ?? null;
  const shown = hover ?? last;
  const price = (value: number) => format.number(Math.abs(value) < 1e-12 ? 0 : value, { maximumSignificantDigits: 6 });
  /** A price that fits its fixed legend field: fewer significant digits, then scientific, before it would overflow. */
  const legendPrice = (value: number, chars: number) => {
    for (const digits of [6, 5, 4, 3]) {
      const text = price(Number(value.toPrecision(digits)));
      if (text.length <= chars) return text;
    }
    return format.number(value, { notation: "scientific", maximumFractionDigits: 2 });
  };
  const legendVolume = (value: number) =>
    format.number(
      value,
      value >= 1e6
        ? { notation: "compact", maximumFractionDigits: 2 }
        : { maximumFractionDigits: value >= 1000 ? 0 : 2 },
    );

  // Create the chart once per locale and theme.
  useEffect(() => {
    if (!host.current) return;
    const muted = token("fg-3");
    const up = (alpha = 1) => token("positive", alpha);
    const down = (alpha = 1) => token("negative", alpha);
    const fontFamily = getComputedStyle(document.body).fontFamily;
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
        fontFamily,
        fontSize: 11,
        attributionLogo: false,
      },
      grid: { vertLines: { visible: false }, horzLines: { color: token("fg", 0.05) } },
      // The top margin keeps the candles clear of the "Listed" pill.
      rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.11, bottom: 0.24 } },
      timeScale: {
        borderVisible: false,
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
    const candle = (rise: string, fall: string) => ({
      upColor: rise,
      downColor: fall,
      borderUpColor: rise,
      borderDownColor: fall,
      wickUpColor: rise,
      wickDownColor: fall,
      borderVisible: true,
      priceLineVisible: false,
      lastValueVisible: false,
    });
    // The Stage 2 book is the same market in its protected phase: the same colours, faded.
    const stage2 = chart.addSeries(CandlestickSeries, candle(up(0.42), down(0.42)));
    const pool = chart.addSeries(CandlestickSeries, {
      ...candle(up(), down()),
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
    // The listing is a moment, not a direction: neutral ink only, never green, red or teal.
    const marker = new ListingMarker({
      line: token("fg-3", 0.55),
      pill: token("surface-3"),
      text: token("fg-2"),
      font: `500 11px ${fontFamily}`,
    });
    pool.attachPrimitive(marker);
    const move = (param: MouseEventParams) => {
      setHover(typeof param.time === "number" ? (lookup.current.get(param.time) ?? null) : null);
    };
    chart.subscribeCrosshairMove(move);
    parts.current = {
      chart,
      stage2,
      pool,
      volume,
      marker,
      listingLine: null,
      up,
      down,
      // Carried-forward buckets had no trades: draw them as a quiet neutral tick, not as a rise.
      idle: token("fg", 0.28),
      listing: token("fg-3", 0.5),
    };
    framed.current = null;
    return () => {
      chart.unsubscribeCrosshairMove(move);
      chart.remove();
      parts.current = null;
    };
    // `price` depends only on the locale formatter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locale, resolvedTheme]);

  // Feed data in place; the visible range is framed only when the bucket size changes.
  useEffect(() => {
    const p = parts.current;
    if (!p || !host.current) return;
    const byTime = new Map<number, Bar>();
    for (const b of bars) if (b.venue === "pool" || !byTime.has(b.time)) byTime.set(b.time, b);
    lookup.current = byTime;
    p.chart.applyOptions({ timeScale: { timeVisible: seconds < 86400 } });
    const ohlc = (b: Bar) => ({
      time: b.time as UTCTimestamp,
      open: b.open,
      high: b.high,
      low: b.low,
      close: b.close,
      ...(b.filled ? { color: p.idle, borderColor: p.idle, wickColor: p.idle } : {}),
    });
    p.stage2.setData(bars.filter((b) => b.venue === "stage2").map(ohlc));
    p.pool.setData(bars.filter((b) => b.venue === "pool").map(ohlc));
    // One volume column per time: the listing bucket may hold a Stage 2 and a pool candle.
    const volumes = new Map<number, { bar: Bar; total: number }>();
    for (const b of bars) volumes.set(b.time, { bar: b, total: (volumes.get(b.time)?.total ?? 0) + b.volume });
    p.volume.setData(
      [...volumes.values()].map(({ bar, total }) => {
        const alpha = bar.venue === "pool" ? 0.34 : 0.16;
        return {
          time: bar.time as UTCTimestamp,
          value: total,
          color: bar.close >= bar.open ? p.up(alpha) : p.down(alpha),
        };
      }),
    );
    p.marker.set(listingTime as UTCTimestamp | null, t("listed"));
    // A quiet reference at the listing price, with its value on the price axis.
    if (p.listingLine) p.pool.removePriceLine(p.listingLine);
    p.listingLine =
      listingPrice !== null && listingPrice > 0
        ? p.pool.createPriceLine({
            price: listingPrice,
            color: p.listing,
            lineWidth: 1,
            lineStyle: LineStyle.Dashed,
            axisLabelVisible: true,
            axisLabelColor: token("surface-3"),
            axisLabelTextColor: token("fg-2"),
            title: "",
          })
        : null;
    if (bars.length && framed.current !== seconds) {
      framed.current = seconds;
      // About six pixels per bar: phones show the recent weeks, desktops more history; scroll for the rest.
      const visible = Math.min(bars.length, Math.max(30, Math.floor((host.current.clientWidth || 600) / 6)));
      if (bars.length > visible)
        p.chart.timeScale().setVisibleLogicalRange({ from: bars.length - visible, to: bars.length + 3 });
      else p.chart.timeScale().fitContent();
    }
  }, [bars, seconds, listingTime, listingPrice, locale, resolvedTheme, t]);

  const change = shown && !shown.filled && shown.open > 0 ? (shown.close - shown.open) / shown.open : null;
  const fields = [
    ["open", shown?.open, true],
    ["high", shown?.high, false],
    ["low", shown?.low, false],
    ["close", shown?.close, false],
  ] as const;
  return (
    <div className="flex flex-col gap-4 [overflow-anchor:none]" data-testid="market-chart">
      {/* Wraps only on container width: every child has a fixed width, whatever the values. */}
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-3">
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
        {/* One line, fixed height; phones drop open and volume rather than wrap. */}
        <dl
          className="num flex h-5 max-w-full shrink-0 items-center gap-x-2 overflow-hidden whitespace-nowrap text-xs leading-5 text-fg-3"
          data-testid="chart-legend"
        >
          {fields.map(([k, value, wide]) => (
            <div key={k} className={cn("shrink-0 gap-1", wide ? "hidden sm:flex" : "flex")}>
              <dt>{t(k)}</dt>
              <dd className="w-[3.75em] overflow-hidden text-ellipsis text-fg-2 sm:w-[4.4em]">
                <span className="sm:hidden">{value === undefined ? "–" : legendPrice(value, PHONE_PRICE_CHARS)}</span>
                <span className="hidden sm:inline">{value === undefined ? "–" : legendPrice(value, PRICE_CHARS)}</span>
              </dd>
            </div>
          ))}
          <div className="hidden shrink-0 gap-1 sm:flex">
            <dt>{t("volume")}</dt>
            <dd
              className="overflow-hidden text-ellipsis text-fg-2"
              style={{ width: `calc(3.75em + ${quoteSymbol.length + 0.5}ch)` }}
            >
              {shown ? `${legendVolume(shown.volume)} ${quoteSymbol}` : "–"}
            </dd>
          </div>
          <dd
            className={cn(
              "w-[4.4em] shrink-0 overflow-hidden text-ellipsis text-right",
              change === null ? "text-fg-3" : change > 0 ? "text-positive" : change < 0 ? "text-negative" : "text-fg-2",
            )}
          >
            {change === null
              ? ""
              : format.number(change, { style: "percent", maximumFractionDigits: 2, signDisplay: "always" })}
          </dd>
        </dl>
      </div>
      <div className="relative">
        <div
          ref={host}
          className="h-72 w-full sm:h-[23rem]"
          data-testid="candles"
          data-bars={bars.length}
          data-trades={poolTrades}
          data-listing={listingTime ?? undefined}
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
          <Swatch faded />
          {t("stage2")}
        </span>
        <span className="inline-flex items-center gap-2">
          <Swatch />
          {t("pool")}
        </span>
        <span className="text-fg-3">{t("down")}</span>
        {data?.listing ? (
          <span className="inline-flex items-center gap-2" data-testid="listing-legend">
            <span aria-hidden className="inline-block h-3 border-l border-dashed border-fg-3" />
            {t("listingAt", { price: price(Number(data.listing.price)), unit: quoteSymbol })}
          </span>
        ) : null}
        <span className="ml-auto text-fg-3">{t("utc")}</span>
      </div>
    </div>
  );
}

/** A rising and a falling candle, as drawn in the chart. */
function Swatch({ faded = false }: { faded?: boolean }) {
  return (
    <span aria-hidden className={cn("inline-flex items-end gap-[2px]", faded && "opacity-[0.45]")}>
      <span className="inline-block h-3 w-1.5 rounded-[1px] bg-positive" />
      <span className="inline-block h-2 w-1.5 rounded-[1px] bg-negative" />
    </span>
  );
}
