"use client";

import { Button, type ButtonProps } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Loader2 } from "lucide-react";
import { useId } from "react";

/**
 * A write-action button. When disabled, `reason` explains why in a caption under the button
 * (and as its accessible description), so no button is ever silently dead and the label itself
 * stays the verb. `className` sizes the whole control (e.g. `w-full`).
 */
export function ActionButton({
  label,
  reason,
  pending,
  onClick,
  pendingLabel,
  className,
  ...props
}: {
  label: string;
  /** If set, the button is disabled and this explains why. */
  reason?: string | null;
  pending?: boolean;
  pendingLabel?: string;
  onClick?: () => void;
} & Omit<ButtonProps, "onClick" | "disabled" | "title" | "children">) {
  const id = useId();
  const disabled = Boolean(reason) || pending;
  const full = /\bw-full\b/.test(className ?? "");
  return (
    <span className={cn("inline-flex max-w-full flex-col gap-1.5", full && "flex w-full", className)}>
      <Button
        {...props}
        className={cn("h-auto whitespace-normal py-2", full ? "min-h-11 w-full text-[0.9375rem]" : "min-h-9")}
        disabled={disabled}
        aria-describedby={reason && !pending ? id : undefined}
        onClick={onClick}
      >
        {pending ? <Loader2 className="animate-spin" /> : null}
        {pending ? (pendingLabel ?? label) : label}
      </Button>
      {reason && !pending ? (
        <span id={id} className="text-xs leading-4 text-fg-3" data-testid="action-reason">
          {reason}
        </span>
      ) : null}
    </span>
  );
}
