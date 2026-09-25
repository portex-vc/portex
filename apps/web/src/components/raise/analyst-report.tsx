"use client";

import { ActionButton } from "@/components/action-button";
import { CHEVRON, SUMMARY } from "@/components/disclosure";
import { Mark } from "@/components/brand/logo";
import { Reveal } from "@/components/motion/reveal";
import { Term } from "@/components/term";
import { api, type RaiseDetail } from "@/lib/api";
import { queryKeys } from "@/lib/hooks";
import { useNumbers } from "@/lib/use-numbers";
import { useSignedWrite } from "@/lib/use-signed-write";
import { cn } from "@/lib/utils";
import { ChevronDown } from "lucide-react";
import { useTranslations } from "next-intl";
import { useAccount } from "wagmi";

export function AnalystReport({ detail }: { detail: RaiseDetail }) {
  const t = useTranslations("analyst");
  const n = useNumbers();
  const { address: user } = useAccount();
  const { send, pending: running } = useSignedWrite();
  const report = detail.latestReport;
  const run = () =>
    send(t("run"), (signer) => api.analyze(detail.address, signer), [
      queryKeys.raise(detail.address),
      queryKeys.report(detail.address),
    ]);
  return (
    <section className="surface-1 p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-sm font-medium">{t("title")}</h3>
        <ActionButton
          label={t("run")}
          reason={!user ? t("connect") : null}
          pendingLabel={t("running")}
          pending={running}
          size="sm"
          variant="outline"
          onClick={run}
        />
      </div>
      <p className="mt-2 max-w-2xl text-xs leading-relaxed text-fg-3">{t("description")}</p>
      {detail.vetoActive ? (
        <p className="mt-4 rounded-md border border-negative/40 bg-negative/10 p-3 text-xs text-negative">
          <Term k="veto">{t("activeVeto")}</Term>
        </p>
      ) : null}
      {report ? (
        <div className="mt-5">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-hairline bg-surface-2/50 px-4 py-3">
            <span className="num text-xs text-fg-2">
              {t("risk")}: <span className="text-base font-medium text-fg">{n.pct(report.riskScoreBps)}</span>
            </span>
            <span
              className={cn(
                "rounded-full px-2 py-0.5 text-2xs font-medium",
                report.veto ? "bg-negative/10 text-negative" : "bg-positive/10 text-positive",
              )}
            >
              {t(report.veto ? "veto" : "noVeto")}
            </span>
            <time className="num ml-auto text-xs text-fg-3">{n.date(report.createdAt)}</time>
          </div>
          {report.builderResponse ? (
            <aside className="mt-4 rounded-lg border border-hairline bg-surface-2 p-4" data-testid="builder-response">
              <h4 className="text-xs font-medium">{t("builderResponse")}</h4>
              <time className="num text-2xs text-fg-3">{n.date(report.builderResponse.createdAt)}</time>
              <p className="mt-2 whitespace-pre-wrap text-sm text-fg-2">{report.builderResponse.text}</p>
            </aside>
          ) : null}
          <ul className="mt-5 divide-y divide-hairline border-y border-hairline">
            {report.findings.map((finding, i) => (
              <li key={i}>
                <Reveal index={i} className="py-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <span
                      className={cn(
                        "rounded-full px-2 py-0.5 text-2xs font-medium",
                        finding.severity === "critical"
                          ? "bg-negative/10 text-negative"
                          : finding.severity === "warn"
                            ? "bg-risk/10 text-risk"
                            : "bg-info/10 text-info",
                      )}
                    >
                      {t(`severity.${finding.severity}`)}
                    </span>
                    <h4 className="text-sm font-medium">{finding.title}</h4>
                  </div>
                  <p className="mt-1.5 break-words text-xs leading-relaxed text-fg-2">{finding.detail}</p>
                </Reveal>
              </li>
            ))}
          </ul>
          <details className="group border-b border-hairline">
            <summary className={SUMMARY}>
              {t("panel")}
              <ChevronDown className={CHEVRON} aria-hidden />
            </summary>
            <ul className="space-y-3 pb-4">
              {report.panel.map((member, i) => (
                <li key={i} className="text-xs">
                  <p className="num">
                    {member.scorer} · {n.pct(member.riskScoreBps)}
                    {member.veto ? ` · ${t("veto")}` : ""}
                  </p>
                  <p className="mt-1 text-fg-2">{member.rationale}</p>
                </li>
              ))}
            </ul>
          </details>
          <details className="group">
            <summary className={cn(SUMMARY, "pb-0 group-open:pb-3")}>
              {t("metrics")}
              <ChevronDown className={CHEVRON} aria-hidden />
            </summary>
            <dl className="space-y-2">
              {Object.entries(report.metrics).map(([key, value]) => (
                <div key={key} className="flex flex-wrap justify-between gap-2 text-xs">
                  <dt className="break-all text-fg-2">{key}</dt>
                  <dd className="num break-all">{String(value)}</dd>
                </div>
              ))}
            </dl>
            <p className="mt-4 break-all font-mono text-2xs text-fg-3">{report.reportHash}</p>
          </details>
        </div>
      ) : (
        <div className="mt-5 flex flex-col items-center gap-2 rounded-lg border border-dashed border-hairline-strong py-6 text-center">
          <Mark size={24} className="text-fg-3" />
          <p className="text-sm text-fg-2">{t("empty")}</p>
        </div>
      )}
    </section>
  );
}
