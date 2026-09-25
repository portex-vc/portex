"use client";

import { ProjectAvatar } from "@/components/raise/project-avatar";
import { ProtectionBoundary, TypeBadge } from "@/components/raise/type-badge";
import { priceOf, scheduleUnits, stageSeconds, type FormState } from "@/lib/create-form";
import type { ApiConfig } from "@/lib/api";
import { useNow } from "@/lib/hooks";
import { useNumbers } from "@/lib/use-numbers";
import { cn } from "@/lib/utils";
import { useTranslations } from "next-intl";

const ALLOCATION = [
  ["sale", 20, "bg-fg"],
  ["pool", 40, "bg-fg/45"],
  ["rewards", 30, "bg-protected"],
  ["treasury", 10, "bg-fg/20"],
] as const;

/**
 * Live preview beside the launch form (DESIGN_V2 §6): the card backers will see, the Stage 1
 * price curve implied by the target, the dates if launched now, and the fixed allocation.
 */
export function LaunchPreview({ form, config }: { form: FormState; config?: ApiConfig }) {
  const t = useTranslations("create.preview");
  const all = useTranslations();
  const n = useNumbers();
  const now = useNow();
  const units = scheduleUnits(config, form.templateName);
  const last = priceOf(form);
  const valid = last > 0n;
  const first = valid ? (last * 2n) / 3n : 0n;
  const supply = Number(form.supply) || 0;
  // Full sale = 20 % of supply along a linear curve from 2/3·p to p: 0.2 · S · p · 5/6.
  const fullSale = valid ? (supply * 0.2 * Number(last) * 5) / 6 / 1e18 : 0;
  const s1 = stageSeconds(form.stage1Days, units.stage1);
  const s2 = stageSeconds(form.stage2Weeks, units.stage2);
  const stage1End = now && Number.isFinite(s1) ? now + s1 : null;
  const stage2End = stage1End && Number.isFinite(s2) ? stage1End + s2 : null;
  const name = form.name.trim() || t("placeholderName");
  const symbol = (form.symbol.trim() || "TKN").toUpperCase();
  const tagline = form.description.trim().split(/\n/)[0];

  return (
    <aside className="flex flex-col gap-4 lg:sticky lg:top-24" aria-label={t("title")} data-testid="launch-preview">
      <p className="micro">{t("title")}</p>

      <div className="surface-1 p-5">
        <div className="flex items-start gap-3.5">
          <ProjectAvatar symbol={symbol} />
          <div className="min-w-0 flex-1 pt-0.5">
            <div className="flex items-baseline gap-2">
              <p className={cn("truncate text-[0.9375rem] font-medium", !form.name.trim() && "text-fg-3")}>{name}</p>
              <span className="shrink-0 font-mono text-[0.6875rem] text-fg-3">{symbol}</span>
            </div>
            <p className="mt-1 line-clamp-2 min-h-[2.5rem] text-[0.8125rem] leading-5 text-fg-2">{tagline}</p>
          </div>
        </div>
        <div className="mt-4 flex items-center gap-2 text-xs">
          <span className="inline-flex items-center gap-1.5 font-medium text-fg-2">
            <span aria-hidden className="size-1.5 rounded-full bg-fg-2" />
            {all("stages.Stage1.short")}
          </span>
          <span className="text-fg-3">{all("stages.Stage1.name")}</span>
          <span className="ml-auto">
            <TypeBadge template={form.templateName} />
          </span>
        </div>
        <div className="mt-4 h-[3px] rounded-full bg-fg/[0.07]" />
        <p className="num mt-2 text-xs text-fg-3">{all("card.sold", { value: n.pct(0) })}</p>
      </div>

      <div className="surface-1 space-y-4 p-5">
        <div className="flex items-baseline justify-between">
          <p className="text-sm font-medium">{t("curve")}</p>
          <p className="text-xs text-fg-3">USDG</p>
        </div>
        <svg viewBox="0 0 240 72" className="block h-auto w-full overflow-visible" aria-hidden>
          <defs>
            <linearGradient id="launch-curve" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="rgb(var(--protected))" stopOpacity={0.18} />
              <stop offset="100%" stopColor="rgb(var(--protected))" stopOpacity={0} />
            </linearGradient>
          </defs>
          <path d="M0 52 L240 14 L240 72 L0 72 Z" fill="url(#launch-curve)" />
          <line x1={0} y1={52} x2={240} y2={14} stroke="rgb(var(--fg))" strokeWidth={1.75} strokeLinecap="round" />
          <circle cx={0} cy={52} r={3} fill="rgb(var(--fg))" />
          <circle cx={240} cy={14} r={3} fill="rgb(var(--fg))" />
        </svg>
        <dl className="grid grid-cols-2 gap-3 text-xs">
          <div>
            <dt className="text-fg-3">{t("first")}</dt>
            <dd className="num mt-0.5 text-sm text-fg">{valid ? n.price(first) : "—"}</dd>
          </div>
          <div className="text-right">
            <dt className="text-fg-3">{t("last")}</dt>
            <dd className="num mt-0.5 text-sm text-fg">{valid ? n.price(last) : "—"}</dd>
          </div>
          <div className="col-span-2 flex items-baseline justify-between border-t border-fg/[0.07] pt-3">
            <dt className="text-fg-3">{t("fullSale")}</dt>
            <dd className="num text-sm text-protected">
              {valid ? n.number(fullSale, 2) : "—"} <span className="text-xs text-fg-3">USDG</span>
            </dd>
          </div>
        </dl>
      </div>

      <div className="surface-1 space-y-3 p-5 text-xs">
        <p className="text-sm font-medium">{t("timeline")}</p>
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-fg-3">{t("stage1Ends")}</span>
          <span className="num text-fg">{stage1End ? n.date(stage1End) : "—"}</span>
        </div>
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-fg-3">{t("listing")}</span>
          <span className="num text-fg">{stage2End ? n.date(stage2End) : "—"}</span>
        </div>
      </div>

      <div className="surface-1 space-y-3 p-5">
        <p className="text-sm font-medium">{t("allocation")}</p>
        <div className="flex h-2 gap-0.5 overflow-hidden rounded-full">
          {ALLOCATION.map(([key, pct, tone]) => (
            <span
              key={key}
              className={cn("h-full first:rounded-l-full last:rounded-r-full", tone)}
              style={{ width: `${pct}%` }}
            />
          ))}
        </div>
        <ul className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
          {ALLOCATION.map(([key, pct, tone]) => (
            <li key={key} className="flex items-center gap-2 text-fg-2">
              <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", tone)} />
              <span className="min-w-0 flex-1 truncate">{t(`alloc.${key}`)}</span>
              <span className="num text-fg-3">{pct}%</span>
            </li>
          ))}
        </ul>
        <ProtectionBoundary template={form.templateName} className="border-t border-fg/[0.07] pt-3 text-fg-3" />
      </div>
    </aside>
  );
}
