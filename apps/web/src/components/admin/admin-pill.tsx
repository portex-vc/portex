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
import { useAdminRoles } from "@/lib/use-admin";
import { ArrowRight, ChevronDown, UserCog } from "lucide-react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { ROLE_ICONS } from "./shared";

/**
 * Header indicator for accounts that hold a protocol role: a restrained pill whose menu lists the roles
 * held and opens /admin. Renders nothing for everyone else (and while roles are still being read).
 */
export function AdminPill() {
  const t = useTranslations("admin");
  const { roles } = useAdminRoles();
  if (!roles.length) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          data-testid="admin-pill"
          aria-label={t("pill")}
          className="gap-1.5 border-fg/[0.14] bg-fg/[0.04] px-2 sm:px-2.5"
        >
          <UserCog className="!size-3.5" />
          <span className="hidden sm:inline">{t("pill")}</span>
          <ChevronDown className="hidden !size-3 text-fg-3 sm:block" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72" data-testid="admin-menu">
        <DropdownMenuLabel>{t("menuTitle")}</DropdownMenuLabel>
        <ul className="space-y-0.5 px-1 pb-1">
          {roles.map((role) => {
            const Icon = ROLE_ICONS[role];
            return (
              <li key={role} className="flex gap-2.5 rounded-lg px-1.5 py-2" data-testid={`admin-menu-${role}`}>
                <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-[7px] border border-fg/[0.1] text-fg-2">
                  <Icon className="size-3.5" aria-hidden />
                </span>
                <span className="min-w-0">
                  <span className="block text-[0.8125rem] font-medium text-fg">{t(`roles.${role}`)}</span>
                  <span className="mt-0.5 block text-xs leading-snug text-fg-3">{t(`roleHints.${role}`)}</span>
                </span>
              </li>
            );
          })}
        </ul>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link href="/admin" data-testid="admin-open" className="justify-between">
            {t("open")}
            <ArrowRight className="text-fg-3" />
          </Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
