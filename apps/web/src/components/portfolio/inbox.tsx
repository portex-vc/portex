"use client";

import { StageBadge } from "@/components/raise/stage-badge";
import { ErrorState } from "@/components/states";
import { Button } from "@/components/ui/button";
import type { InboxItem } from "@/lib/api";
import { useInbox, useRaises } from "@/lib/hooks";
import { useNumbers } from "@/lib/use-numbers";
import { cn } from "@/lib/utils";
import { Check } from "lucide-react";
import { useTranslations } from "next-intl";
import Link from "next/link";

function inboxLink(item: InboxItem) {
  if (item.type === "vote_open") return `/raise/${item.raise}?tab=governance#proposal-${item.data.proposalId}`;
  if (item.type === "dispute_exit") return `/raise/${item.raise}?tab=governance#action-rail`;
  return `/raise/${item.raise}#action-rail`;
}

export function PortfolioInbox({ address }: { address: string }) {
  const t = useTranslations("inbox");
  const n = useNumbers();
  const v = useTranslations("v31");
  const { data: raises } = useRaises();
  const byAddress = new Map(raises?.map((raise) => [raise.address.toLowerCase(), raise]));
  const { data, isError, isLoading, error, refetch } = useInbox(address);
  const count = data?.items.length ?? 0;
  return (
    <section className="surface-1" data-testid="portfolio-inbox" aria-labelledby="inbox-title">
      <div className="flex items-center justify-between gap-3 border-b border-fg/[0.07] px-5 py-4">
        <h2 id="inbox-title" className="text-sm font-medium">
          {t("title")}
        </h2>
        {count ? (
          <span className="num rounded-full bg-risk/15 px-2 py-0.5 text-2xs font-semibold text-risk">
            {n.number(count, 0)}
          </span>
        ) : null}
      </div>
      {isLoading ? (
        <div className="space-y-2 p-5">
          <div className="skeleton h-12" />
          <div className="skeleton h-12" />
        </div>
      ) : isError ? (
        <div className="p-5">
          <ErrorState error={error} retry={refetch} />
        </div>
      ) : !count ? (
        <div className="flex items-center gap-3 px-5 py-5 text-sm text-fg-2">
          <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-positive/10 text-positive">
            <Check className="size-3.5" aria-hidden />
          </span>
          {t("empty")}
        </div>
      ) : (
        <ul className="divide-y divide-fg/[0.06]">
          {data!.items.map((item, index) => {
            const raise = byAddress.get(item.raise.toLowerCase());
            const now = item.severity === "action";
            return (
              <li
                key={`${item.raise}-${item.type}-${index}`}
                className="flex flex-wrap items-center justify-between gap-3 px-5 py-4 transition-colors hover:bg-fg/[0.02]"
                data-testid="inbox-item"
              >
                <div className="flex min-w-0 gap-3">
                  <span
                    aria-hidden
                    className={cn("mt-1.5 size-1.5 shrink-0 rounded-full", now ? "bg-risk" : "bg-fg-3")}
                  />
                  <div className="min-w-0 space-y-1">
                    <p className="text-sm font-medium">{v(`inbox${item.type}`)}</p>
                    <div className="flex flex-wrap items-center gap-2 text-xs text-fg-2">
                      <span>{raise?.profile.name || item.raiseName}</span>
                      {raise ? <StageBadge state={raise.phase} form="short" /> : null}
                      <span className="num text-fg-3">
                        {item.dueAt && item.dueAt > (data?.now ?? 0)
                          ? t(now ? "closesAt" : "availableAt", { date: n.date(item.dueAt) })
                          : t("availableNow")}
                      </span>
                    </div>
                  </div>
                </div>
                <Button asChild size="sm" variant={now ? "outline" : "ghost"} className="ml-auto shrink-0">
                  <Link href={inboxLink(item)}>{t(now ? "act" : "view")}</Link>
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
