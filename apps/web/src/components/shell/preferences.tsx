"use client";

import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { setLocale } from "@/i18n/actions";
import { localeNames, locales } from "@/i18n/config";
import { cn } from "@/lib/utils";
import { Check, Moon, SlidersHorizontal, Sun } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import { useLocale, useTranslations } from "next-intl";
import { useTheme } from "next-themes";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";

/** One control for theme and language (DESIGN_V2 §5), instead of two separate header buttons. */
export function Preferences() {
  const t = useTranslations("preferences");
  const locale = useLocale();
  const router = useRouter();
  const reduce = useReducedMotion();
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  const [pending, start] = useTransition();
  useEffect(() => setMounted(true), []);
  const theme = mounted ? (resolvedTheme ?? "dark") : "dark";
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={t("title")} data-testid="preferences">
          <SlidersHorizontal />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-60 p-3">
        <p className="micro mb-2 px-1">{t("theme")}</p>
        <div
          role="radiogroup"
          aria-label={t("theme")}
          className="relative grid grid-cols-2 rounded-[10px] bg-fg/[0.05] p-0.5"
        >
          {(["dark", "light"] as const).map((value) => {
            const on = theme === value;
            return (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={on}
                onClick={() => setTheme(value)}
                className={cn(
                  "relative z-10 flex h-8 items-center justify-center gap-1.5 rounded-[8px] text-[0.8125rem] transition-colors",
                  on ? "text-fg" : "text-fg-3 hover:text-fg-2",
                )}
              >
                {on ? (
                  <motion.span
                    layoutId="pref-theme"
                    className="absolute inset-0 -z-10 rounded-[8px] bg-surface-1 shadow-[0_1px_2px_rgb(0_0_0/0.12)] ring-1 ring-fg/[0.08]"
                    transition={reduce ? { duration: 0 } : { type: "spring", stiffness: 520, damping: 42 }}
                  />
                ) : null}
                {value === "dark" ? <Moon className="size-3.5" /> : <Sun className="size-3.5" />}
                {t(value)}
              </button>
            );
          })}
        </div>
        <p className="micro mb-1 mt-4 px-1">{t("language")}</p>
        <ul className="space-y-0.5" data-testid="language-list">
          {locales.map((l) => (
            <li key={l}>
              <button
                type="button"
                disabled={pending}
                onClick={() =>
                  start(async () => {
                    await setLocale(l);
                    router.refresh();
                  })
                }
                className={cn(
                  "flex w-full items-center justify-between rounded-lg px-2.5 py-2 text-[0.8125rem] transition-colors hover:bg-fg/[0.05]",
                  l === locale ? "text-fg" : "text-fg-2",
                )}
              >
                {localeNames[l]}
                {l === locale ? <Check className="size-3.5 text-fg-2" /> : null}
              </button>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
