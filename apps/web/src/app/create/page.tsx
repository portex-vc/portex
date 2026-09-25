"use client";
import { TypeChoice } from "@/components/create/type-choice";
import { TestnetTimingNote } from "@/components/testnet-timing";
import { TypeBadge } from "@/components/raise/type-badge";
import { LaunchPreview } from "@/components/create/launch-preview";
import { ProjectImageField } from "@/components/builder/image-upload";
import { Segmented } from "@/components/figures";
import { ActionButton } from "@/components/action-button";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  DEFAULT_FORM,
  STEPS,
  scheduleUnits,
  stageBoundsFor,
  validateCreation,
  priceOf,
  type FormState,
  type Field,
} from "@/lib/create-form";
import { useCreateRaise } from "@/lib/use-create-raise";
import { useNumbers } from "@/lib/use-numbers";
import { cn } from "@/lib/utils";
import { useFormatter, useLocale, useTranslations } from "next-intl";
import { Check } from "lucide-react";
import { displayAmountInput, normalizeAmountEdit } from "@/lib/amount-input";
import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { useConnectedAddress } from "@/lib/hooks";
export default function CreatePage() {
  const t = useTranslations("create"),
    v = useTranslations("v31"),
    n = useNumbers();
  const locale = useLocale();
  const format = useFormatter();
  const display = (key: Field): string => {
    const value = form[key];
    if (!value.trim()) return key === "builders" ? v("none") : "—";
    const num = Number(value);
    switch (key) {
      case "supply":
        return `${n.number(num, 8)} ${form.symbol || ""}`.trim();
      case "targetPrice":
      case "targetValuation":
        return `${n.number(num, 8)} USDG`;
      case "stage1Days":
        return format.number(num, { style: "unit", unit: units.stage1 === 3600 ? "hour" : "day", unitDisplay: "long" });
      case "stage2Weeks":
        return format.number(num, {
          style: "unit",
          unit: units.stage2 === 3600 ? "hour" : "week",
          unitDisplay: "long",
        });
      case "budgetCeiling":
        return format.number(num / 100, { style: "percent", maximumFractionDigits: 2 });
      case "builders":
        return value
          .split(/[\s,]+/)
          .filter(Boolean)
          .join("\n");
      default:
        return value;
    }
  };
  const numeric: Field[] = ["supply", "targetPrice", "targetValuation", "budgetCeiling", "stage1Days", "stage2Weeks"];
  const search = useSearchParams();
  const address = useConnectedAddress();
  const [form, setForm] = useState<FormState>({
    ...DEFAULT_FORM,
    templateName: search.get("type") === "milestone" ? "BUDGET_LAUNCH" : "ESCROW_LAUNCH",
  });
  const [step, setStep] = useState(0);
  const [touched, setTouched] = useState<Set<Field>>(() => new Set());
  const touch = (field: Field) => setTouched((prev) => (prev.has(field) ? prev : new Set(prev).add(field)));
  const create = useCreateRaise(form);
  const units = scheduleUnits(create.apiConfig, form.templateName);
  const bounds = stageBoundsFor(create.apiConfig, form.templateName);
  useEffect(() => {
    setForm((previous) => ({
      ...previous,
      stage1Days: units.stage1 === 3600 ? "24" : DEFAULT_FORM.stage1Days,
      stage2Weeks: units.stage2 === 3600 ? "48" : DEFAULT_FORM.stage2Weeks,
    }));
  }, [units.stage1, units.stage2]);
  const fieldLabel = (field: Field) =>
    v(
      field === "stage1Days" && units.stage1 === 3600
        ? "stage1Hours"
        : field === "stage2Weeks" && units.stage2 === 3600
          ? "stage2Hours"
          : field,
    );
  const errors = validateCreation(form, create.apiConfig);
  const set = (field: Field, value: string) => {
    touch(field);
    setForm((prev) => ({ ...prev, [field]: value }));
  };
  const template = create.apiConfig?.templates.find((x) => x.name === form.templateName && !x.deprecated);
  const fields: Field[] =
    step === 1
      ? ["name", "symbol", "description", "website"]
      : step === 2
        ? ["supply", form.targetMode === "price" ? "targetPrice" : "targetValuation"]
        : step === 3
          ? ["stage1Days", "stage2Weeks"]
          : ["builders", ...(form.templateName === "BUDGET_LAUNCH" ? ["budgetCeiling" as const] : [])];
  const review: Field[] = [
    "name",
    "symbol",
    "supply",
    form.targetMode === "price" ? "targetPrice" : "targetValuation",
    "stage1Days",
    "stage2Weeks",
    "builders",
    ...(form.templateName === "BUDGET_LAUNCH" ? ["budgetCeiling" as const] : []),
  ];
  return (
    <div className="space-y-8 pt-2 lg:pt-4">
      <header className="space-y-2">
        <h1 className="t-title">{t("title")}</h1>
        <p className="max-w-2xl text-[0.9375rem] leading-relaxed text-fg-2">{v("createIntro")}</p>
      </header>
      <nav aria-label={t("stepsLabel")}>
        <ol className="grid grid-cols-3 gap-x-3 sm:grid-cols-6">
          {STEPS.map((key, i) => {
            const invalid = i > 0 && i < step && errors.some((e) => e.step === i);
            const done = i < step && !invalid;
            return (
              <li key={key}>
                <button
                  type="button"
                  data-testid={`create-step-${key}`}
                  onClick={() => setStep(i)}
                  aria-current={i === step ? "step" : undefined}
                  title={invalid ? v("stepError") : done ? v("stepDone") : undefined}
                  className={cn(
                    "flex w-full flex-col gap-1 border-t-2 py-3 text-left text-[0.8125rem] transition-colors duration-200 sm:flex-row sm:items-center sm:gap-2",
                    i === step
                      ? "border-fg text-fg"
                      : invalid
                        ? "border-negative/60 text-negative"
                        : done
                          ? "border-fg/40 text-fg-2 hover:text-fg"
                          : "border-fg/[0.08] text-fg-3 hover:text-fg-2",
                  )}
                >
                  <span className="num inline-flex items-center gap-1 font-mono">
                    {done ? <Check className="size-3" aria-hidden /> : null}0{i + 1}
                  </span>
                  <span>{t(`steps.${key}`)}</span>
                </button>
              </li>
            );
          })}
        </ol>
      </nav>
      <div className={cn("grid items-start gap-8", step > 0 && "lg:grid-cols-[minmax(0,1fr)_21rem] xl:gap-12")}>
        <section className="surface-1 min-w-0 p-5 sm:p-7">
          <div className="mb-6 flex flex-wrap items-center gap-3">
            <h2 className="t-section">{t(`steps.${STEPS[step]}`)}</h2>
            {step > 0 ? <TypeBadge template={form.templateName} /> : null}
          </div>
          {step === 0 ? (
            <TypeChoice value={form.templateName} onChange={(value) => set("templateName", value)} />
          ) : step === 5 ? (
            <div className="space-y-5">
              <p className="text-sm text-fg-2">{t("reviewHint")}</p>
              <dl className="divide-y divide-fg/[0.07] border-y border-fg/[0.07]" data-testid="create-review">
                <div className="flex justify-between gap-4 py-3 text-sm">
                  <dt className="min-w-0 flex-1 text-fg-2">{v("reviewLabel.templateName")}</dt>
                  <dd>
                    <TypeBadge template={form.templateName} />
                  </dd>
                </div>
                {review.map((key) => (
                  <div className="flex justify-between gap-4 py-3 text-sm" key={key}>
                    <dt className="min-w-0 flex-1 text-fg-2">
                      {key === "stage1Days" || key === "stage2Weeks" ? fieldLabel(key) : v(`reviewLabel.${key}`)}
                    </dt>
                    <dd
                      className={cn(
                        "num max-w-[60%] shrink-0 whitespace-pre-line break-all text-right",
                        key === "builders" && "font-mono text-xs",
                        errors.some((e) => e.field === key) && "text-negative",
                      )}
                    >
                      {display(key)}
                    </dd>
                  </div>
                ))}
                {form.targetMode === "valuation" && priceOf(form) > 0n ? (
                  <div className="flex justify-between gap-4 py-3 text-sm">
                    <dt className="min-w-0 flex-1 text-fg-2">{v("derivedPrice")}</dt>
                    <dd className="num text-right">{n.price(priceOf(form))} USDG</dd>
                  </div>
                ) : null}
              </dl>
              <p className="text-xs text-fg-2">
                {v("minimumBackers")} · {template?.parameters.minimumBackers ?? "—"} · {v("minimumPinned")}
              </p>
              {errors.length ? (
                <ul className="space-y-2 text-xs text-negative">
                  {errors.map((e, i) => (
                    <li key={i}>
                      <button className="text-left underline" onClick={() => setStep(e.step)}>
                        {fieldLabel(e.field)}
                        {locale === "zh" ? "：" : ": "}
                        {v(e.key)}
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-xs text-positive">{t("valid")}</p>
              )}
              <ActionButton
                className="w-full"
                data-testid="create-submit"
                label={t(create.created ? "retryMetadata" : "submit")}
                reason={!address ? v("connect") : errors.length ? t("fixErrors") : create.chainReason}
                pending={create.pending}
                onClick={create.submit}
              />
            </div>
          ) : (
            <div className="space-y-5">
              {step === 2 ? (
                <div className="max-w-sm space-y-2">
                  <p className="text-xs text-fg-2">{v("targetMode")}</p>
                  <Segmented
                    label={v("targetMode")}
                    value={form.targetMode as "valuation" | "price"}
                    options={[
                      { value: "valuation", label: t("modeValuation") },
                      { value: "price", label: t("modePrice") },
                    ]}
                    testId={(x) => `target-mode-${x}`}
                    onChange={(x) => set("targetMode", x)}
                  />
                </div>
              ) : null}
              <div className="grid gap-5 sm:grid-cols-2">
                {fields.map((field) => {
                  const error = errors.find((e) => e.field === field);
                  return (
                    <label
                      key={field}
                      className={cn(
                        "block space-y-2 text-xs text-fg-2",
                        ["description", "builders"].includes(field) && "sm:col-span-2",
                      )}
                    >
                      <span>{fieldLabel(field)}</span>
                      {field === "description" || field === "builders" ? (
                        <Textarea
                          id={`create-${field}`}
                          onBlur={() => touch(field)}
                          aria-invalid={Boolean(error && touched.has(field)) || undefined}
                          value={numeric.includes(field) ? displayAmountInput(form[field], locale) : form[field]}
                          onChange={(e) =>
                            set(
                              field,
                              numeric.includes(field) ? normalizeAmountEdit(e.target.value, locale) : e.target.value,
                            )
                          }
                        />
                      ) : (
                        <Input
                          id={`create-${field}`}
                          onBlur={() => touch(field)}
                          aria-invalid={Boolean(error && touched.has(field)) || undefined}
                          value={numeric.includes(field) ? displayAmountInput(form[field], locale) : form[field]}
                          onChange={(e) =>
                            set(
                              field,
                              numeric.includes(field) ? normalizeAmountEdit(e.target.value, locale) : e.target.value,
                            )
                          }
                        />
                      )}{" "}
                      {error && touched.has(field) ? (
                        <span className="block text-negative" role="alert">
                          {v(error.key)}
                        </span>
                      ) : field === "supply" || field === "targetValuation" || field === "targetPrice" ? (
                        <span className="block leading-relaxed text-fg-3">{t(`hints.${field}`)}</span>
                      ) : null}
                    </label>
                  );
                })}
              </div>
              {step === 1 ? (
                <ProjectImageField
                  symbol={form.symbol.trim() || "?"}
                  imageUrl={form.imageUrl || null}
                  disabled={!address || create.pending}
                  onChange={(next) =>
                    setForm((prev) => ({ ...prev, image: next?.uri ?? "", imageUrl: next?.url ?? "" }))
                  }
                />
              ) : null}
              {step === 3 && bounds ? (
                <div className="space-y-1.5">
                  <p className="text-xs text-fg-2" data-testid="stage-bounds">
                    {v("stageBounds", {
                      stage1: n.durationRange(bounds.stage1Min, bounds.stage1Max),
                      stage2: n.durationRange(bounds.stage2Min, bounds.stage2Max),
                    })}
                  </p>
                  {/* Right beside the bounds: why they run in minutes on this testnet. */}
                  <TestnetTimingNote variant="hint" pinned={template?.parameters} />
                </div>
              ) : null}
              {step === 3 ? (
                <p className="text-xs text-fg-2">
                  {v("minimumBackers")} · {template?.parameters.minimumBackers ?? "—"} · {v("minimumPinned")}
                </p>
              ) : null}
              {step === 4 ? <p className="text-xs text-fg-2">{v("buildersHint")}</p> : null}
              {step === 4 ? (
                <div
                  className="rounded-[12px] border border-fg/[0.08] bg-fg/[0.02] px-4 py-3.5"
                  data-testid="treasury-note"
                >
                  <p className="text-sm font-medium">{v("treasuryTitle")}</p>
                  <p className="mt-1 text-xs leading-relaxed text-fg-2">
                    {v("treasuryIntro")}{" "}
                    {v("treasuryBeforeListing", {
                      period: n.period(
                        Number(
                          template?.parameters.treasuryVesting ?? template?.treasury?.vestingDuration ?? 157680000,
                        ),
                      ),
                    })}
                  </p>
                </div>
              ) : null}
            </div>
          )}
          <div className="mt-8 flex justify-between gap-3 border-t border-fg/[0.07] pt-5">
            {step > 0 ? (
              <Button variant="outline" onClick={() => setStep(step - 1)}>
                {t("back")}
              </Button>
            ) : (
              <span />
            )}
            {step < 5 ? (
              <ActionButton
                data-testid="create-next"
                label={t("next")}
                reason={errors.some((e) => e.step === step) ? t("fixStep") : null}
                onClick={() => setStep(step + 1)}
              />
            ) : null}
          </div>
        </section>
        {step > 0 ? <LaunchPreview form={form} config={create.apiConfig} /> : null}
      </div>
    </div>
  );
}
