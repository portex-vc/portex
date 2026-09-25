"use client";

import { useTranslations } from "next-intl";
import { useTheme } from "next-themes";
import { Toaster as Sonner } from "sonner";

function Toaster() {
  const t = useTranslations("notifications");
  const { theme = "system" } = useTheme();
  return (
    <Sonner
      theme={theme as "light" | "dark" | "system"}
      className="toaster group"
      containerAriaLabel={t("label")}
      toastOptions={{
        closeButtonAriaLabel: t("close"),
        classNames: {
          toast:
            "group toast group-[.toaster]:bg-background group-[.toaster]:text-foreground group-[.toaster]:border-border group-[.toaster]:shadow-lg",
          description: "group-[.toast]:text-muted-foreground",
        },
      }}
    />
  );
}

export { Toaster };
