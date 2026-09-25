"use client";

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { launchTypeKey, type LaunchTemplate } from "@/lib/launch-types";
import { cn } from "@/lib/utils";
import { useTranslations } from "next-intl";

export function TypeBadge({ template }: { template: LaunchTemplate }) {
  const t = useTranslations("types");
  const key = launchTypeKey(template);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          tabIndex={0}
          data-testid="type-badge"
          data-type={key}
          className={cn(
            "inline-flex shrink-0 cursor-help items-center rounded-full px-2 py-0.5 text-2xs font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-fg",
            key === "sealed" ? "bg-surface-3 text-fg-2" : "bg-risk/10 text-risk",
          )}
        >
          {t(`${key}.name`)}
        </span>
      </TooltipTrigger>
      <TooltipContent className="num">{t(`${key}.definition`)}</TooltipContent>
    </Tooltip>
  );
}

export function ProtectionBoundary({ template, className }: { template: LaunchTemplate; className?: string }) {
  const t = useTranslations("types");
  return (
    <p className={cn("text-xs leading-relaxed text-fg-2", className)} data-testid="protection-boundary">
      {t(`${launchTypeKey(template)}.boundary`)}
    </p>
  );
}
