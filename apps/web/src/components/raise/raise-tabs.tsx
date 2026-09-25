"use client";
import { displayStage, STAGE_TONE } from "@/lib/stages";
import { AnalystReport } from "./analyst-report";
import { BuilderUpdates } from "./builder-updates";
import { CHEVRON, SUMMARY } from "@/components/disclosure";
import type { RaiseDetail } from "@/lib/api";
import { useNumbers } from "@/lib/use-numbers";
import { cn, shortAddress } from "@/lib/utils";
import { ChevronDown } from "lucide-react";
import { useTranslations } from "next-intl";
export function RaiseSkeleton() {
  return (
    <div className="flex flex-col gap-10 pt-4 lg:pt-6" aria-busy>
      <div className="skeleton h-3 w-16" />
      <div className="flex items-center gap-4">
        <div className="skeleton size-14 rounded-[15px]" />
        <div className="flex flex-col gap-2.5">
          <div className="skeleton h-7 w-56" />
          <div className="skeleton h-3.5 w-80 max-w-full" />
        </div>
      </div>
      <div className="flex gap-10">
        <div className="skeleton h-12 w-64" />
        <div className="skeleton hidden h-12 w-40 md:block" />
        <div className="skeleton hidden h-12 w-40 md:block" />
      </div>
      <div className="skeleton h-12 w-full" />
      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_23rem] xl:gap-12">
        <div className="skeleton h-96 rounded-[14px]" />
        <div className="skeleton h-96 rounded-[14px]" />
      </div>
    </div>
  );
}

export function OverviewTab({ detail }: { detail: RaiseDetail }) {
  const t = useTranslations("stages");
  const td = useTranslations("raiseDetails");
  const n = useNumbers();
  const cfg = detail.config;
  const v = useTranslations("v31");
  const rows: [string, string][] = [
    [v("supply"), `${n.token(cfg.supply)} ${detail.symbol}`],
    [v("targetPriceShort"), `${n.price(cfg.targetPrice)} ${detail.quote.symbol}`],
    [v("stage1Length"), n.duration(Number(cfg.stage1Length))],
    [v("stage2Length"), n.duration(Number(cfg.stage2Length))],
    ...(detail.template === "BUDGET_LAUNCH"
      ? ([[v("budgetCeilingShort"), n.pct(Number((BigInt(cfg.budgetCeiling) * 10000n) / 10n ** 18n))]] as [
          string,
          string,
        ][])
      : []),
    [v("minimumBackers"), n.number(detail.governance.config.parameters.minimumBackers, 0)],
    [v("tradeFee"), n.pct(detail.governance.config.parameters.tradeFeeBps)],
  ];
  const addrs: [string, string][] = [
    [td("raise"), detail.address],
    [td("token"), detail.token],
    [v("claimsVault"), detail.modules.claims],
    [v("vestingVault"), detail.modules.vesting],
    [v("treasury"), detail.config.treasury],
  ];
  return (
    <div className="flex flex-col gap-4">
      <section className="surface-1 p-5 sm:p-6">
        <h3 className="text-sm font-medium">{td("about")}</h3>
        <p className="mt-3 max-w-2xl text-sm leading-relaxed text-fg-2">{detail.description || td("noDescription")}</p>
        <p className="mt-5 flex items-start gap-2 border-t border-fg/[0.07] pt-4 text-xs leading-relaxed text-fg-3">
          <span
            className={cn("mt-1.5 size-1.5 shrink-0 rounded-full", STAGE_TONE[displayStage(detail.phase)].dot)}
            aria-hidden
          />
          {t(`${displayStage(detail.phase)}.desc`)}
        </p>
      </section>
      <BuilderUpdates raise={detail.address} />
      <AnalystReport detail={detail} />
      <details className="surface-1 group px-5">
        <summary className={cn(SUMMARY, "py-4 text-sm text-fg")}>
          <span>{td("parameters")}</span>
          <ChevronDown className={CHEVRON} aria-hidden />
        </summary>
        <dl className="grid grid-cols-1 gap-x-10 border-t border-hairline pb-3 pt-2 text-xs sm:grid-cols-2">
          {rows.map(([k, v]) => (
            <div
              key={k}
              className="flex items-baseline justify-between gap-4 border-b border-hairline py-2.5 last:border-0"
            >
              <dt className="text-fg-3">{k}</dt>
              <dd className="num text-right text-fg">{v}</dd>
            </div>
          ))}
        </dl>
      </details>
      <details className="surface-1 group px-5">
        <summary className={cn(SUMMARY, "py-4 text-sm text-fg")}>
          <span>{td("contracts")}</span>
          <ChevronDown className={CHEVRON} aria-hidden />
        </summary>
        <dl className="grid grid-cols-1 border-t border-hairline pb-3 pt-2 text-xs">
          {addrs.map(([k, v]) => (
            <div
              key={k}
              className="flex items-baseline justify-between gap-4 border-b border-hairline py-2.5 last:border-0"
            >
              <dt className="text-fg-3">{k}</dt>
              <dd className="font-mono text-fg-2" title={v}>
                {shortAddress(v, 8)}
              </dd>
            </div>
          ))}
        </dl>
      </details>
    </div>
  );
}
