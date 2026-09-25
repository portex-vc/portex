"use client";

import { ActionButton } from "@/components/action-button";
import { NativeSelect, type Row } from "@/components/figures";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  bestUnit,
  diffParameters,
  DURATION_KEYS,
  FIXED_KEYS,
  formatDurationValue,
  formatFixed,
  PARAMETER_GROUPS,
  parametersArg,
  parseDuration,
  parseFixed,
  toParameters,
  validateParameters,
  type DurationUnit,
  type ParameterKey,
  type ProtocolParameters,
} from "@/lib/admin";
import { appChain } from "@/lib/chains";
import { registryAbi } from "@/lib/contracts";
import { queryKeys, useTx } from "@/lib/hooks";
import { useNumbers } from "@/lib/use-numbers";
import { cn } from "@/lib/utils";
import { Info, Lock, Pencil, RotateCcw } from "lucide-react";
import { useTranslations } from "next-intl";
import { useMemo, useState } from "react";
import type { Address } from "viem";
import { useReadContract } from "wagmi";
import { AdminSection, Fact } from "./shared";

type Draft = Partial<Record<ParameterKey, { value: string; unit?: DurationUnit }>>;
const isDuration = (key: ParameterKey) => (DURATION_KEYS as readonly string[]).includes(key);
const isFixed = (key: ParameterKey) => (FIXED_KEYS as readonly string[]).includes(key);

/** Human rendering of one parameter value: durations, ×, % and counts. */
export function useParameterFormat() {
  const n = useNumbers();
  return (key: ParameterKey, value: bigint | number): string => {
    if (isDuration(key)) return n.duration(Number(value));
    if (key === "kappaMax") return `${n.number(Number(formatFixed(BigInt(value))), 4)}×`;
    if (key === "budgetCeilingMax") return n.pct(Number((BigInt(value) * 10_000n) / 10n ** 18n));
    if (key === "tradeFeeBps" || key === "surchargeBps") return n.pct(Number(value));
    return n.number(Number(value), 0);
  };
}

/** The live `protocolParameters()` of the registry. */
export function useProtocolParameters(registry?: string) {
  const read = useReadContract({
    address: registry as Address | undefined,
    abi: registryAbi,
    functionName: "protocolParameters",
    chainId: appChain.id,
    query: { enabled: Boolean(registry), staleTime: 15_000 },
  });
  return {
    parameters: toParameters(read.data),
    isLoading: read.isLoading,
    isError: read.isError,
    refetch: read.refetch,
  };
}

function draftFrom(p: ProtocolParameters): Draft {
  const draft: Draft = {};
  for (const key of DURATION_KEYS) {
    const unit = bestUnit(p[key]);
    draft[key] = { value: formatDurationValue(p[key], unit) ?? String(p[key] / 60n), unit };
  }
  draft.kappaMax = { value: formatFixed(p.kappaMax) };
  draft.budgetCeilingMax = { value: formatFixed(p.budgetCeilingMax, 16) };
  return draft;
}

/** Parse the draft; per-field input errors come first, then the registry's rules. */
function parseDraft(current: ProtocolParameters, draft: Draft) {
  const inputErrors: Partial<Record<ParameterKey, string>> = {};
  const next: ProtocolParameters = { ...current };
  for (const key of DURATION_KEYS) {
    const d = draft[key];
    if (!d) continue;
    if (!/^\d+(\.\d+)?$/.test(d.value.trim())) inputErrors[key] = "number";
    else {
      const seconds = parseDuration(d.value, d.unit ?? "day");
      if (seconds === null) inputErrors[key] = "wholeSeconds";
      else next[key] = seconds;
    }
  }
  const kappa = draft.kappaMax ? parseFixed(draft.kappaMax.value) : current.kappaMax;
  if (kappa === null) inputErrors.kappaMax = "number";
  else next.kappaMax = kappa;
  const budget = draft.budgetCeilingMax ? parseFixed(draft.budgetCeilingMax.value, 16) : current.budgetCeilingMax;
  if (budget === null) inputErrors.budgetCeilingMax = "number";
  else next.budgetCeilingMax = budget;
  // Unreadable fields keep their current value, so the registry's rules still check everything else.
  const errors: Partial<Record<ParameterKey, string>> = { ...inputErrors };
  for (const e of validateParameters(next)) errors[e.field] ??= e.key;
  return { next, errors, valid: Object.keys(errors).length === 0 };
}

export function ParametersSection({ registry, canEdit }: { registry: string; canEdit: boolean }) {
  const t = useTranslations("admin.params");
  const ta = useTranslations("admin");
  const format = useParameterFormat();
  const { parameters: current, isLoading, refetch } = useProtocolParameters(registry);
  const { send, pending } = useTx();
  const [draft, setDraft] = useState<Draft | null>(null);
  const editing = draft !== null && current !== null;
  const parsed = useMemo(() => (editing ? parseDraft(current, draft) : null), [editing, current, draft]);
  const changed = parsed && current ? diffParameters(current, parsed.next) : [];

  const set = (key: ParameterKey, patch: { value?: string; unit?: DurationUnit }) =>
    setDraft((d) => {
      if (!d) return d;
      const before = d[key] ?? { value: "" };
      // Switching the unit keeps the duration when it converts exactly (90 minutes → 1.5 hours).
      if (patch.unit && before.unit && patch.value === undefined) {
        const seconds = parseDuration(before.value, before.unit);
        const value = seconds !== null ? formatDurationValue(seconds, patch.unit) : null;
        return { ...d, [key]: { unit: patch.unit, value: value ?? before.value } };
      }
      return { ...d, [key]: { ...before, ...patch } };
    });

  async function submit() {
    if (!parsed?.valid || !current || !changed.length) return;
    const preview: Row[] = changed.map((key) => [
      t(`fields.${key}`),
      `${format(key, current[key])} → ${format(key, parsed.next[key])}`,
    ]);
    await send(
      {
        address: registry as Address,
        abi: registryAbi,
        functionName: "setProtocolParameters",
        args: [parametersArg(parsed.next)],
      },
      {
        label: t("submit"),
        preview,
        invalidate: [queryKeys.config],
        onSuccess: async () => {
          await refetch();
          setDraft(null);
        },
      },
    );
  }

  return (
    <AdminSection
      id="parameters"
      title={t("title")}
      description={t("description")}
      roles={["curator"]}
      aside={
        canEdit && current && !editing ? (
          <Button
            variant="outline"
            size="sm"
            data-testid="edit-parameters"
            onClick={() => setDraft(draftFrom(current))}
          >
            <Pencil className="!size-3.5" />
            {t("edit")}
          </Button>
        ) : null
      }
    >
      <div className="surface-1 p-5 sm:p-6">
        {isLoading || !current ? (
          <div className="grid gap-8 md:grid-cols-2 xl:grid-cols-3" aria-busy>
            {[0, 1, 2].map((i) => (
              <div key={i} className="space-y-3">
                <div className="skeleton h-3 w-24" />
                <div className="skeleton h-4 w-full" />
                <div className="skeleton h-4 w-full" />
                <div className="skeleton h-4 w-4/5" />
              </div>
            ))}
          </div>
        ) : (
          <div className="grid gap-x-10 gap-y-8 md:grid-cols-2 xl:grid-cols-3" data-testid="parameters-grid">
            {PARAMETER_GROUPS.map((group) => (
              <fieldset key={group.key} className="min-w-0">
                <legend className="micro mb-2">{t(`groups.${group.key}`)}</legend>
                {editing && group.key === "fixed" ? (
                  <div className="space-y-2 pt-1">
                    <dl className="divide-y divide-fg/[0.06]">
                      {group.fields.map((key) => (
                        <Fact key={key} label={t(`fields.${key}`)}>
                          <span className="inline-flex items-center gap-1.5">
                            <Lock className="size-3 text-fg-3" aria-hidden />
                            {format(key, current[key])}
                          </span>
                        </Fact>
                      ))}
                    </dl>
                    <p className="text-2xs leading-relaxed text-fg-3">{t("fixedHint")}</p>
                  </div>
                ) : editing ? (
                  <div className="space-y-4 pt-1">
                    {group.fields.map((key) => (
                      <ParameterInput
                        key={key}
                        field={key}
                        label={t(`fields.${key}`)}
                        draft={draft[key]}
                        current={format(key, current[key])}
                        changed={changed.includes(key)}
                        error={parsed?.errors[key] ? t(`errors.${parsed.errors[key]}`) : null}
                        units={t.raw("units") as Record<DurationUnit, string>}
                        onChange={(patch) => set(key, patch)}
                      />
                    ))}
                  </div>
                ) : (
                  <dl className="divide-y divide-fg/[0.06]">
                    {group.fields.map((key) => (
                      <Fact key={key} label={t(`fields.${key}`)}>
                        <span className="inline-flex items-center gap-1.5" data-testid={`param-${key}`}>
                          {isFixed(key) ? <Lock className="size-3 text-fg-3" aria-hidden /> : null}
                          {format(key, current[key])}
                        </span>
                      </Fact>
                    ))}
                  </dl>
                )}
              </fieldset>
            ))}
          </div>
        )}

        {editing && parsed ? (
          <div className="mt-8 grid gap-5 border-t border-fg/[0.07] pt-6 lg:grid-cols-[minmax(0,1fr)_18rem]">
            <div className="min-w-0" data-testid="parameters-diff">
              <p className="text-sm font-medium">{t("changes")}</p>
              {changed.length ? (
                <ul className="mt-3 divide-y divide-fg/[0.06] rounded-[12px] border border-fg/[0.08]">
                  {changed.map((key) => (
                    <li key={key} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-4 py-2.5">
                      <span className="text-xs text-fg-2">{t(`fields.${key}`)}</span>
                      <span className="num text-sm">
                        <span className="text-fg-3 line-through decoration-fg/30">{format(key, current[key])}</span>
                        <span className="mx-2 text-fg-3" aria-hidden>
                          →
                        </span>
                        <span className="font-medium text-fg">{format(key, parsed.next[key])}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-2 text-xs text-fg-3">{t("noChanges")}</p>
              )}
            </div>
            <div className="flex flex-col gap-2.5 lg:pt-7">
              <ActionButton
                className="w-full"
                data-testid="submit-parameters"
                label={t("submit")}
                pending={pending}
                reason={!parsed.valid ? t("fixErrors") : !changed.length ? t("noChanges") : null}
                onClick={submit}
              />
              <div className="flex gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  className="flex-1"
                  disabled={pending}
                  onClick={() => setDraft(draftFrom(current!))}
                >
                  <RotateCcw className="!size-3.5" />
                  {t("reset")}
                </Button>
                <Button variant="ghost" size="sm" className="flex-1" disabled={pending} onClick={() => setDraft(null)}>
                  {ta("cancel")}
                </Button>
              </div>
            </div>
          </div>
        ) : null}

        <p className="mt-6 flex gap-2.5 border-t border-fg/[0.07] pt-4 text-xs leading-relaxed text-fg-3">
          <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          {t("note")}
        </p>
      </div>
    </AdminSection>
  );
}

function ParameterInput({
  field,
  label,
  draft,
  current,
  changed,
  error,
  units,
  onChange,
}: {
  field: ParameterKey;
  label: string;
  draft?: { value: string; unit?: DurationUnit };
  current: string;
  changed: boolean;
  error: string | null;
  units: Record<DurationUnit, string>;
  onChange: (patch: { value?: string; unit?: DurationUnit }) => void;
}) {
  const id = `param-input-${field}`;
  const suffix = field === "kappaMax" ? "×" : field === "budgetCeilingMax" ? "%" : null;
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="flex items-baseline justify-between gap-3 text-xs text-fg-2">
        <span>{label}</span>
        {changed ? <span className="num text-2xs text-fg-3 line-through decoration-fg/30">{current}</span> : null}
      </label>
      <div className="flex gap-2">
        <span className="relative flex-1">
          <Input
            id={id}
            inputMode="decimal"
            data-testid={id}
            aria-invalid={Boolean(error) || undefined}
            aria-describedby={error ? `${id}-error` : undefined}
            className={cn("num", suffix && "pr-8", changed && !error && "border-fg/25")}
            value={draft?.value ?? ""}
            onChange={(e) => onChange({ value: e.target.value.replace(",", ".") })}
          />
          {suffix ? (
            <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm text-fg-3">
              {suffix}
            </span>
          ) : null}
        </span>
        {draft?.unit ? (
          <NativeSelect
            aria-label={`${label} · ${units[draft.unit]}`}
            className="w-28 shrink-0"
            value={draft.unit}
            onChange={(e) => onChange({ unit: e.target.value as DurationUnit })}
          >
            {(["minute", "hour", "day"] as const).map((u) => (
              <option key={u} value={u}>
                {units[u]}
              </option>
            ))}
          </NativeSelect>
        ) : null}
      </div>
      {error ? (
        <p id={`${id}-error`} role="alert" className="text-xs text-negative">
          {error}
        </p>
      ) : null}
    </div>
  );
}
