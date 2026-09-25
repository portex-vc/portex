"use client";

import { ActionButton } from "@/components/action-button";
import { ProjectAvatar } from "@/components/raise/project-avatar";
import { StageBadge } from "@/components/raise/stage-badge";
import { api } from "@/lib/api";
import { queryKeys, useRaises } from "@/lib/hooks";
import { useNumbers } from "@/lib/use-numbers";
import { useSignedWrite } from "@/lib/use-signed-write";
import { cn } from "@/lib/utils";
import { useQueries } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useState } from "react";
import { AdminSection } from "./shared";

/** API admins run the analyst on demand (the API skips its rate limit for ADMIN_ADDRESSES). */
export function AnalysisSection({ canRun }: { canRun: boolean }) {
  const t = useTranslations("admin.analysis");
  const tr = useTranslations("admin");
  const ta = useTranslations("analyst");
  const n = useNumbers();
  const { data: raises, isLoading } = useRaises();
  const { send, pending } = useSignedWrite();
  const [running, setRunning] = useState<string | null>(null);
  const list = raises ?? [];
  const reports = useQueries({
    queries: list.map((r) => ({
      queryKey: queryKeys.report(r.address),
      queryFn: () => api.report(r.address),
      staleTime: 15_000,
    })),
  });

  async function run(address: string) {
    setRunning(address);
    try {
      await send(t("run"), (signer) => api.analyze(address, signer), [
        queryKeys.raise(address),
        queryKeys.report(address),
        ["raises"],
      ]);
    } finally {
      setRunning(null);
    }
  }

  return (
    <AdminSection id="analysis" title={t("title")} description={t("description")} roles={["apiAdmin"]}>
      {isLoading ? (
        <div className="surface-1 space-y-3 p-5" aria-busy>
          {[0, 1, 2].map((i) => (
            <div key={i} className="skeleton h-10" />
          ))}
        </div>
      ) : (
        <ul className="surface-1 divide-y divide-fg/[0.06]" data-testid="analysis-list">
          {list.map((r, i) => {
            const report = reports[i]?.data;
            return (
              <li
                key={r.address}
                className="flex flex-wrap items-center gap-x-5 gap-y-3 px-5 py-3.5"
                data-testid={`analysis-${r.symbol}`}
              >
                <Link href={`/raise/${r.address}`} className="group flex min-w-0 flex-1 basis-56 items-center gap-3">
                  <ProjectAvatar symbol={r.symbol} profile={r.profile} size="sm" />
                  <span className="truncate text-sm font-medium group-hover:underline">{r.profile.name || r.name}</span>
                  <span className="shrink-0 font-mono text-2xs text-fg-3">{r.symbol}</span>
                </Link>
                <StageBadge state={r.phase} form="short" />
                <span className="num min-w-[11rem] text-xs text-fg-3">
                  {report === undefined ? (
                    <span className="skeleton inline-block h-3.5 w-36 align-middle" />
                  ) : report ? (
                    <>
                      <span className={cn("mr-2 font-medium", report.veto ? "text-negative" : "text-fg")}>
                        {n.pct(report.riskScoreBps)}
                        {report.veto ? ` · ${ta("veto")}` : ""}
                      </span>
                      {t("last", { date: n.date(report.createdAt) })}
                    </>
                  ) : (
                    t("never")
                  )}
                </span>
                <ActionButton
                  size="sm"
                  variant="outline"
                  className="ml-auto"
                  data-testid={`analyze-${r.symbol}`}
                  label={t("run")}
                  pendingLabel={t("running")}
                  pending={pending && running === r.address}
                  reason={canRun ? null : tr("requires", { role: tr("roles.apiAdmin") })}
                  onClick={() => run(r.address)}
                />
              </li>
            );
          })}
        </ul>
      )}
    </AdminSection>
  );
}
