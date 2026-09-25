"use client";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { setLocale } from "@/i18n/actions";
import { localeNames, locales } from "@/i18n/config";
import { Check, Globe } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useTransition } from "react";

export function LocaleSwitcher() {
  const locale = useLocale();
  const t = useTranslations("locale");
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className="gap-1.5 text-fg-2" aria-label={t("label")} disabled={pending}>
          <Globe className="size-4" />
          <span className="hidden text-xs font-medium uppercase tracking-wide sm:inline">{locale}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        <DropdownMenuLabel>{t("label")}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {locales.map((l) => (
          <DropdownMenuItem
            key={l}
            className="flex items-center justify-between"
            onClick={() =>
              startTransition(async () => {
                await setLocale(l);
                router.refresh();
              })
            }
          >
            <span>{localeNames[l]}</span>
            {l === locale ? <Check className="size-4" /> : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
