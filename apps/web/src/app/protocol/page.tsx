"use client";
import { CopyValue } from "@/components/copy-value";
import { CHEVRON, SUMMARY } from "@/components/disclosure";
import { TypeBadge } from "@/components/raise/type-badge";
import { ErrorState, LoadingState } from "@/components/states";
import { explorerUrl } from "@/lib/chains";
import { useApiConfig } from "@/lib/hooks";
import { useNumbers } from "@/lib/use-numbers";
import { cn } from "@/lib/utils";
import {
  ArrowLeftRight,
  ChevronDown,
  ExternalLink,
  Eye,
  Landmark,
  Lock,
  Pin,
  RotateCcw,
  ShieldCheck,
  UserCheck,
  Wallet,
} from "lucide-react";
import { useTranslations } from "next-intl";

function Address({ value }: { value: string }) {
  const t = useTranslations("wallet");
  return (
    <span className="flex min-w-0 items-start gap-2">
      <CopyValue value={value} />
      {explorerUrl ? (
        <a
          href={`${explorerUrl}/address/${value}`}
          target="_blank"
          rel="noreferrer"
          aria-label={t("explorer")}
          className="mt-0.5 shrink-0 text-fg-3 hover:text-fg"
        >
          <ExternalLink className="size-3" />
        </a>
      ) : null}
    </span>
  );
}

export default function ProtocolPage() {
  const t = useTranslations("protocol"),
    v = useTranslations("v31"),
    n = useNumbers();
  const { data, isError, error, refetch } = useApiConfig();
  return (
    <div className="space-y-8 pt-2 lg:pt-4">
      <header className="space-y-2">
        <h1 className="t-title">{t("title")}</h1>
        <p className="text-[0.9375rem] text-fg-2">{v("protocolIntro")}</p>
      </header>
      <section aria-labelledby="guarantees" className="space-y-5" data-testid="protocol-guarantees">
        <div className="space-y-1.5">
          <h2 id="guarantees" className="t-section">
            {t("guarantees.title")}
          </h2>
          <p className="max-w-2xl text-sm leading-relaxed text-fg-2">{t("guarantees.sub")}</p>
        </div>
        <ul className="grid gap-x-10 gap-y-7 border-y border-fg/[0.07] py-8 md:grid-cols-2 xl:grid-cols-3">
          {(
            [
              ["exit", ShieldCheck, "text-protected"],
              ["treasury", Landmark, "text-fg-2"],
              ["dissolution", RotateCcw, "text-fg-2"],
              ["rollover", ArrowLeftRight, "text-protected"],
              ["custody", Wallet, "text-fg-2"],
              ["founders", UserCheck, "text-fg-2"],
              ["pinned", Pin, "text-fg-2"],
              ["liquidity", Lock, "text-fg-2"],
              ["analyst", Eye, "text-fg-2"],
            ] as const
          ).map(([key, Icon, tone]) => (
            <li key={key} className="flex gap-3.5">
              <span className="flex size-8 shrink-0 items-center justify-center rounded-[9px] bg-fg/[0.05] ring-1 ring-inset ring-fg/[0.07]">
                <Icon className={cn("size-4", tone)} aria-hidden />
              </span>
              <div className="min-w-0 space-y-1.5">
                <h3 className="text-sm font-medium">{t(`guarantees.${key}.t`)}</h3>
                <p className="text-[0.8125rem] leading-relaxed text-fg-2">{t(`guarantees.${key}.d`)}</p>
              </div>
            </li>
          ))}
        </ul>
      </section>
      {isError ? (
        <ErrorState error={error} retry={refetch} />
      ) : !data ? (
        <LoadingState />
      ) : (
        <>
          <h2 className="t-section pt-4">{t("guarantees.deployment")}</h2>
          <section className="surface-1 grid gap-6 p-5 md:grid-cols-3" aria-label={t("contracts")}>
            <div className="min-w-0 space-y-2">
              <h3 className="text-xs text-fg-3">{t("registry")}</h3>
              <Address value={data.addresses.registry} />
            </div>
            <div className="min-w-0 space-y-2">
              <h3 className="text-xs text-fg-3">{t("factory")}</h3>
              <Address value={data.addresses.factory} />
            </div>
            <div className="min-w-0 space-y-2">
              <h3 className="text-xs text-fg-3">{v("quoteAsset")}</h3>
              <p className="text-sm">
                {data.quote.symbol}{" "}
                <span className="text-xs text-fg-3">· {v("decimals", { count: data.quote.decimals })}</span>
              </p>
              <Address value={data.quote.address} />
              <p className="text-2xs leading-relaxed text-fg-3">{v("quoteAttestation")}</p>
            </div>
          </section>

          <section className="space-y-3" aria-labelledby="roles">
            <h2 id="roles" className="pt-4 text-base font-medium">
              {t("roles")}
            </h2>
            <div className="surface-1 grid gap-px overflow-hidden bg-hairline md:grid-cols-2">
              {(["attester", "council"] as const).map((role) => (
                <div key={role} className="min-w-0 space-y-2 bg-surface-1 p-5">
                  <h3 className="text-sm font-medium">{t(`role.${role}`)}</h3>
                  <p className="text-xs leading-relaxed text-fg-2">{t(`roleDescription.${role}`)}</p>
                  <Address value={data.addresses[role]} />
                </div>
              ))}
            </div>
          </section>

          <section className="space-y-3" aria-labelledby="templates">
            <h2 id="templates" className="pt-4 text-base font-medium">
              {v("templates")}
            </h2>
            {data.templates.map((template) => {
              const params: [string, string][] = [
                [v("minimumBackers"), n.number(template.parameters.minimumBackers, 0)],
                [v("tradeFee"), n.pct(template.parameters.tradeFeeBps)],
                [v("kappaMax"), `${n.number(Number(template.parameters.kappaMax) / 1e18)}×`],
                ...(template.name === "BUDGET_LAUNCH"
                  ? ([
                      [
                        v("budgetMax"),
                        n.pct(Number((BigInt(template.parameters.budgetCeilingMax) * 10000n) / 10n ** 18n)),
                      ],
                    ] as [string, string][])
                  : []),
                // Governed stage timings, pinned per template version (absent on older deployments).
                ...(template.parameters.stage1Min !== undefined && template.parameters.stage1Max !== undefined
                  ? ([
                      [
                        v("stage1Length"),
                        `${n.duration(Number(template.parameters.stage1Min))}–${n.duration(Number(template.parameters.stage1Max))}`,
                      ],
                    ] as [string, string][])
                  : []),
                ...(template.parameters.stage2Min !== undefined && template.parameters.stage2Max !== undefined
                  ? ([
                      [
                        v("stage2Length"),
                        `${n.duration(Number(template.parameters.stage2Min))}–${n.duration(Number(template.parameters.stage2Max))}`,
                      ],
                    ] as [string, string][])
                  : []),
                ...(template.parameters.treasuryVesting !== undefined
                  ? ([[v("treasuryVesting"), n.duration(Number(template.parameters.treasuryVesting))]] as [
                      string,
                      string,
                    ][])
                  : []),
                [v("vetoBudget"), n.duration(Number(template.parameters.vetoTotal))],
                [v("vetoMaximum"), n.duration(Number(template.parameters.vetoMax))],
                [v("vetoCooldown"), n.duration(Number(template.parameters.vetoCooldown))],
              ];
              return (
                <article
                  key={`${template.id}-${template.version}`}
                  className="surface-1 space-y-5 p-5"
                  data-testid={`template-${template.name}`}
                >
                  <div className="flex flex-wrap items-center gap-3">
                    <TypeBadge template={template.name} />
                    <h3 className="text-sm font-medium">
                      {v("version")} {template.version}
                    </h3>
                    <span
                      className={cn(
                        "rounded-full px-2 py-0.5 text-2xs font-medium",
                        template.deprecated ? "bg-surface-3 text-fg-3" : "bg-positive/10 text-positive",
                      )}
                    >
                      {template.deprecated ? v("deprecated") : v("active")}
                    </span>
                  </div>
                  <dl className="grid grid-cols-2 gap-x-6 gap-y-5 sm:grid-cols-4">
                    {params.map(([label, value]) => (
                      <div key={label} className="min-w-0">
                        <dt className="eyebrow">{label}</dt>
                        <dd className="num mt-1 text-sm">{value}</dd>
                      </div>
                    ))}
                  </dl>
                  <div className="space-y-2 border-t border-hairline pt-4">
                    <h4 className="eyebrow">{v("bundleHash")}</h4>
                    <CopyValue value={template.bundleHash} />
                  </div>
                  <details className="group border-t border-hairline">
                    <summary className={cn(SUMMARY, "pb-0 text-sm text-fg")}>
                      {v("implementations")}
                      <ChevronDown className={CHEVRON} aria-hidden />
                    </summary>
                    <dl className="mt-3 grid gap-4 sm:grid-cols-2">
                      {Object.entries(template.implementations).map(([key, value]) => (
                        <div key={key} className="min-w-0 space-y-1">
                          <dt className="text-xs text-fg-2">{v(`module${key}`)}</dt>
                          <dd>
                            <Address value={value} />
                          </dd>
                        </div>
                      ))}
                    </dl>
                  </details>
                </article>
              );
            })}
          </section>
        </>
      )}
    </div>
  );
}
