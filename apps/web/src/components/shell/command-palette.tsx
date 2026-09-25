"use client";

import { ProjectAvatar } from "@/components/raise/project-avatar";
import { setLocale } from "@/i18n/actions";
import { localeNames, locales } from "@/i18n/config";
import { useRaises } from "@/lib/hooks";
import { displayStage, stageLabel, STAGE_TONE } from "@/lib/stages";
import { cn } from "@/lib/utils";
import { walletSheet } from "@/lib/wallet-sheet";
import * as Dialog from "@radix-ui/react-dialog";
import {
  ArrowRight,
  Briefcase,
  ChartCandlestick,
  Check,
  Copy,
  Globe,
  LayoutGrid,
  Moon,
  Rocket,
  Search,
  ShieldCheck,
  Sun,
  Wallet,
} from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useTheme } from "next-themes";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useAccount } from "wagmi";

/* Open state shared by the header button and the global shortcuts. */
let open = false;
const listeners = new Set<() => void>();
const publish = () => listeners.forEach((l) => l());
export const palette = {
  set(next: boolean) {
    open = next;
    publish();
  },
  toggle() {
    open = !open;
    publish();
  },
};
function usePaletteOpen() {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => open,
    () => false,
  );
}

type Entry = {
  id: string;
  group: "projects" | "pages" | "actions";
  label: string;
  hint?: string;
  keywords: string;
  icon: React.ReactNode;
  run: () => void;
};

export function useIsMac() {
  const [mac, setMac] = useState(true);
  useEffect(() => setMac(/Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)), []);
  return mac;
}

/** ⌘K / Ctrl+K anywhere, "/" when not typing. */
function useShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        palette.toggle();
        return;
      }
      const target = e.target as HTMLElement | null;
      const typing = target && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));
      if (e.key === "/" && !typing && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        palette.set(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

export function CommandPalette() {
  useShortcuts();
  const isOpen = usePaletteOpen();
  return (
    <Dialog.Root open={isOpen} onOpenChange={palette.set}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-bg/60 backdrop-blur-[2px] duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
        {isOpen ? <PaletteBody /> : null}
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** Mounted only while open, so its data hooks never run during page hydration. */
function PaletteBody() {
  const t = useTranslations("palette");
  const tn = useTranslations("nav");
  const all = useTranslations();
  const router = useRouter();
  const locale = useLocale();
  const { resolvedTheme, setTheme } = useTheme();
  const { address, isConnected } = useAccount();
  const { data: raises } = useRaises();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const go = (href: string) => () => {
    palette.set(false);
    router.push(href);
  };

  const entries = useMemo<Entry[]>(() => {
    const projects: Entry[] = (raises ?? []).map((r) => {
      const stage = displayStage(r.phase);
      return {
        id: `p-${r.address}`,
        group: "projects",
        label: r.profile.name || r.name,
        hint: stageLabel(all, stage, "short"),
        keywords: `${r.profile.name} ${r.name} ${r.symbol} ${r.address} ${r.profile.tagline ?? ""}`.toLowerCase(),
        icon: (
          <span className="relative">
            <ProjectAvatar symbol={r.symbol} profile={r.profile} size="sm" />
            <span
              aria-hidden
              className={cn(
                "absolute -bottom-0.5 -right-0.5 size-2 rounded-full ring-2 ring-surface-1",
                STAGE_TONE[stage].dot,
              )}
            />
          </span>
        ),
        run: go(`/raise/${r.address}`),
      };
    });
    const pages: Entry[] = [
      { id: "g-projects", label: tn("raises"), icon: <LayoutGrid />, href: "/" },
      { id: "g-markets", label: tn("markets"), icon: <ChartCandlestick />, href: "/markets" },
      { id: "g-portfolio", label: tn("portfolio"), icon: <Briefcase />, href: "/portfolio" },
      { id: "g-protocol", label: tn("protocol"), icon: <ShieldCheck />, href: "/protocol" },
      { id: "g-launch", label: tn("create"), icon: <Rocket />, href: "/create" },
    ].map((p) => ({
      id: p.id,
      group: "pages" as const,
      label: p.label,
      keywords: p.label.toLowerCase(),
      icon: p.icon,
      run: go(p.href),
    }));
    const dark = resolvedTheme !== "light";
    const actions: Entry[] = [
      isConnected && address
        ? {
            id: "a-copy",
            group: "actions" as const,
            label: t("copyAddress"),
            keywords: `${t("copyAddress")} wallet address`.toLowerCase(),
            icon: <Copy />,
            run: () => {
              void navigator.clipboard.writeText(address).catch(() => {});
              palette.set(false);
            },
          }
        : {
            id: "a-connect",
            group: "actions" as const,
            label: t("connect"),
            keywords: `${t("connect")} wallet`.toLowerCase(),
            icon: <Wallet />,
            run: () => {
              palette.set(false);
              walletSheet.open();
            },
          },
      {
        id: "a-theme",
        group: "actions",
        label: t(dark ? "lightTheme" : "darkTheme"),
        keywords: `${t("lightTheme")} ${t("darkTheme")} theme`.toLowerCase(),
        icon: dark ? <Sun /> : <Moon />,
        run: () => {
          setTheme(dark ? "light" : "dark");
          palette.set(false);
        },
      },
      ...locales.map((l) => ({
        id: `a-lang-${l}`,
        group: "actions" as const,
        label: localeNames[l],
        hint: l === locale ? t("current") : undefined,
        keywords: `${localeNames[l]} ${t("language")} language ${l}`.toLowerCase(),
        icon: l === locale ? <Check /> : <Globe />,
        run: () => {
          palette.set(false);
          void setLocale(l).then(() => router.refresh());
        },
      })),
    ];
    return [...projects, ...pages, ...actions];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [raises, resolvedTheme, isConnected, address, locale, all, t, tn]);

  const q = query.trim().toLowerCase();
  const results = q ? entries.filter((e) => e.keywords.includes(q) || e.label.toLowerCase().includes(q)) : entries;
  const groups = (["projects", "pages", "actions"] as const)
    .map((g) => ({ g, items: results.filter((e) => e.group === g) }))
    .filter((x) => x.items.length);
  const flat = groups.flatMap((x) => x.items);

  useEffect(() => setActive(0), [q]);
  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, flat.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      flat[active]?.run();
    }
  };

  let index = -1;
  return (
    <Dialog.Content
      data-testid="command-palette"
      aria-describedby={undefined}
      onKeyDown={onKeyDown}
      className="overlay fixed left-1/2 top-[14vh] z-50 flex max-h-[min(34rem,72vh)] w-[calc(100vw-2rem)] max-w-[35rem] -translate-x-1/2 flex-col overflow-hidden rounded-2xl duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-[0.98] data-[state=open]:zoom-in-[0.98] data-[state=open]:slide-in-from-top-2"
    >
      <Dialog.Title className="sr-only">{t("title")}</Dialog.Title>
      <div className="flex items-center gap-3 border-b border-fg/[0.07] px-4">
        <Search className="size-4 shrink-0 text-fg-3" aria-hidden />
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("placeholder")}
          aria-label={t("placeholder")}
          className="h-14 min-w-0 flex-1 bg-transparent text-[0.9375rem] text-fg outline-none placeholder:text-fg-3"
        />
        <kbd className="kbd">Esc</kbd>
      </div>
      <div ref={listRef} className="scroll-thin min-h-0 flex-1 overflow-y-auto p-2" role="listbox">
        {!flat.length ? (
          <p className="px-3 py-10 text-center text-sm text-fg-3">{t("empty", { query })}</p>
        ) : (
          groups.map(({ g, items }) => (
            <div key={g} className="pb-1">
              <p className="micro px-3 pb-1.5 pt-3">{t(`groups.${g}`)}</p>
              {items.map((e) => {
                index += 1;
                const i = index;
                const on = i === active;
                return (
                  <button
                    key={e.id}
                    type="button"
                    role="option"
                    aria-selected={on}
                    data-index={i}
                    onMouseMove={() => setActive(i)}
                    onClick={e.run}
                    className={cn(
                      "group flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm transition-colors duration-75 [&_svg]:size-4 [&_svg]:shrink-0",
                      on ? "bg-fg/[0.06] text-fg" : "text-fg-2",
                    )}
                  >
                    <span className={cn("flex items-center", on ? "text-fg" : "text-fg-3")}>{e.icon}</span>
                    <span className="min-w-0 flex-1 truncate">{e.label}</span>
                    {e.hint ? <span className="shrink-0 text-xs text-fg-3">{e.hint}</span> : null}
                    <ArrowRight
                      aria-hidden
                      className={cn(
                        "text-fg-3 transition-[opacity,transform] duration-150",
                        on ? "translate-x-0 opacity-100" : "-translate-x-1 opacity-0",
                      )}
                    />
                  </button>
                );
              })}
            </div>
          ))
        )}
      </div>
      <div className="flex items-center gap-4 border-t border-fg/[0.07] px-4 py-2.5 text-2xs text-fg-3">
        <span className="inline-flex items-center gap-1.5">
          <kbd className="kbd">↑</kbd>
          <kbd className="kbd">↓</kbd> {t("navigate")}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <kbd className="kbd">↵</kbd> {t("open")}
        </span>
      </div>
    </Dialog.Content>
  );
}
