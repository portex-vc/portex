"use client";

import { MechanismVisual } from "@/components/home/mechanism-visual";
import { StageFilter } from "@/components/home/stage-filter";
import { NumberTicker } from "@/components/motion/number-ticker";
import { RaiseCard } from "@/components/raise/raise-card";
import { TypeBadge } from "@/components/raise/type-badge";
import { useNetworkName } from "@/components/shell/wallet";
import { ErrorState } from "@/components/states";
import { TestnetTimingNote } from "@/components/testnet-timing";
import { Hint } from "@/components/term";
import { Button } from "@/components/ui/button";
import { env, isLocalChain } from "@/lib/env";
import { useRaises } from "@/lib/hooks";
import { LAUNCH_TYPES } from "@/lib/launch-types";
import { displayStage, isLive, STAGE_TONE } from "@/lib/stages";
import { useNumbers } from "@/lib/use-numbers";
import { cn } from "@/lib/utils";
import { ArrowDown, ArrowLeftRight, ArrowRight, Info } from "lucide-react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useMemo, useState } from "react";

export default function HomePage() {
  const t = useTranslations("home");
  const tt = useTranslations("types");
  const all = useTranslations();
  const numbers = useNumbers();
  const network = useNetworkName();
  const { data: raises, isLoading, isError, error, refetch } = useRaises();
  const [filter, setFilter] = useState("all");

  const kpis = useMemo(() => {
    const list = raises ?? [];
    return {
      protectedTotal: list.reduce((a, r) => a + BigInt(r.E), 0n),
      live: list.filter((r) => isLive(r.phase)).length,
      graduated: list.filter((r) => r.phase === "Stage3").length,
      backers: list.reduce((a, r) => a + r.backers, 0),
      byStage: list.reduce<Record<string, number>>((counts, raise) => {
        counts[raise.phase] = (counts[raise.phase] ?? 0) + 1;
        return counts;
      }, {}),
    };
  }, [raises]);

  const shown = (raises ?? []).filter((r) => filter === "all" || displayStage(r.phase) === filter);
  const quoteSymbol = raises?.[0]?.quote.symbol ?? "USDG";
  const placeholder = isLoading ? <span aria-hidden className="skeleton inline-block h-7 w-12 align-bottom" /> : "—";
  const count = (value: number) =>
    raises ? <NumberTicker value={value} format={(n) => numbers.number(Math.round(n), 0)} /> : placeholder;

  return (
    <div className="flex flex-col">
      {/* Hero */}
      <section
        aria-labelledby="hero-title"
        className="grid items-center gap-12 pb-14 pt-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,30rem)] lg:gap-14 lg:pb-20 lg:pt-16 xl:grid-cols-[minmax(0,1fr)_minmax(0,34rem)]"
      >
        <div className="flex min-w-0 flex-col">
          {!isLocalChain ? (
            <p className="mb-6 inline-flex w-fit items-center gap-2 rounded-full border border-fg/[0.08] bg-fg/[0.03] py-1 pl-2.5 pr-3 text-xs text-fg-2">
              <span className="relative flex size-2 items-center justify-center" aria-hidden>
                <span className="absolute inline-flex size-full animate-ping rounded-full bg-protected/50 [animation-duration:2.4s]" />
                <span className="relative size-1.5 rounded-full bg-protected" />
              </span>
              {t("live", { network: network(env.chainId) })}
            </p>
          ) : null}
          <h1 id="hero-title" className="t-display text-balance text-fg">
            <Clauses text={t("title")} />
          </h1>
          <p className="mt-6 max-w-[40rem] text-pretty text-base leading-[1.7] text-fg-2">{t("sub")}</p>
          <div className="mt-8 flex flex-wrap gap-2.5">
            <Button asChild size="lg" className="group">
              <a href="#raises">
                {t("cta")}
                <ArrowDown className="transition-transform duration-200 group-hover:translate-y-0.5" />
              </a>
            </Button>
            <Button asChild variant="outline" size="lg">
              <Link href="/create">{t("ctaBuilder")}</Link>
            </Button>
          </div>
          <div className="mt-10 flex max-w-[40rem] gap-3 text-xs leading-relaxed text-fg-3">
            <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            <div className="space-y-1.5">
              <p>{t("boundary")}</p>
              <p>{t("allocationNote")}</p>
            </div>
          </div>
        </div>
        <div className="relative min-w-0">
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 -z-10 rounded-[40px] lg:-inset-y-10 bg-[radial-gradient(60%_50%_at_50%_60%,rgb(var(--protected)/0.10),transparent_70%)] blur-2xl"
          />
          <div className="surface-1 p-5 sm:p-7">
            <MechanismVisual />
          </div>
        </div>
      </section>

      {/* Figures band */}
      <section aria-label={t("kpiFormula")} className="border-y border-fg/[0.07]">
        <dl className="grid grid-cols-2 gap-y-8 py-8 lg:grid-cols-[1.5fr_1fr_1fr_1fr]">
          <Figure
            label={t("kpi.protected")}
            className="col-span-2 lg:col-span-1"
            value={
              raises ? (
                <NumberTicker
                  value={Number(kpis.protectedTotal) / 1e6}
                  format={(n) => numbers.quote(BigInt(Math.round(n * 1e6)))}
                />
              ) : isLoading ? (
                <span aria-hidden className="skeleton inline-block h-10 w-56 max-w-full align-bottom" />
              ) : (
                "—"
              )
            }
            unit={raises ? quoteSymbol : undefined}
            emphasis
          />
          <Figure label={t("kpi.live")} value={count(kpis.live)} />
          <Figure label={t("kpi.graduated")} value={count(kpis.graduated)} />
          <Figure label={t("kpi.backers")} value={count(kpis.backers)} />
        </dl>
      </section>

      {/* Principles */}
      <ol data-testid="home-pillars" className="grid grid-cols-1 gap-x-10 gap-y-10 pt-16 md:grid-cols-2 xl:grid-cols-4">
        {(["protection", "founders", "spending", "allocation"] as const).map((key, i) => (
          <li key={key} className="flex flex-col gap-3">
            <span className="num font-mono text-2xs text-fg-3" aria-hidden>
              0{i + 1}
            </span>
            <h2 className="text-[0.9375rem] font-medium leading-6 tracking-[-0.01em] text-fg">
              {t(`pillars.${key}.title`)}
            </h2>
            <p className="text-sm leading-relaxed text-fg-2">{t(`pillars.${key}.desc`)}</p>
          </li>
        ))}
      </ol>

      {/* Projects */}
      <section id="raises" aria-labelledby="projects-title" className="scroll-mt-24 pt-24">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
          <h2 id="projects-title" className="t-section">
            {t("projectsTitle")}
          </h2>
          <StageFilter counts={kpis.byStage} total={raises?.length ?? 0} selected={filter} onSelect={setFilter} />
        </div>
        {isError ? (
          <div className="mt-8">
            <ErrorState error={error} retry={() => refetch()} />
          </div>
        ) : null}
        <div className="mt-10 flex flex-col gap-16">
          {LAUNCH_TYPES.map(({ key, template }) => {
            const projects = shown.filter((raise) => raise.template === template);
            return (
              <section
                key={key}
                aria-labelledby={`launches-${key}`}
                data-testid={`launches-${key}`}
                className="flex flex-col gap-6"
              >
                <div className="flex flex-col gap-2 border-t border-fg/[0.07] pt-6">
                  <div className="flex items-center gap-3">
                    <h3 id={`launches-${key}`} className="text-lg font-medium tracking-[-0.015em]">
                      {tt(`${key}.title`)}
                    </h3>
                    <TypeBadge template={template} />
                  </div>
                  <p className="max-w-2xl text-sm leading-relaxed text-fg-2">{tt(`${key}.definition`)}</p>
                  <p className="text-xs text-fg-3" data-testid="protection-boundary">
                    {tt(`${key}.boundary`)}
                  </p>
                </div>
                {isLoading ? (
                  <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3" aria-busy>
                    {Array.from({ length: 3 }).map((_, i) => (
                      <div key={i} className="skeleton h-[17.5rem] rounded-[14px]" />
                    ))}
                  </div>
                ) : isError ? null : projects.length === 0 ? (
                  <div
                    className="flex flex-wrap items-center justify-between gap-4 rounded-[14px] border border-dashed border-fg/[0.12] px-5 py-6"
                    data-testid="type-empty"
                  >
                    <p className="text-sm text-fg-2">{tt(filter === "all" ? `${key}.emptyAll` : `${key}.empty`)}</p>
                    <Button asChild variant="outline" size="sm">
                      <Link href={`/create?type=${key}`}>{t("ctaBuilder")}</Link>
                    </Button>
                  </div>
                ) : (
                  <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                    {projects.map((r, i) => (
                      <RaiseCard key={r.address} r={r} index={i} />
                    ))}
                  </div>
                )}
              </section>
            );
          })}
        </div>
      </section>

      {/* How a launch unfolds */}
      <section aria-labelledby="how-title" className="pt-28">
        <div className="max-w-2xl">
          <h2 id="how-title" className="t-section">
            {t("howTitle")}
          </h2>
          <p className="mt-2 text-sm leading-relaxed text-fg-2">{t("howSub")}</p>
        </div>
        <ol className="mt-10 grid gap-10 md:grid-cols-3 md:gap-8">
          {(["Stage1", "Stage2", "Stage3"] as const).map((stage, i) => (
            <li key={stage} className="relative flex flex-col gap-3 border-t border-fg/[0.1] pt-6">
              <span
                aria-hidden
                className={cn("absolute -top-[3px] left-0 size-[5px] rounded-full", STAGE_TONE[stage].dot)}
              />
              <p className="num text-xs text-fg-3">{all(`stages.${stage}.short`)}</p>
              <h3 className="text-lg font-medium tracking-[-0.015em]">{all(`stages.${stage}.name`)}</h3>
              <p className="text-xs font-medium text-fg-2">{all(`stages.${stage}.path`)}</p>
              <p className="text-sm leading-relaxed text-fg-2">{all(`stages.${stage}.desc`)}</p>
              {i < 2 ? (
                <p className="mt-1 flex gap-2 text-xs leading-relaxed text-fg-3">
                  <ArrowRight className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                  {all(`lifecycle.gates.stage${i + 1}`)}
                </p>
              ) : null}
              {i === 0 ? (
                <p className="flex gap-2 text-xs leading-relaxed text-fg-3">
                  <span aria-hidden className="mt-[5px] size-1.5 shrink-0 rounded-full bg-fg-3" />
                  {all("lifecycle.gates.dissolved")}
                </p>
              ) : null}
            </li>
          ))}
        </ol>
        {/* Production copy above, testnet projects on the same page: say so once, as a footnote. */}
        {raises?.length ? <TestnetTimingNote variant="footnote" className="mt-8" /> : null}
        <div
          className="mt-12 flex flex-col gap-3 rounded-[14px] border border-fg/[0.08] bg-fg/[0.02] p-5 sm:flex-row sm:items-center sm:gap-5"
          data-testid="rollover-callout"
        >
          <span className="flex size-9 shrink-0 items-center justify-center rounded-[10px] bg-protected/10 text-protected">
            <ArrowLeftRight className="size-4" aria-hidden />
          </span>
          <div className="min-w-0 space-y-1">
            <p className="text-sm font-medium">{all("protocol.guarantees.rollover.t")}</p>
            <p className="text-sm leading-relaxed text-fg-2">{all("protocol.guarantees.rollover.d")}</p>
          </div>
        </div>
      </section>
    </div>
  );
}

function Figure({
  label,
  value,
  unit,
  emphasis,
  className,
}: {
  label: string;
  value: React.ReactNode;
  unit?: string;
  emphasis?: boolean;
  className?: string;
}) {
  const t = useTranslations("home");
  return (
    <div
      className={cn(
        "flex min-w-0 flex-col gap-2 lg:border-l lg:border-fg/[0.07] lg:pl-8 lg:first:border-l-0 lg:first:pl-0",
        className,
      )}
    >
      <dt className="flex items-center gap-1.5 text-xs text-fg-3">
        <span className="min-w-0">{label}</span> <Hint text={t("kpiFormula")} className="shrink-0" />
      </dt>
      <dd className={cn(emphasis ? "t-figure-xl text-protected" : "t-figure-lg text-fg")}>
        {value}
        {unit ? <span className="ml-2 text-sm tracking-normal text-fg-3">{unit}</span> : null}
      </dd>
    </div>
  );
}

/**
 * CJK text may break between any two characters, so a headline can split mid-word
 * ("做拥 / 有保护"). Each clause (split after a full-width comma) becomes an inline-block:
 * the line breaks at the clause boundary first, and only wraps inside a clause when the clause
 * alone is wider than the column. Latin-script titles contain no full-width comma and render as-is.
 */
function Clauses({ text }: { text: string }) {
  const clauses = text.split(/(?<=，)/);
  if (clauses.length < 2) return text;
  return clauses.map((clause, i) => (
    <span key={i} className="inline-block">
      {clause}
    </span>
  ));
}
