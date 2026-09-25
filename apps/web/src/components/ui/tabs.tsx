"use client";

import { cn } from "@/lib/utils";
import * as TabsPrimitive from "@radix-ui/react-tabs";
import { LayoutGroup, motion, useReducedMotion } from "motion/react";
import * as React from "react";

/*
  Underline tabs (DESIGN_V2 §3): the active indicator slides between triggers on the layout spring,
  so switching tabs reads as one object moving rather than two states swapping.
*/
const TabsIndicatorContext = React.createContext<{ value?: string; id: string }>({ id: "tabs" });

const Tabs = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Root>
>(({ value, defaultValue, onValueChange, children, ...props }, ref) => {
  const id = React.useId();
  const [inner, setInner] = React.useState(defaultValue);
  const current = value ?? inner;
  return (
    <TabsPrimitive.Root
      ref={ref}
      value={value}
      defaultValue={defaultValue}
      onValueChange={(next) => {
        setInner(next);
        onValueChange?.(next);
      }}
      {...props}
    >
      <TabsIndicatorContext.Provider value={{ value: current, id }}>
        <LayoutGroup id={id}>{children}</LayoutGroup>
      </TabsIndicatorContext.Provider>
    </TabsPrimitive.Root>
  );
});
Tabs.displayName = TabsPrimitive.Root.displayName;

const TabsList = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.List>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.List>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.List
    ref={ref}
    className={cn("relative flex items-center gap-1 border-b border-fg/[0.08]", className)}
    {...props}
  />
));
TabsList.displayName = TabsPrimitive.List.displayName;

const TabsTrigger = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>
>(({ className, children, value, ...props }, ref) => {
  const ctx = React.useContext(TabsIndicatorContext);
  const reduce = useReducedMotion();
  const active = ctx.value === value;
  return (
    <TabsPrimitive.Trigger
      ref={ref}
      value={value}
      className={cn(
        "relative -mb-px inline-flex h-10 items-center justify-center whitespace-nowrap px-3 text-sm text-fg-3 transition-colors duration-150 hover:text-fg-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fg/30 disabled:pointer-events-none disabled:opacity-50 data-[state=active]:text-fg",
        className,
      )}
      {...props}
    >
      {children}
      {active ? (
        <motion.span
          layoutId="tab-indicator"
          aria-hidden
          className="absolute inset-x-2 -bottom-px h-[1.5px] rounded-full bg-fg"
          transition={reduce ? { duration: 0 } : { type: "spring", stiffness: 520, damping: 42 }}
        />
      ) : null}
    </TabsPrimitive.Trigger>
  );
});
TabsTrigger.displayName = TabsPrimitive.Trigger.displayName;

const TabsContent = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Content>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Content ref={ref} className={cn("mt-6 focus-visible:outline-none", className)} {...props} />
));
TabsContent.displayName = TabsPrimitive.Content.displayName;

export { Tabs, TabsContent, TabsList, TabsTrigger };
