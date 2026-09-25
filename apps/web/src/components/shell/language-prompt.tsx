"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { Mark } from "@/components/brand/logo";
import { setLocale } from "@/i18n/actions";
import { LOCALE_COOKIE, localeNames, locales } from "@/i18n/config";
import { cn } from "@/lib/utils";
import { Check, X } from "lucide-react";
import { useLocale } from "next-intl";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";

const CHOSEN_KEY = "portex-language-chosen";

/** Shown before any language is chosen, so it follows the browser's language rather than the page's. */
const HINT: Record<(typeof locales)[number], string> = {
  en: "Choose your language. You can change it later in the header.",
  zh: "请选择界面语言，之后可在页眉中随时更改。",
  es: "Elige tu idioma. Puedes cambiarlo más tarde en la cabecera.",
};

/** The browser's preferred language among ours, for the highlighted default. */
function preferred(): (typeof locales)[number] {
  for (const lang of navigator.languages ?? [navigator.language]) {
    const base = lang.toLowerCase().split("-")[0];
    const match = locales.find((l) => l === base);
    if (match) return match;
  }
  return "en";
}

/**
 * First visit: ask for a language before anything else, since the switcher sits in the header menu.
 * Shown once (a stored choice or an existing locale cookie means it never appears again), after the
 * intro has played, and never in automated browsers.
 */
export function LanguagePrompt() {
  const locale = useLocale();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [suggested, setSuggested] = useState<(typeof locales)[number]>("en");
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    try {
      if (navigator.webdriver) return;
      if (localStorage.getItem(CHOSEN_KEY)) return;
      if (document.cookie.split("; ").some((c) => c.startsWith(`${LOCALE_COOKIE}=`))) return;
    } catch {
      return;
    }
    setSuggested(preferred());
    const root = document.documentElement;
    let timer = 0;
    const show = () => {
      timer = window.setTimeout(() => setOpen(true), 250);
    };
    if (root.getAttribute("data-intro") !== "play") {
      show();
      return () => window.clearTimeout(timer);
    }
    // Wait for the first-visit intro to finish before asking.
    const observer = new MutationObserver(() => {
      if (root.getAttribute("data-intro") !== "play") {
        observer.disconnect();
        show();
      }
    });
    observer.observe(root, { attributes: true, attributeFilter: ["data-intro"] });
    return () => {
      observer.disconnect();
      window.clearTimeout(timer);
    };
  }, []);

  function remember() {
    try {
      localStorage.setItem(CHOSEN_KEY, "1");
    } catch {
      /* private mode: the cookie below still keeps the choice */
    }
  }

  function choose(l: (typeof locales)[number]) {
    remember();
    startTransition(async () => {
      await setLocale(l);
      setOpen(false);
      if (l !== locale) router.refresh();
    });
  }

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          remember();
          // Keep the current language as an explicit choice.
          void setLocale(locale);
        }
        setOpen(next);
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[80] bg-bg/60 backdrop-blur-sm data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <Dialog.Content
          className="fixed left-1/2 top-1/2 z-[81] w-[calc(100%-2rem)] max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-fg/10 bg-bg p-6 shadow-2xl outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95"
          data-testid="language-prompt"
        >
          <div className="flex items-start justify-between">
            <Mark size={26} className="text-fg" />
            <Dialog.Close
              className="-m-1.5 rounded-md p-1.5 text-fg-3 transition-colors hover:bg-fg/5 hover:text-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-fg/40"
              aria-label="Close"
            >
              <X className="size-4" />
            </Dialog.Close>
          </div>
          <Dialog.Title className="mt-5 text-lg font-semibold tracking-tight text-fg">
            Language · 语言 · Idioma
          </Dialog.Title>
          <Dialog.Description className="mt-1 text-sm text-fg-3">{HINT[suggested]}</Dialog.Description>
          <div className="mt-5 grid gap-2">
            {locales.map((l) => {
              const current = l === locale;
              return (
                <button
                  key={l}
                  type="button"
                  disabled={pending}
                  onClick={() => choose(l)}
                  autoFocus={l === suggested}
                  className={cn(
                    "group flex items-center justify-between rounded-xl border px-4 py-3 text-left transition-colors",
                    "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-fg/40",
                    l === suggested
                      ? "border-fg/25 bg-fg/[0.04]"
                      : "border-fg/10 hover:border-fg/20 hover:bg-fg/[0.03]",
                  )}
                >
                  <span className="text-[0.9375rem] font-medium text-fg">{localeNames[l]}</span>
                  {current ? <Check className="size-4 text-fg-2" aria-hidden /> : null}
                </button>
              );
            })}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
