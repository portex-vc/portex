"use client";
import type { RaiseDetail } from "@/lib/api";
import { usePosition, usePriceHistory } from "@/lib/hooks";
import {
  AreaSeries,
  createChart,
  ColorType,
  LineStyle,
  TickMarkType,
  type AutoscaleInfo,
  type UTCTimestamp,
} from "lightweight-charts";
import { useNumbers } from "@/lib/use-numbers";
import { useLocale, useTranslations } from "next-intl";
import { useTheme } from "next-themes";
import { useEffect, useMemo, useRef } from "react";
import { useAccount } from "wagmi";
export function PriceChart({ detail: r }: { detail: RaiseDetail }) {
  const tm = useTranslations("market");
  const v = useTranslations("v31"),
    n = useNumbers(),
    locale = useLocale();
  const { address } = useAccount();
  const { data: p } = usePosition(r.address, address);
  const { data: history } = usePriceHistory(r.address);
  const { resolvedTheme } = useTheme();
  const ref = useRef<HTMLDivElement>(null);
  const backers = p?.positions.filter((x) => x.positionState.class === "Backer") ?? [];
  const basis = backers.reduce((sum, x) => sum + BigInt(x.positionState.basis), 0n),
    tokens = backers.reduce((sum, x) => sum + BigInt(x.positionState.tokens), 0n);
  const cost = tokens > 0n && basis > 0n && r.phase !== "Stage3" ? Number((basis * 10n ** 30n) / tokens) / 1e18 : null;
  // In Stage 2 and after, curvePrice is the final Stage 1 price: the reference for the dual track.
  const stage1 =
    r.phase !== "Stage1" && r.phase !== "Dissolved" && BigInt(r.curvePrice) > 0n ? Number(r.curvePrice) / 1e18 : null;
  const points = useMemo(() => {
    const map = new Map<number, { time: UTCTimestamp; value: number }>();
    for (const point of history ?? []) {
      const value = r.phase === "Stage1" ? point.curvePrice : point.price;
      if (value !== null && (r.phase === "Stage1" || point.kind === "book"))
        map.set(point.timestamp, { time: point.timestamp as UTCTimestamp, value: Number(value) / 1e18 });
    }
    return [...map.values()].sort((a, b) => a.time - b.time);
  }, [history, r.phase]);
  useEffect(() => {
    if (!ref.current) return;
    const dark = resolvedTheme !== "light";
    // Across several days, an intraday tick ("01:34") between date ticks reads as a stray label: hide it.
    const span = points.length > 1 ? points[points.length - 1].time - points[0].time : 0;
    const multiDay = span > 2 * 86400;
    const chart = createChart(ref.current, {
      autoSize: true,
      localization: {
        locale,
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
        textColor: dark ? "#686F7C" : "#868E9C",
        fontFamily: getComputedStyle(document.body).fontFamily,
        fontSize: 11,
        attributionLogo: false,
      },
      grid: {
        vertLines: { visible: false },
        horzLines: { color: dark ? "rgba(255,255,255,.045)" : "rgba(13,15,18,.06)" },
      },
      rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.1, bottom: 0.1 } },
      timeScale: {
        borderVisible: false,
        timeVisible: true,
        // Day ticks show the date; intraday ticks show the UTC time.
        tickMarkFormatter: (time: number, type: TickMarkType) => {
          const intraday = type === TickMarkType.Time || type === TickMarkType.TimeWithSeconds;
          if (intraday && multiDay) return "";
          return new Intl.DateTimeFormat(
            locale,
            intraday
              ? { hour: "2-digit", minute: "2-digit", timeZone: "UTC" }
              : { month: "short", day: "numeric", timeZone: "UTC" },
          ).format(new Date(time * 1000));
        },
      },
      handleScroll: false,
      handleScale: false,
      crosshair: {
        vertLine: {
          color: dark ? "rgba(255,255,255,.18)" : "rgba(13,15,18,.2)",
          width: 1,
          style: LineStyle.Solid,
          labelBackgroundColor: dark ? "#1E222A" : "#E9EBEE",
        },
        horzLine: {
          color: dark ? "rgba(255,255,255,.12)" : "rgba(13,15,18,.14)",
          labelBackgroundColor: dark ? "#1E222A" : "#E9EBEE",
        },
      },
    });
    const line = chart.addSeries(AreaSeries, {
      lineColor: dark ? "#F2F3F5" : "#0D0F12",
      topColor: dark ? "rgba(242,243,245,0.10)" : "rgba(13,15,18,0.08)",
      bottomColor: dark ? "rgba(242,243,245,0)" : "rgba(13,15,18,0)",
      lineWidth: 2,
      crosshairMarkerRadius: 4,
      crosshairMarkerBorderColor: dark ? "#0A0B0D" : "#FFFFFF",
      crosshairMarkerBackgroundColor: dark ? "#F2F3F5" : "#0D0F12",
      pointMarkersVisible: false,
      priceLineVisible: false,
      lastValueVisible: false,
      priceFormat: {
        type: "custom",
        formatter: (value: number) =>
          new Intl.NumberFormat(locale, { maximumSignificantDigits: 6 }).format(Math.abs(value) < 1e-9 ? 0 : value),
        minMove: 0.000001,
      },
      autoscaleInfoProvider: (original: () => AutoscaleInfo | null) => {
        const info = original();
        if (!info) return info;
        const values = points.map((x) => x.value);
        if (cost !== null) values.push(cost);
        if (stage1 !== null) values.push(stage1);
        if (!values.length) return info;
        const low = Math.min(...values),
          high = Math.max(...values),
          pad = Math.max(high * 0.03, (high - low) * 0.1, 1e-6);
        return { ...info, priceRange: { minValue: Math.max(0, low - pad), maxValue: high + pad } };
      },
    });
    line.setData(points);
    if (stage1 !== null)
      line.createPriceLine({
        price: stage1,
        color: dark ? "rgba(242,243,245,0.35)" : "rgba(13,15,18,0.35)",
        lineWidth: 1,
        lineStyle: LineStyle.SparseDotted,
        axisLabelVisible: false,
        title: "",
      });
    if (cost !== null)
      line.createPriceLine({
        price: cost,
        color: dark ? "#2DCEB6" : "#0D8F80",
        lineWidth: 2,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: false,
        title: "",
      });
    chart.timeScale().fitContent();
    return () => chart.remove();
  }, [points, cost, stage1, locale, resolvedTheme]);
  return (
    <div>
      <div className="relative">
        <div ref={ref} className="h-64 w-full sm:h-80" data-testid="price-chart" />
        {!history ? <div aria-hidden className="skeleton absolute inset-0 rounded-[10px]" /> : null}
        {history && points.length === 0 ? (
          <p className="absolute inset-0 flex items-center justify-center text-center text-xs text-fg-3">
            {v("noPriceHistory")}
          </p>
        ) : null}
      </div>
      <div className="mt-4 flex flex-wrap gap-x-6 gap-y-2 border-t border-fg/[0.07] pt-4 text-xs text-fg-2">
        <span className="num inline-flex items-center gap-2">
          <span className="inline-block h-[2px] w-4 rounded-full bg-fg" />
          {v(r.phase === "Stage1" ? "curvePrice" : r.phase === "Stage3" ? "listingPrice" : "bookPrice")}
          <span className="text-fg">{n.price(r.phase === "Stage1" ? r.curvePrice : r.bookPrice)}</span>
        </span>
        {stage1 !== null ? (
          <span className="num inline-flex items-center gap-2">
            <span className="inline-block w-4 border-t border-dotted border-fg/40" />
            {tm("stage1")}
            <span className="text-fg">{n.price(r.curvePrice)}</span>
          </span>
        ) : null}
        {cost !== null ? (
          <span data-testid="cost-line" className="num inline-flex items-center gap-2">
            <span className="inline-block w-4 border-t-2 border-dashed border-protected" />
            {v("yourCost")}
            <span className="text-protected">{n.number(cost, 6)}</span>
          </span>
        ) : null}
        <span className="ml-auto text-fg-3">{r.quote.symbol}</span>
      </div>
      {r.phase === "Stage3" ? <p className="mt-3 text-xs text-fg-3">{v("historicalPrice")}</p> : null}
    </div>
  );
}
