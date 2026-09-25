"use client";

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useTranslations } from "next-intl";

type GlossaryKey = "veto" | "bookPrice";

/**
 * A mechanism term with its glossary definition on hover/focus.
 * Dotted underline = "this word has a definition" — the one decoration we allow on text.
 */
export function Term({ k, children, className }: { k: GlossaryKey; children: React.ReactNode; className?: string }) {
  const t = useTranslations("glossary");
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          tabIndex={0}
          className={cn(
            "cursor-help underline decoration-dotted decoration-hairline-strong underline-offset-[3px] hover:decoration-fg-2",
            className,
          )}
        >
          {children}
        </span>
      </TooltipTrigger>
      <TooltipContent>{t(k)}</TooltipContent>
    </Tooltip>
  );
}

/** Small "?" affordance for labels that are not a full sentence. */
export function Hint({ text, className }: { text: React.ReactNode; className?: string }) {
  const t = useTranslations("common");
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          tabIndex={0}
          aria-label={t("moreInformation")}
          className={cn(
            "inline-flex size-3.5 cursor-help items-center justify-center rounded-full border border-hairline-strong text-[9px] leading-none text-fg-3 hover:text-fg-2",
            className,
          )}
        >
          ?
        </span>
      </TooltipTrigger>
      <TooltipContent>{text}</TooltipContent>
    </Tooltip>
  );
}
