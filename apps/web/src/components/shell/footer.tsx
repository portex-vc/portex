"use client";

import { Logo } from "@/components/brand/logo";
import { env, isLocalChain } from "@/lib/env";
import { useHealth } from "@/lib/hooks";
import { useNumbers } from "@/lib/use-numbers";
import { cn } from "@/lib/utils";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useNetworkName } from "./wallet";

export function Footer() {
  const t = useTranslations("footer");
  const nav = useTranslations("nav");
  const n = useNumbers();
  const network = useNetworkName();
  const health = useHealth();
  const ok = health.data?.ok;
  return (
    <footer className="mt-8 border-t border-fg/[0.07]">
      <div className="container grid gap-8 py-10 text-[0.8125rem] md:grid-cols-[1fr_auto] md:items-end">
        <div className="space-y-4">
          <div className="flex items-center gap-2.5 text-fg">
            <Logo size={24} />
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-fg-3">
            <span>{t("built")}</span>
            <span aria-hidden className="text-fg/20">
              /
            </span>
            <span className="inline-flex items-center gap-1.5" data-testid="footer-status">
              <span className={cn("inline-block size-1.5 rounded-full", ok ? "bg-positive" : "bg-fg-3")} aria-hidden />
              {isLocalChain ? t("chain") : network(env.chainId)}
              {health.data?.head != null ? (
                <span className="num text-fg-3">#{n.number(health.data.head, 0)}</span>
              ) : null}
            </span>
          </div>
        </div>
        <nav
          aria-label={t("links")}
          className="grid grid-cols-3 gap-x-4 gap-y-2.5 text-fg-2 sm:flex sm:flex-wrap sm:gap-x-6 sm:gap-y-2"
        >
          <Link href="/" className="transition-colors hover:text-fg">
            {nav("raises")}
          </Link>
          <Link href="/markets" className="transition-colors hover:text-fg">
            {nav("markets")}
          </Link>
          <Link href="/portfolio" className="transition-colors hover:text-fg">
            {nav("portfolio")}
          </Link>
          <Link href="/create" className="transition-colors hover:text-fg">
            {nav("create")}
          </Link>
          <Link href="/protocol" className="transition-colors hover:text-fg">
            {t("contracts")}
          </Link>
          <Link href="/wiki" className="transition-colors hover:text-fg" data-testid="footer-wiki">
            {t("wiki")}
          </Link>
        </nav>
      </div>
    </footer>
  );
}
