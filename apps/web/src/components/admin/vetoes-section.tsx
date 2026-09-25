"use client";

import { ActionButton } from "@/components/action-button";
import { NativeSelect, type Row } from "@/components/figures";
import { ProjectAvatar } from "@/components/raise/project-avatar";
import { raiseInvalidations } from "@/components/raise/common";
import { Input } from "@/components/ui/input";
import {
  bestUnit,
  formatDurationValue,
  maxVetoNow,
  parseDuration,
  sameAddress,
  vetoBlock,
  vetoState,
  type AdminRole,
  type DurationUnit,
  type VetoEvent,
} from "@/lib/admin";
import { api, type RaiseDetail, type RaiseSummary } from "@/lib/api";
import { raiseAbi } from "@/lib/contracts";
import { queryKeys, useNow, useRaises, useTx } from "@/lib/hooks";
import type { RaiseModules } from "@/lib/use-admin";
import { useNumbers } from "@/lib/use-numbers";
import { cn, shortAddress } from "@/lib/utils";
import { useQueries } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useState } from "react";
import type { Address } from "viem";
import { AdminSection } from "./shared";

const vetoEventsKey = (raise: string) => ["veto-events", raise] as const;

/** `VetoChanged` events of a raise, from the indexed activity (newest first). */
async function vetoEvents(raise: string): Promise<VetoEvent[]> {
  const items = await api.activity(raise, 500);
  return items
    .filter((a) => a.kind === "VetoChanged")
    .map((a) => ({
      vetoUntil: Number(a.data.vetoUntil ?? 0),
      cumulativeDelay: BigInt(String(a.data.cumulativeDelay ?? 0)),
      timestamp: a.timestamp,
    }));
}

export function VetoesSection({
  roles,
  address,
  modules,
}: {
  roles: AdminRole[];
  address?: string;
  modules: Map<string, RaiseModules>;
}) {
  const t = useTranslations("admin.vetoes");
  const { data: raises, isLoading } = useRaises();
  const stage1 = (raises ?? []).filter((r) => r.phase === "Stage1");
  const details = useQueries({
    queries: stage1.map((r) => ({
      queryKey: queryKeys.raise(r.address),
      queryFn: () => api.raise(r.address),
      refetchInterval: 15_000,
    })),
  });
  const events = useQueries({
    queries: stage1.map((r) => ({
      queryKey: vetoEventsKey(r.address),
      queryFn: () => vetoEvents(r.address),
      refetchInterval: 15_000,
    })),
  });
  const shown = roles.filter((r): r is "attester" | "council" => r === "attester" || r === "council");
  return (
    <AdminSection id="vetoes" title={t("title")} description={t("description")} roles={shown}>
      {isLoading ? (
        <div className="surface-1 space-y-3 p-5" aria-busy>
          <div className="skeleton h-16" />
          <div className="skeleton h-16" />
        </div>
      ) : stage1.length === 0 ? (
        <p className="surface-1 px-5 py-6 text-sm text-fg-2">{t("empty")}</p>
      ) : (
        <ul className="surface-1 divide-y divide-fg/[0.07]">
          {stage1.map((r, i) => (
            <VetoRow
              key={r.address}
              summary={r}
              detail={details[i]?.data}
              events={events[i]?.data}
              modules={modules.get(r.address.toLowerCase())}
              address={address}
              roles={roles}
            />
          ))}
        </ul>
      )}
    </AdminSection>
  );
}

function VetoRow({
  summary: r,
  detail,
  events,
  modules,
  address,
  roles,
}: {
  summary: RaiseSummary;
  detail?: RaiseDetail;
  events?: VetoEvent[];
  modules?: RaiseModules;
  address?: string;
  roles: AdminRole[];
}) {
  const t = useTranslations("admin.vetoes");
  const ta = useTranslations("analyst");
  const checking = useTranslations("admin")("checking");
  const n = useNumbers();
  const now = useNow();
  const { send, pending } = useTx();
  const [draft, setDraft] = useState<{ value: string; unit: DurationUnit } | null>(null);
  const params = detail?.governance.config.parameters;
  const loaded = Boolean(detail && events && params && now);
  const state =
    detail && events && params
      ? vetoState({
          events,
          vetoTotal: BigInt(params.vetoTotal),
          vetoCooldown: BigInt(params.vetoCooldown),
          stage1Max: params.stage1Max !== undefined ? BigInt(params.stage1Max) : null,
          start: detail.deadlines.start,
          vetoUntil: detail.deadlines.vetoUntil,
          now,
        })
      : null;
  const vetoMax = params ? BigInt(params.vetoMax) : 0n;
  const maxNow = state ? maxVetoNow({ phase: r.phase, state, vetoMax, now }) : 0n;
  const unit: DurationUnit = draft?.unit ?? (maxNow > 0n ? bestUnit(maxNow) : "hour");
  const value = draft?.value ?? (maxNow > 0n ? (formatDurationValue(maxNow, unit) ?? "") : "");
  const delay = parseDuration(value, unit);
  const report = detail?.latestReport ?? null;
  const isAttester = sameAddress(address, modules?.attester);
  const isCouncil = sameAddress(address, modules?.council);
  const block = state ? vetoBlock({ phase: r.phase, state, vetoMax, delay, now }) : null;
  const applyReason = !loaded
    ? checking
    : !isAttester
      ? t("reasons.notAttester")
      : !report
        ? t("reasons.noReport")
        : block
          ? t(`reasons.${block.key}`, {
              date: block.key === "cooldown" ? n.date(block.until) : "",
              value:
                block.key === "aboveMax"
                  ? n.duration(Number(block.max))
                  : block.key === "budget"
                    ? n.duration(Number(block.remaining))
                    : "",
            })
          : null;
  const clearReason = !loaded
    ? checking
    : !isCouncil
      ? t("reasons.notCouncil")
      : !state?.active
        ? t("reasons.noActive")
        : null;
  const invalidate = [...raiseInvalidations(r.address), vetoEventsKey(r.address)];
  const usedPct = state && state.total > 0n ? Number((state.used * 10_000n) / state.total) / 100 : 0;

  async function apply() {
    if (applyReason || !delay || !report) return;
    const preview: Row[] = [
      [t("delay"), n.duration(Number(delay)), "total"],
      [t("report"), shortAddress(report.reportHash, 8), "meta"],
    ];
    await send(
      { address: r.address as Address, abi: raiseAbi, functionName: "veto", args: [delay, report.reportHash] },
      { label: `${t("apply")} · ${r.profile.name || r.name}`, preview, invalidate, onSuccess: () => setDraft(null) },
    );
  }
  async function clear() {
    if (clearReason) return;
    await send(
      { address: r.address as Address, abi: raiseAbi, functionName: "clearVeto", args: [] },
      { label: `${t("clear")} · ${r.profile.name || r.name}`, preview: [], invalidate },
    );
  }

  return (
    <li
      className="grid gap-5 p-5 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)_minmax(0,1.1fr)] lg:gap-8"
      data-testid={`veto-${r.symbol}`}
    >
      {/* Identity and the report a veto would cite */}
      <div className="min-w-0 space-y-3">
        <Link href={`/raise/${r.address}`} className="group flex min-w-0 items-center gap-3">
          <ProjectAvatar symbol={r.symbol} profile={r.profile} />
          <span className="min-w-0">
            <span className="block truncate text-sm font-medium group-hover:underline">{r.profile.name || r.name}</span>
            <span className="block font-mono text-2xs text-fg-3">{r.symbol}</span>
          </span>
        </Link>
        <div className="space-y-1.5">
          <p className="text-xs text-fg-3">{t("report")}</p>
          {report ? (
            <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs">
              <span className="num text-sm font-medium text-fg">{n.pct(report.riskScoreBps)}</span>
              <span
                className={cn(
                  "rounded-full px-2 py-0.5 text-2xs font-medium",
                  report.veto ? "bg-negative/10 text-negative" : "bg-fg/[0.06] text-fg-2",
                )}
              >
                {ta(report.veto ? "veto" : "noVeto")}
              </span>
              <span className="num text-fg-3">{n.date(report.createdAt)}</span>
              <span className="w-full font-mono text-2xs text-fg-3" title={report.reportHash}>
                {t("cites", { hash: shortAddress(report.reportHash, 6) })}
              </span>
            </div>
          ) : detail ? (
            <p className="text-xs text-fg-2">{t("noReport")}</p>
          ) : (
            <div className="skeleton h-4 w-40" />
          )}
        </div>
      </div>

      {/* Budget, cooldown and the current veto */}
      <div className="min-w-0 space-y-3" data-testid={`veto-state-${r.symbol}`}>
        <div>
          <div className="flex items-baseline justify-between gap-3 text-xs">
            <span className="text-fg-3">{t("budget")}</span>
            {state ? (
              <span className="num text-fg-2">
                {t("used", {
                  used: state.used === 0n ? n.number(0, 0) : n.duration(Number(state.used)),
                  total: n.duration(Number(state.total)),
                })}
              </span>
            ) : null}
          </div>
          <div className="mt-2 h-[3px] overflow-hidden rounded-full bg-fg/[0.07]">
            <div
              className="h-full rounded-full bg-fg transition-[width] duration-500 ease-out"
              style={{ width: `${Math.min(100, usedPct)}%` }}
            />
          </div>
        </div>
        {state ? (
          <ul className="space-y-1.5 text-xs">
            <li
              className={cn("flex items-center gap-2", state.active ? "text-negative" : "text-fg-2")}
              data-testid={`veto-active-${r.symbol}`}
            >
              <span aria-hidden className={cn("size-1.5 rounded-full", state.active ? "bg-negative" : "bg-fg/25")} />
              <span className="num">
                {state.active ? t("activeUntil", { date: n.date(detail!.deadlines.vetoUntil) }) : t("inactive")}
              </span>
            </li>
            <li className="flex items-center gap-2 text-fg-2">
              <span aria-hidden className="size-1.5 rounded-full bg-fg/25" />
              <span className="num">
                {now < state.cooldownUntil ? t("cooldown", { date: n.date(state.cooldownUntil) }) : t("ready")}
              </span>
            </li>
          </ul>
        ) : (
          <div className="skeleton h-9" />
        )}
      </div>

      {/* Actions, each gated on this raise's own pinned attester or council */}
      <div className="min-w-0 space-y-3">
        {roles.includes("attester") ? (
          <div className="space-y-2">
            <label
              htmlFor={`delay-${r.symbol}`}
              className="flex items-baseline justify-between gap-3 text-xs text-fg-2"
            >
              <span>{t("delay")}</span>
              {maxNow > 0n ? (
                <span className="num text-fg-3">{t("upTo", { value: n.duration(Number(maxNow)) })}</span>
              ) : null}
            </label>
            <div className="flex gap-2">
              <Input
                id={`delay-${r.symbol}`}
                data-testid={`veto-delay-${r.symbol}`}
                inputMode="decimal"
                className="num"
                value={value}
                disabled={!isAttester}
                onChange={(e) => setDraft({ value: e.target.value.replace(",", "."), unit })}
              />
              <NativeSelect
                aria-label={t("delay")}
                className="w-28 shrink-0"
                value={unit}
                disabled={!isAttester}
                onChange={(e) => {
                  const next = e.target.value as DurationUnit;
                  const seconds = parseDuration(value, unit);
                  setDraft({
                    unit: next,
                    value: (seconds !== null ? formatDurationValue(seconds, next) : null) ?? value,
                  });
                }}
              >
                <UnitOptions />
              </NativeSelect>
            </div>
            <ActionButton
              className="w-full"
              data-testid={`veto-apply-${r.symbol}`}
              label={t("apply")}
              pending={pending}
              reason={applyReason}
              onClick={apply}
            />
          </div>
        ) : null}
        {roles.includes("council") ? (
          <ActionButton
            className="w-full"
            variant="outline"
            data-testid={`veto-clear-${r.symbol}`}
            label={t("clear")}
            pending={pending}
            reason={clearReason}
            onClick={clear}
          />
        ) : null}
      </div>
    </li>
  );
}

function UnitOptions() {
  const t = useTranslations("admin.params.units");
  return (
    <>
      <option value="minute">{t("minute")}</option>
      <option value="hour">{t("hour")}</option>
      <option value="day">{t("day")}</option>
    </>
  );
}
