"use client";

import { ConnectPrompt } from "@/components/shell/wallet";
import { ADMIN_ROLES } from "@/lib/admin";
import { useHydrated } from "@/lib/hooks";
import { useAdminRoles } from "@/lib/use-admin";
import { cn } from "@/lib/utils";
import { ArrowRight, UserCog } from "lucide-react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { AnalysisSection } from "./analysis-section";
import { ParametersSection, useProtocolParameters } from "./parameters-section";
import { QuoteSection } from "./quote-section";
import { RoleChip } from "./shared";
import { VersionsSection } from "./versions-section";
import { VetoesSection } from "./vetoes-section";

export function AdminConsole() {
  const t = useTranslations("admin");
  const hydrated = useHydrated();
  const { address, roles, has, loading, config, modules } = useAdminRoles();
  const registry = config?.addresses.registry;
  const { parameters } = useProtocolParameters(has("curator") ? registry : undefined);
  const checking = !hydrated || (Boolean(address) && (loading || !config));

  const sections = [
    ...(has("curator")
      ? [
          { id: "parameters", label: t("params.title") },
          { id: "versions", label: t("versions.title") },
          { id: "quote", label: t("quote.title") },
        ]
      : []),
    ...(has("attester") || has("council") ? [{ id: "vetoes", label: t("vetoes.title") }] : []),
    ...(has("apiAdmin") ? [{ id: "analysis", label: t("analysis.title") }] : []),
  ];

  return (
    <div className="space-y-10 pt-2 lg:pt-4" data-testid="admin-console">
      <header className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
        <div className="max-w-2xl space-y-2">
          <h1 className="t-title">{t("title")}</h1>
          <p className="text-pretty text-[0.9375rem] leading-relaxed text-fg-2">{t("description")}</p>
        </div>
        {!checking && roles.length ? (
          <div className="space-y-2 lg:text-right" data-testid="admin-roles">
            <p className="text-xs text-fg-3">{t("heldBy")}</p>
            <div className="flex flex-wrap gap-1.5 lg:justify-end">
              {ADMIN_ROLES.filter((r) => roles.includes(r)).map((role) => (
                <RoleChip key={role} role={role} className="py-1 text-xs" />
              ))}
            </div>
          </div>
        ) : null}
      </header>

      {checking ? (
        <div className="space-y-4" aria-busy data-testid="admin-checking">
          <p className="text-sm text-fg-3">{t("checking")}</p>
          <div className="skeleton h-40 rounded-[14px]" />
          <div className="skeleton h-64 rounded-[14px]" />
        </div>
      ) : !address || !roles.length || !config ? (
        <Outsider connected={Boolean(address)} />
      ) : (
        <>
          {sections.length > 1 ? (
            <nav
              aria-label={t("title")}
              className="scroll-thin -mx-1 flex gap-1 overflow-x-auto border-b border-fg/[0.07] px-1 pb-3"
            >
              {sections.map((s) => (
                <a
                  key={s.id}
                  href={`#${s.id}`}
                  className="shrink-0 rounded-[9px] px-3 py-1.5 text-[0.8125rem] text-fg-2 transition-colors hover:bg-fg/[0.05] hover:text-fg"
                >
                  {s.label}
                </a>
              ))}
            </nav>
          ) : null}
          <div className="space-y-16">
            {has("curator") && registry ? (
              <>
                <ParametersSection registry={registry} canEdit />
                <VersionsSection config={config} current={parameters} canEdit />
                <QuoteSection config={config} canEdit />
              </>
            ) : null}
            {has("attester") || has("council") ? (
              <VetoesSection roles={roles} address={address} modules={modules} />
            ) : null}
            {has("apiAdmin") ? <AnalysisSection canRun /> : null}
          </div>
        </>
      )}
    </div>
  );
}

/** Calm state for everyone without a role: what the page is for, and no actions. */
function Outsider({ connected }: { connected: boolean }) {
  const t = useTranslations("admin.outsider");
  return (
    <section
      className="surface-1 flex flex-col items-center px-6 py-14 text-center sm:py-16"
      data-testid="admin-outsider"
    >
      <span className="flex size-11 items-center justify-center rounded-[13px] border border-fg/[0.1] bg-fg/[0.04] text-fg-2">
        <UserCog className="size-5" aria-hidden />
      </span>
      <h2 className="t-section mt-5">{t("title")}</h2>
      <p className="mt-2 max-w-lg text-sm leading-relaxed text-fg-2">{t(connected ? "body" : "intro")}</p>
      {!connected ? (
        <div className="mt-6">
          <ConnectPrompt text={t("connect")} className={cn("items-center text-center")} />
        </div>
      ) : null}
      <Link
        href="/protocol"
        className="group mt-6 inline-flex items-center gap-1.5 text-xs text-fg-3 transition-colors hover:text-fg"
      >
        {t("link")}
        <ArrowRight className="size-3.5 transition-transform duration-200 group-hover:translate-x-0.5" aria-hidden />
      </Link>
    </section>
  );
}
