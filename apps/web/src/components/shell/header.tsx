"use client";

import { AdminPill } from "@/components/admin/admin-pill";
import { SheenLogo } from "@/components/brand/logo";
import { Button } from "@/components/ui/button";
import { isLocalChain } from "@/lib/env";
import { useAdminRoles } from "@/lib/use-admin";
import { cn } from "@/lib/utils";
import * as Dialog from "@radix-ui/react-dialog";
import {
  Briefcase,
  ChartCandlestick,
  FlaskConical,
  LayoutGrid,
  Menu,
  Plus,
  Search,
  ShieldCheck,
  UserCog,
  X,
} from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ApiStatus } from "./api-status";
import { CommandPalette, palette, useIsMac } from "./command-palette";
import { InboxButton } from "./inbox-button";
import { Preferences } from "./preferences";
import { WalletControl } from "./wallet";

const LINKS = [
  { href: "/", key: "raises", exact: true, icon: LayoutGrid },
  { href: "/markets", key: "markets", icon: ChartCandlestick },
  { href: "/portfolio", key: "portfolio", icon: Briefcase },
  { href: "/protocol", key: "protocol", icon: ShieldCheck },
] as const;
const DEV_LINK = { href: "/dev", key: "dev", icon: FlaskConical } as const;
const ADMIN_LINK = { href: "/admin", key: "admin", icon: UserCog } as const;

/** Layout effect in the browser (measure before paint), plain effect on the server. */
const useIsomorphicLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

function useActive() {
  const pathname = usePathname();
  return (href: string, exact?: boolean) =>
    exact ? pathname === href || pathname.startsWith("/raise/") : pathname === href || pathname.startsWith(href + "/");
}

function useScrolled() {
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const on = () => setScrolled(window.scrollY > 4);
    on();
    window.addEventListener("scroll", on, { passive: true });
    return () => window.removeEventListener("scroll", on);
  }, []);
  return scrolled;
}

/**
 * Primary links with a pill that slides to the active item (DESIGN_V2 §5).
 *
 * The pill is one element positioned inside the nav and animated on `x` and `width` only. It used to be a
 * shared-layout (`layoutId`) span inside the active link, which motion measures in page coordinates: in this
 * sticky header, a route change from a scrolled page reset the scroll, so the old pill looked hundreds of
 * pixels lower and shot up into the bar. Nav-relative offsets cannot move vertically.
 */
function PrimaryNav() {
  const t = useTranslations("nav");
  const isActive = useActive();
  const reduce = useReducedMotion();
  const links = [...LINKS, ...(isLocalChain ? [DEV_LINK] : [])];
  const activeHref = links.find((l) => isActive(l.href, "exact" in l ? l.exact : false))?.href ?? null;
  const navRef = useRef<HTMLElement>(null);
  const [pill, setPill] = useState<{ x: number; width: number; animate: boolean } | null>(null);

  useIsomorphicLayoutEffect(() => {
    const nav = navRef.current;
    if (!nav) return;
    const measure = () => {
      const link = activeHref ? nav.querySelector<HTMLElement>(`a[data-nav="${activeHref}"]`) : null;
      setPill((previous) => {
        // Hidden nav (below lg) or no active item: no pill; the next appearance is instant, never a slide.
        if (!link || link.offsetWidth === 0) return null;
        const next = { x: link.offsetLeft, width: link.offsetWidth };
        if (previous && previous.x === next.x && previous.width === next.width) return previous;
        return { ...next, animate: previous !== null };
      });
    };
    measure();
    // Font loading, locale changes and resizes change the link widths.
    const observer = new ResizeObserver(measure);
    observer.observe(nav);
    return () => observer.disconnect();
  }, [activeHref]);

  return (
    <nav ref={navRef} aria-label={t("primary")} className="relative isolate hidden items-center lg:flex">
      {pill ? (
        <motion.span
          aria-hidden
          data-testid="nav-pill"
          className="pointer-events-none absolute inset-y-0 left-0 -z-10 rounded-[9px] bg-fg/[0.07]"
          initial={false}
          animate={{ x: pill.x, width: pill.width }}
          transition={
            reduce || !pill.animate ? { duration: 0 } : { type: "spring", stiffness: 520, damping: 42, mass: 0.9 }
          }
        />
      ) : null}
      {links.map((l) => {
        const active = l.href === activeHref;
        return (
          <Link
            key={l.href}
            href={l.href}
            data-nav={l.href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "relative rounded-[9px] px-3 py-1.5 text-[0.8125rem] transition-colors duration-150",
              active ? "text-fg" : "text-fg-2 hover:bg-fg/[0.04] hover:text-fg",
            )}
          >
            {t(l.key)}
          </Link>
        );
      })}
    </nav>
  );
}

function SearchButton() {
  const t = useTranslations("palette");
  const mac = useIsMac();
  return (
    <>
      <button
        type="button"
        onClick={() => palette.set(true)}
        data-testid="search-button"
        className="hidden h-8 items-center gap-2 rounded-[9px] border border-fg/[0.09] bg-fg/[0.025] pl-2.5 pr-1.5 text-[0.8125rem] text-fg-3 transition-colors duration-150 hover:border-fg/[0.15] hover:text-fg-2 xl:inline-flex"
      >
        <Search className="size-3.5" aria-hidden />
        <span className="w-28 text-left xl:w-36">{t("search")}</span>
        <kbd className="kbd">{mac ? "⌘K" : "Ctrl K"}</kbd>
      </button>
      <Button
        variant="ghost"
        size="icon-sm"
        className="xl:hidden"
        aria-label={t("search")}
        onClick={() => palette.set(true)}
      >
        <Search />
      </Button>
    </>
  );
}

function MobileMenu() {
  const t = useTranslations("nav");
  const isActive = useActive();
  const reduce = useReducedMotion();
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  useEffect(() => setOpen(false), [pathname]);
  const { roles } = useAdminRoles();
  // The admin console is listed only for accounts that hold a protocol role.
  const links = [...LINKS, ...(isLocalChain ? [DEV_LINK] : []), ...(roles.length ? [ADMIN_LINK] : [])];
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <Button variant="ghost" size="icon-sm" className="lg:hidden" aria-label={t("menu")} data-testid="mobile-menu">
          <Menu />
        </Button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-bg/70 backdrop-blur-sm duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
        <Dialog.Content
          aria-describedby={undefined}
          className="overlay fixed inset-x-0 top-0 z-50 rounded-b-[20px] border-t-0 px-4 pb-5 pt-3 duration-300 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:slide-out-to-top-4 data-[state=open]:slide-in-from-top-4 data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0"
        >
          <Dialog.Title className="sr-only">{t("menu")}</Dialog.Title>
          <div className="flex h-10 items-center justify-between">
            <SheenLogo size={24} />
            <Dialog.Close asChild>
              <Button variant="ghost" size="icon-sm" aria-label={t("close")}>
                <X />
              </Button>
            </Dialog.Close>
          </div>
          <nav aria-label={t("primary")} className="mt-3 flex flex-col gap-0.5">
            {links.map((l, i) => {
              const active = isActive(l.href, "exact" in l ? l.exact : false);
              const Icon = l.icon;
              return (
                <motion.div
                  key={l.href}
                  initial={reduce ? false : { opacity: 0, y: -4 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.28, delay: reduce ? 0 : 0.04 + i * 0.035, ease: [0.22, 1, 0.36, 1] }}
                >
                  <Link
                    href={l.href}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "flex items-center gap-3 rounded-[12px] px-3 py-3 text-[0.9375rem] tracking-[-0.01em] transition-colors duration-150 active:bg-fg/[0.07]",
                      active ? "bg-fg/[0.06] text-fg" : "text-fg-2 hover:bg-fg/[0.04] hover:text-fg",
                    )}
                  >
                    <span
                      className={cn(
                        "flex size-8 items-center justify-center rounded-[9px] border transition-colors",
                        active ? "border-fg/[0.14] bg-fg/[0.06] text-fg" : "border-fg/[0.08] text-fg-3",
                      )}
                    >
                      <Icon className="size-4" aria-hidden />
                    </span>
                    <span className="flex-1">{t(l.key)}</span>
                    {active ? <span className="size-1.5 rounded-full bg-fg" aria-hidden /> : null}
                  </Link>
                </motion.div>
              );
            })}
          </nav>
          <Button asChild size="lg" className="mt-4 w-full">
            <Link href="/create" data-testid="mobile-create">
              <Plus />
              {t("create")}
            </Link>
          </Button>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function Header() {
  const t = useTranslations("nav");
  const scrolled = useScrolled();
  const creating = usePathname() === "/create";
  return (
    <header
      className={cn(
        "sticky top-0 z-40 border-b transition-[background-color,border-color,backdrop-filter] duration-300",
        scrolled ? "border-fg/[0.07] bg-bg/75 backdrop-blur-xl backdrop-saturate-150" : "border-transparent bg-bg/0",
      )}
    >
      <div className="container flex h-16 items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-5 lg:gap-7">
          <Link href="/" className="flex items-center rounded-md text-fg" aria-label="Portex">
            <SheenLogo size={26} />
          </Link>
          <PrimaryNav />
        </div>
        <div className="flex items-center gap-1 sm:gap-1.5">
          <SearchButton />
          <Button
            asChild
            variant="outline"
            size="sm"
            className={cn(
              "hidden gap-1.5 max-xl:w-8 max-xl:px-0 lg:inline-flex",
              creating && "border-fg/20 bg-fg/[0.06]",
            )}
          >
            <Link
              href="/create"
              data-testid="nav-create"
              aria-label={t("create")}
              title={t("create")}
              aria-current={creating ? "page" : undefined}
            >
              <Plus className="!size-3.5" />
              <span className="hidden xl:inline">{t("create")}</span>
            </Link>
          </Button>
          <InboxButton />
          <Preferences />
          <AdminPill />
          <WalletControl />
          <MobileMenu />
        </div>
      </div>
      <ApiStatus />
      <CommandPalette />
    </header>
  );
}
