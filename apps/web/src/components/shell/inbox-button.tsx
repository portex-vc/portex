"use client";

import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { InboxItem } from "@/lib/api";
import { useConnectedAddress, useInbox } from "@/lib/hooks";
import { useNumbers } from "@/lib/use-numbers";
import { cn } from "@/lib/utils";
import { ArrowUpRight, Bell } from "lucide-react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useState } from "react";

export function inboxLink(item: InboxItem) {
  if (item.type === "vote_open") return `/raise/${item.raise}?tab=governance#proposal-${item.data.proposalId}`;
  if (item.type === "dispute_exit") return `/raise/${item.raise}?tab=governance#action-rail`;
  return `/raise/${item.raise}#action-rail`;
}

/**
 * Header inbox: only present when an account is connected and something needs it — a refund to
 * claim, a listing to trigger, a vote to cast, rewards to collect. Deep-links to the exact action.
 */
export function InboxButton() {
  const address = useConnectedAddress();
  const t = useTranslations("inbox");
  const v = useTranslations("v31");
  const n = useNumbers();
  const [open, setOpen] = useState(false);
  const { data } = useInbox(address);
  const items = data?.items ?? [];
  const actionable = items.filter((i) => i.severity === "action").length;
  if (!address || !items.length) return null;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={t("title")} data-testid="inbox-button" className="relative">
          <Bell />
          <span
            className={cn(
              "num absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[0.625rem] font-semibold ring-2 ring-bg",
              actionable ? "bg-risk text-bg" : "bg-fg-3 text-bg",
            )}
          >
            {n.number(items.length, 0)}
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[22rem] p-0" data-testid="inbox-popover">
        <div className="flex items-center justify-between px-4 pb-2 pt-3.5">
          <p className="text-sm font-medium">{t("title")}</p>
          <Link href="/portfolio" onClick={() => setOpen(false)} className="text-xs text-fg-3 hover:text-fg">
            {t("allInPortfolio")}
          </Link>
        </div>
        <ul className="max-h-[22rem] overflow-y-auto p-1.5 pt-0">
          {items.map((item, i) => {
            const now = item.severity === "action";
            return (
              <li key={`${item.raise}-${item.type}-${i}`}>
                <Link
                  href={inboxLink(item)}
                  onClick={() => setOpen(false)}
                  className="group flex items-start gap-3 rounded-lg px-2.5 py-2.5 transition-colors hover:bg-fg/[0.05]"
                >
                  <span
                    aria-hidden
                    className={cn("mt-[7px] size-1.5 shrink-0 rounded-full", now ? "bg-risk" : "bg-fg-3")}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block text-[0.8125rem] font-medium text-fg">{v(`inbox${item.type}`)}</span>
                    <span className="num mt-0.5 block text-xs text-fg-3">
                      {item.raiseName} ·{" "}
                      {item.dueAt && item.dueAt > (data?.now ?? 0)
                        ? t(now ? "closesAt" : "availableAt", { date: n.date(item.dueAt) })
                        : t("availableNow")}
                    </span>
                  </span>
                  <ArrowUpRight className="mt-0.5 size-3.5 shrink-0 text-fg-3 opacity-0 transition-opacity group-hover:opacity-100" />
                </Link>
              </li>
            );
          })}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
