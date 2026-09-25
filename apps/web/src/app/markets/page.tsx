"use client";

import { MarketsTable } from "@/components/market/markets-table";
import { useTranslations } from "next-intl";

/** Graduated projects (Stage 3 · Open market) and their Uniswap v4 pools. */
export default function MarketsPage() {
  const t = useTranslations("markets");
  return (
    <div className="space-y-8 pt-2 lg:pt-4" data-testid="markets-page">
      <header className="max-w-2xl space-y-2">
        <h1 className="t-title">{t("title")}</h1>
        <p className="text-[0.9375rem] leading-relaxed text-fg-2">{t("description")}</p>
      </header>
      <MarketsTable />
    </div>
  );
}
