"use client";

import { TestnetRibbon } from "@/components/testnet-timing";
import { useApiConfig } from "@/lib/hooks";
import { LAUNCH_TYPES, type LaunchTemplate } from "@/lib/launch-types";
import { currentTemplates, isShortened } from "@/lib/testnet-timing";
import { cn } from "@/lib/utils";
import { Check } from "lucide-react";
import { useTranslations } from "next-intl";

export function TypeChoice({ value, onChange }: { value: LaunchTemplate; onChange: (value: LaunchTemplate) => void }) {
  const t = useTranslations("types");
  const tc = useTranslations("create");
  const { data: config } = useApiConfig();
  const current = currentTemplates(config?.templates);
  return (
    <fieldset data-testid="type-choice">
      <legend className="mb-5 text-sm text-fg-2">{tc("typeHint")}</legend>
      <div className="grid gap-4 md:grid-cols-2">
        {LAUNCH_TYPES.map(({ key, template }) => (
          <label key={key} className="relative flex cursor-pointer">
            <input
              type="radio"
              name="launch-type"
              value={template}
              checked={value === template}
              onChange={() => onChange(template)}
              aria-labelledby={`type-${key}-name`}
              aria-describedby={`type-${key}-definition type-${key}-boundary`}
              className="peer sr-only"
            />
            <div className="relative flex w-full flex-col gap-5 rounded-xl border border-hairline bg-surface-1 p-5 transition-colors hover:border-hairline-strong peer-checked:border-fg peer-checked:bg-surface-2 peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-4 peer-focus-visible:outline-fg sm:p-6">
              <TestnetRibbon pinned={current.find((x) => x.name === template)?.parameters} />
              {/* The selection mark leads the title, keeping the top-right corner free for the testnet ribbon. */}
              <div className="flex items-center gap-3 pr-16">
                <span className="flex size-5 shrink-0 items-center justify-center rounded-full border border-hairline-strong">
                  {value === template ? <Check className="size-3.5" aria-hidden /> : null}
                </span>
                <span
                  id={`type-${key}-name`}
                  className={key === "sealed" ? "text-xl font-medium text-fg" : "text-xl font-medium text-risk"}
                >
                  {t(`${key}.title`)}
                </span>
              </div>
              <p
                id={`type-${key}-definition`}
                className={cn(
                  "num text-sm leading-relaxed text-fg-2",
                  isShortened(current.find((x) => x.name === template)?.parameters) && "pr-8",
                )}
              >
                {t(`${key}.definition`)}
              </p>
              <dl className="flex-1 space-y-4 border-t border-hairline pt-5 text-sm">
                <div>
                  <dt className="mb-1 font-medium">{tc("builderGets")}</dt>
                  <dd className="leading-relaxed text-fg-2">{t(`${key}.builderGets`)}</dd>
                </div>
                <div>
                  <dt className="mb-1 font-medium">{tc("suitedTo")}</dt>
                  <dd className="leading-relaxed text-fg-2">{t(`${key}.suitedTo`)}</dd>
                </div>
              </dl>
              <p
                id={`type-${key}-boundary`}
                className="border-t border-hairline pt-4 text-xs leading-relaxed text-fg-2"
              >
                {t(`${key}.boundary`)}
              </p>
            </div>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
