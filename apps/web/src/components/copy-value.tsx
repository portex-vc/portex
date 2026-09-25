"use client";

import { Check, Copy } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";

/** Copy-to-clipboard value; `display` shows a shortened form while the full value is copied. */
export function CopyValue({ value, display }: { value: string; display?: string }) {
  const t = useTranslations("common");
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="inline-flex max-w-full items-start gap-2 rounded text-left font-mono text-2xs text-fg-2 hover:text-fg"
      aria-label={`${t(copied ? "copied" : "copy")}: ${value}`}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
        } catch {
          setCopied(false);
        }
      }}
    >
      <span className="break-all" title={display ? value : undefined}>
        {display ?? value}
      </span>
      {copied ? <Check className="mt-0.5 size-3 shrink-0" /> : <Copy className="mt-0.5 size-3 shrink-0" />}
    </button>
  );
}
