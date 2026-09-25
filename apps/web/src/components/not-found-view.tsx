"use client";

import { DrawnMark } from "@/components/brand/logo";
import { Button } from "@/components/ui/button";
import { useTranslations } from "next-intl";
import Link from "next/link";

/** Shared "nothing here" view: the mark, one sentence, one action. */
export function NotFoundView({ kind = "page" }: { kind?: "page" | "raise" }) {
  const t = useTranslations("notFound");
  return (
    <section
      className="mx-auto flex max-w-xl flex-col items-center gap-4 px-6 py-20 text-center"
      data-testid="not-found"
    >
      <DrawnMark size={44} className="text-fg-2" />
      <p className="micro">{t("eyebrow")}</p>
      <h1 className="t-title">{t(kind === "raise" ? "raiseTitle" : "title")}</h1>
      <p className="max-w-sm text-sm leading-relaxed text-fg-2">{t(kind === "raise" ? "raiseBody" : "body")}</p>
      <div className="flex flex-wrap justify-center gap-2 pt-2">
        <Button asChild>
          <Link href="/">{t("home")}</Link>
        </Button>
        <Button asChild variant="outline">
          <Link href="/portfolio">{t("portfolio")}</Link>
        </Button>
      </div>
    </section>
  );
}
