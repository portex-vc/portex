import { cn } from "@/lib/utils";
import * as React from "react";

const Textarea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(
  ({ className, ...props }, ref) => (
    <textarea
      className={cn(
        "flex min-h-[88px] w-full rounded-[10px] border border-fg/[0.1] bg-fg/[0.025] px-3 py-2.5 text-sm leading-relaxed text-fg transition-[border-color,box-shadow] duration-150 placeholder:text-fg-3/70 hover:border-fg/20 focus-visible:border-fg/25 focus-visible:shadow-[0_0_0_4px_rgb(var(--fg)/0.05)] focus-visible:outline-none aria-[invalid=true]:border-negative/60 disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      ref={ref}
      {...props}
    />
  ),
);
Textarea.displayName = "Textarea";

export { Textarea };
