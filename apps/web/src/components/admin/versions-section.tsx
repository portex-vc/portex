"use client";

import { ActionButton } from "@/components/action-button";
import { CopyValue } from "@/components/copy-value";
import { CHEVRON, SUMMARY } from "@/components/disclosure";
import type { Row } from "@/components/figures";
import { TypeBadge } from "@/components/raise/type-badge";
import { TestnetRibbon } from "@/components/testnet-timing";
import { diffParameters, PARAMETER_GROUPS, toParameters, type ProtocolParameters } from "@/lib/admin";
import type { ApiConfig } from "@/lib/api";
import { appChain } from "@/lib/chains";
import { registryAbi } from "@/lib/contracts";
import { queryKeys, useTx } from "@/lib/hooks";
import { launchTypeKey } from "@/lib/launch-types";
import { useNumbers } from "@/lib/use-numbers";
import { cn, shortAddress } from "@/lib/utils";
import { ChevronDown } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import type { Address } from "viem";
import { useReadContract } from "wagmi";
import { useParameterFormat } from "./parameters-section";
import { AdminSection, ConfirmRow, Fact } from "./shared";

type Template = ApiConfig["templates"][number];
const IMPLEMENTATION_KEYS = [
  "raise",
  "token",
  "vesting",
  "governor",
  "claims",
  "adapter",
  "quote",
  "attester",
  "council",
  "treasury",
] as const;

/** Whether the registry would accept `quote` in a published bundle: whitelisted, frozen, same code. */
function useQuoteAdmitted(registry: string, quote?: string) {
  const opts = { enabled: Boolean(quote), staleTime: 15_000 };
  const frozen = useReadContract({
    address: registry as Address,
    abi: registryAbi,
    functionName: "quoteFrozen",
    args: [quote as Address],
    chainId: appChain.id,
    query: opts,
  });
  const hash = useReadContract({
    address: registry as Address,
    abi: registryAbi,
    functionName: "quoteCodeHash",
    args: [quote as Address],
    chainId: appChain.id,
    query: opts,
  });
  if (frozen.data === undefined || hash.data === undefined) return null;
  return frozen.data === true && !/^0x0{64}$/.test(String(hash.data));
}

export function VersionsSection({
  config,
  current,
  canEdit,
}: {
  config: ApiConfig;
  current: ProtocolParameters | null;
  canEdit: boolean;
}) {
  const t = useTranslations("admin.versions");
  const names = [...new Set(config.templates.map((x) => x.name))];
  return (
    <AdminSection id="versions" title={t("title")} description={t("description")} roles={["curator"]}>
      <div className="grid gap-5 xl:grid-cols-2">
        {names.map((name) => (
          <TemplateCard
            key={name}
            registry={config.addresses.registry}
            versions={config.templates
              .filter((x) => x.name === name)
              .sort((a, b) => (BigInt(b.version) > BigInt(a.version) ? 1 : -1))}
            current={current}
            canEdit={canEdit}
          />
        ))}
      </div>
    </AdminSection>
  );
}

function TemplateCard({
  registry,
  versions,
  current,
  canEdit,
}: {
  registry: string;
  versions: Template[];
  current: ProtocolParameters | null;
  canEdit: boolean;
}) {
  const t = useTranslations("admin.versions");
  const ta = useTranslations("admin");
  const tp = useTranslations("admin.params");
  const tt = useTranslations("types");
  const tv = useTranslations("v31");
  const n = useNumbers();
  const format = useParameterFormat();
  const { send, pending } = useTx();
  const [confirming, setConfirming] = useState<string | null>(null);
  const latest = versions[0];
  const next = (BigInt(latest.version) + 1n).toString();
  const pinnedLatest = toParameters(latest.parameters);
  const changes = current && pinnedLatest ? diffParameters(pinnedLatest, current) : [];
  const admitted = useQuoteAdmitted(registry, latest.implementations.quote);

  async function publish() {
    const implementations = Object.fromEntries(
      IMPLEMENTATION_KEYS.map((k) => [k, latest.implementations[k] as Address]),
    );
    const preview: Row[] = [
      [tt(`${launchTypeKey(latest.name)}.title`), `v${next}`],
      ...changes.map((key): Row => [
        tp(`fields.${key}`),
        `${format(key, pinnedLatest![key])} → ${format(key, current![key])}`,
      ]),
    ];
    await send(
      {
        address: registry as Address,
        abi: registryAbi,
        functionName: "publish",
        args: [latest.id, BigInt(next), implementations],
      },
      { label: t("publish", { version: next }), preview, invalidate: [queryKeys.config] },
    );
  }

  async function deprecate(version: string) {
    setConfirming(null);
    await send(
      { address: registry as Address, abi: registryAbi, functionName: "deprecate", args: [latest.id, BigInt(version)] },
      {
        label: `${t("deprecate")} v${version}`,
        preview: [[tt(`${launchTypeKey(latest.name)}.title`), `v${version}`]],
        invalidate: [queryKeys.config],
      },
    );
  }

  return (
    <article className="surface-1 relative flex min-w-0 flex-col" data-testid={`versions-${latest.name}`}>
      <TestnetRibbon pinned={latest.parameters} />
      <header className="flex items-center gap-3 border-b border-fg/[0.07] px-5 py-4">
        <TypeBadge template={latest.name} />
        <h3 className="text-sm font-medium">{tt(`${launchTypeKey(latest.name)}.title`)}</h3>
      </header>

      {canEdit ? (
        <div
          className="space-y-3 border-b border-fg/[0.07] bg-fg/[0.015] px-5 py-4"
          data-testid={`publish-${latest.name}`}
        >
          <div>
            <p className="text-sm font-medium">{t("publishTitle", { version: next })}</p>
            <p className="mt-1 text-xs leading-relaxed text-fg-3">{t("publishBody", { from: latest.version })}</p>
          </div>
          {current && pinnedLatest ? (
            changes.length ? (
              <div className="space-y-1.5">
                <p className="text-xs text-fg-2">{t("changes", { version: latest.version })}</p>
                <ul className="flex flex-wrap gap-1.5">
                  {changes.map((key) => (
                    <li
                      key={key}
                      className="num rounded-full border border-fg/[0.1] bg-fg/[0.03] px-2.5 py-1 text-2xs text-fg-2"
                    >
                      {tp(`fields.${key}`)} <span className="text-fg-3">{format(key, pinnedLatest[key])}</span>
                      <span aria-hidden className="mx-1 text-fg-3">
                        →
                      </span>
                      <span className="text-fg">{format(key, current[key])}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <p className="text-xs text-fg-3">{t("same", { version: latest.version })}</p>
            )
          ) : null}
          <ActionButton
            size="sm"
            variant="outline"
            data-testid={`publish-${latest.name}-submit`}
            label={t("publish", { version: next })}
            pending={pending}
            reason={!current ? t("loading") : admitted === false ? t("quoteNotAdmitted") : null}
            onClick={publish}
          />
        </div>
      ) : null}

      <ul className="divide-y divide-fg/[0.06]">
        {versions.map((v, i) => {
          const pinned = toParameters(v.parameters);
          const key = `${v.name}-${v.version}`;
          return (
            <li key={key} className="px-5 py-4" data-testid={`version-${v.name}-${v.version}`}>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                <span className="num font-mono text-sm text-fg">v{v.version}</span>
                <span
                  className={cn(
                    "rounded-full px-2 py-0.5 text-2xs font-medium",
                    v.deprecated ? "bg-fg/[0.06] text-fg-3" : "bg-positive/10 text-positive",
                  )}
                >
                  {tv(v.deprecated ? "deprecated" : "active")}
                </span>
                {i === 0 ? <span className="text-2xs text-fg-3">{t("latest")}</span> : null}
                <span className="num ml-auto text-xs text-fg-3">
                  {t("published", { date: n.date(Number(v.publishedAt)) })}
                </span>
              </div>
              <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                <CopyValue value={v.bundleHash} display={shortAddress(v.bundleHash, 8)} />
                {canEdit && !v.deprecated && confirming !== key ? (
                  <button
                    type="button"
                    data-testid={`deprecate-${v.name}-${v.version}`}
                    onClick={() => setConfirming(key)}
                    disabled={pending}
                    className="h-7 rounded-[8px] px-2.5 text-xs text-fg-2 transition-colors hover:bg-fg/[0.05] hover:text-fg disabled:opacity-50"
                  >
                    {t("deprecate")}
                  </button>
                ) : null}
              </div>
              {confirming === key ? (
                <div className="mt-3">
                  <ConfirmRow
                    testId={`deprecate-${v.name}-${v.version}-confirm-row`}
                    message={t("confirmDeprecate", { version: v.version })}
                    confirmLabel={t("deprecate")}
                    cancelLabel={ta("cancel")}
                    onCancel={() => setConfirming(null)}
                    onConfirm={() => deprecate(v.version)}
                  />
                </div>
              ) : null}
              <details className="group mt-2">
                <summary className={cn(SUMMARY, "w-fit gap-1.5 py-1.5")}>
                  {t("pinned")}
                  <ChevronDown className={CHEVRON} aria-hidden />
                </summary>
                <div className="mt-2 grid gap-x-8 sm:grid-cols-2">
                  {pinned ? (
                    <dl className="divide-y divide-fg/[0.06]">
                      {PARAMETER_GROUPS.flatMap((g) => g.fields).map((f) => (
                        <Fact key={f} label={tp(`fields.${f}`)} className="py-1.5 [&_dd]:text-xs">
                          {format(f, pinned[f])}
                        </Fact>
                      ))}
                    </dl>
                  ) : null}
                  <dl className="divide-y divide-fg/[0.06]">
                    {IMPLEMENTATION_KEYS.map((k) => (
                      <Fact key={k} label={tv(`module${k}`)} className="py-1.5 [&_dd]:font-mono [&_dd]:text-2xs">
                        <span title={v.implementations[k]}>{shortAddress(v.implementations[k], 6)}</span>
                      </Fact>
                    ))}
                  </dl>
                </div>
              </details>
            </li>
          );
        })}
      </ul>
    </article>
  );
}
