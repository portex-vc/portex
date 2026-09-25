import { cn } from "@/lib/utils";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";

/*
  Buttons (DESIGN_V2 §3): colour transitions at 150 ms, a 0.985 press, and a faint top highlight on
  the solid variant so it reads as a physical control rather than a flat rectangle.
*/
const buttonVariants = cva(
  "inline-flex select-none items-center justify-center gap-2 whitespace-nowrap rounded-[10px] text-sm font-medium transition-[background-color,border-color,color,box-shadow,transform] duration-150 ease-out active:scale-[0.985] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fg/30 focus-visible:ring-offset-2 focus-visible:ring-offset-bg disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default:
          "bg-fg text-bg shadow-[inset_0_1px_0_rgb(255_255_255/0.14),0_1px_2px_rgb(0_0_0/0.18)] hover:bg-fg/90 disabled:bg-fg/[0.08] disabled:text-fg-3 disabled:opacity-100 disabled:shadow-none",
        protected:
          "bg-protected text-bg shadow-[inset_0_1px_0_rgb(255_255_255/0.2),0_1px_2px_rgb(0_0_0/0.18)] hover:bg-protected/90",
        destructive: "bg-negative text-bg hover:bg-negative/90",
        outline:
          "border border-fg/[0.12] bg-transparent text-fg hover:border-fg/20 hover:bg-fg/[0.04] data-[state=open]:bg-fg/[0.05]",
        secondary: "bg-fg/[0.06] text-fg hover:bg-fg/[0.09]",
        ghost: "text-fg-2 hover:bg-fg/[0.05] hover:text-fg data-[state=open]:bg-fg/[0.06] data-[state=open]:text-fg",
        link: "text-fg underline decoration-fg/25 underline-offset-4 hover:decoration-fg/70 active:scale-100",
      },
      size: {
        default: "h-9 px-4",
        sm: "h-8 rounded-[9px] px-3 text-[0.8125rem]",
        lg: "h-11 rounded-[11px] px-5 text-[0.9375rem]",
        icon: "size-9",
        "icon-sm": "size-8 rounded-[9px]",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return <Comp className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props} />;
  },
);
Button.displayName = "Button";

export { Button, buttonVariants };
