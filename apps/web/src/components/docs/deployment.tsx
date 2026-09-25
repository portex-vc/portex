"use client";

import { appChain, explorerUrl, xLayerTestnet } from "@/lib/chains";
import { registryAbi } from "@/lib/contracts";
import { useApiConfig, useHealth } from "@/lib/hooks";
import { cn, shortAddress } from "@/lib/utils";
import { ArrowUpRight, Check, Copy } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { useState } from "react";
import type { Address } from "viem";
import { useReadContract } from "wagmi";

function CopyButton({ value, label }: { value: string; label: string }) {
  const t = useTranslations("common");
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      aria-label={`${t(copied ? "copied" : "copy")}: ${label}`}
      className="inline-flex size-7 shrink-0 items-center justify-center rounded-[8px] text-fg-3 transition-colors hover:bg-fg/[0.06] hover:text-fg"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1200);
        } catch {
          setCopied(false);
        }
      }}
    >
      {copied ? <Check className="size-3.5" aria-hidden /> : <Copy className="size-3.5" aria-hidden />}
    </button>
  );
}

function ExplorerLink({ path, label }: { path: string; label: string }) {
  const t = useTranslations("common");
  if (!explorerUrl) return <span className="size-7 shrink-0" aria-hidden />;
  return (
    <a
      href={`${explorerUrl}/${path}`}
      target="_blank"
      rel="noreferrer"
      aria-label={`${t("explorer")}: ${label}`}
      className="inline-flex size-7 shrink-0 items-center justify-center rounded-[8px] text-fg-3 transition-colors hover:bg-fg/[0.06] hover:text-fg"
    >
      <ArrowUpRight className="size-3.5" aria-hidden />
    </a>
  );
}

type Row = { label: string; value: string | null | undefined; kind: "address" | "hash" | "block" | "text" };

function Value({ row }: { row: Row }) {
  if (!row.value) return <span className="skeleton inline-block h-4 w-40 align-middle" />;
  const mono = row.kind !== "text";
  return (
    <span className="flex min-w-0 items-center gap-1">
      <span
        className={cn("min-w-0 truncate", mono ? "font-mono text-xs text-fg-2" : "num text-sm text-fg")}
        title={row.value}
      >
        <span className="hidden md:inline">{row.value}</span>
        <span className="md:hidden">
          {row.kind === "address" || row.kind === "hash" ? shortAddress(row.value, 6) : row.value}
        </span>
      </span>
      {row.kind !== "text" ? <CopyButton value={row.value} label={row.label} /> : null}
      {row.kind === "address" ? <ExplorerLink path={`address/${row.value}`} label={row.label} /> : null}
      {row.kind === "block" ? <ExplorerLink path={`block/${row.value}`} label={row.label} /> : null}
    </span>
  );
}

function Group({ title, rows }: { title: string; rows: Row[] }) {
  return (
    <div className="overflow-hidden rounded-[12px] border border-fg/[0.08]">
      <p className="bg-fg/[0.025] px-4 py-2.5 text-xs text-fg-3">{title}</p>
      <dl className="divide-y divide-fg/[0.07]">
        {rows.map((row) => (
          <div
            key={row.label}
            className="grid items-center gap-x-4 gap-y-1 px-4 py-2.5 sm:grid-cols-[12rem_minmax(0,1fr)]"
            data-testid="deployment-row"
          >
            <dt className="text-sm text-fg">{row.label}</dt>
            <dd className="min-w-0">
              <Value row={row} />
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/**
 * Every deployed contract, read from `/v2/config` and the deployment manifest the API serves on `/v2/health`,
 * each with a copy button and an explorer link. Nothing here is typed into the copy.
 */
export function DeployedContracts() {
  const t = useTranslations("docs.deployment");
  const format = useFormatter();
  const { data: config } = useApiConfig();
  const { data: health } = useHealth();
  const manifest = (health as unknown as { deployment?: Record<string, unknown> } | undefined)?.deployment ?? null;
  const pick = (key: string) => (typeof manifest?.[key] === "string" ? (manifest[key] as string) : null);
  const a = config?.addresses;
  const { data: curator } = useReadContract({
    address: a?.registry as Address | undefined,
    abi: registryAbi,
    functionName: "curator",
    query: { enabled: Boolean(a?.registry) },
  });
  const current = ["ESCROW_LAUNCH", "BUDGET_LAUNCH"]
    .map(
      (name) =>
        (config?.templates ?? [])
          .filter((x) => x.name === name && !x.deprecated)
          .sort((x, y) => Number(BigInt(y.version) - BigInt(x.version)))[0],
    )
    .filter(Boolean);
  const escrow = current.find((x) => x.name === "ESCROW_LAUNCH");
  const impl = escrow?.implementations;
  const type = (name: string) => t(name === "ESCROW_LAUNCH" ? "escrow" : "budget");
  const block = manifest?.deploymentBlock;
  const groups: { title: string; rows: Row[] }[] = [
    {
      title: t("groups.protocol"),
      rows: [
        { label: t("registry"), value: a?.registry, kind: "address" },
        { label: t("factory"), value: a?.factory, kind: "address" },
        { label: t("rollover"), value: a?.rolloverRouter, kind: "address" },
      ],
    },
    {
      title: t("groups.market"),
      rows: [
        { label: t("router"), value: a?.router, kind: "address" },
        { label: t("adapter"), value: a?.adapter, kind: "address" },
        { label: t("hook"), value: pick("initializeHook"), kind: "address" },
        { label: t("poolManager"), value: a?.poolManager, kind: "address" },
        { label: config?.quote.symbol ?? "USDG", value: config?.quote.address, kind: "address" },
      ],
    },
    {
      title: t("groups.implementations", { version: escrow?.version ?? "—" }),
      rows: [
        { label: t("impl.raise"), value: impl?.raise, kind: "address" },
        { label: t("impl.token"), value: impl?.token, kind: "address" },
        { label: t("impl.vesting"), value: impl?.vesting, kind: "address" },
        { label: t("impl.governor"), value: impl?.governor, kind: "address" },
        { label: t("impl.claims"), value: impl?.claims, kind: "address" },
        { label: t("impl.treasury"), value: impl?.treasury, kind: "address" },
      ],
    },
    {
      title: t("groups.roles"),
      rows: [
        { label: t("curator"), value: curator as string | undefined, kind: "address" },
        { label: t("attester"), value: a?.attester, kind: "address" },
        { label: t("council"), value: a?.council, kind: "address" },
      ],
    },
    {
      title: t("groups.deployment"),
      rows: [
        { label: t("chainId"), value: config ? String(config.chainId) : null, kind: "text" },
        {
          label: t("block"),
          value: block !== undefined && block !== null ? String(block) : config ? t("notRecorded") : null,
          kind: block !== undefined && block !== null ? "block" : "text",
        },
        ...current.map((x) => ({
          label: t("bundle", { type: type(x.name), version: x.version }),
          value: x.bundleHash,
          kind: "hash" as const,
        })),
      ],
    },
  ];
  return (
    <div className="my-6 flex flex-col gap-4" data-testid="docs-contracts">
      {groups.map((g) => (
        <Group key={g.title} title={g.title} rows={g.rows} />
      ))}
      {config && escrow ? (
        <p className="text-xs leading-5 text-fg-3">
          {t("published", {
            date: format.dateTime(new Date(Number(escrow.publishedAt) * 1000), {
              year: "numeric",
              month: "short",
              day: "numeric",
              timeZone: "UTC",
            }),
          })}
        </p>
      ) : null}
    </div>
  );
}

/** The X Layer testnet as a wallet needs it, from the app's own chain definition. */
export function NetworkFacts() {
  const t = useTranslations("docs.deployment");
  const chain = xLayerTestnet;
  const explorer = chain.blockExplorers?.default.url ?? "";
  const rows: { label: string; value: string; copy?: boolean; href?: string }[] = [
    { label: t("networkName"), value: chain.name },
    { label: t("chainId"), value: String(chain.id), copy: true },
    { label: t("rpc"), value: chain.rpcUrls.default.http[0], copy: true },
    { label: t("currency"), value: chain.nativeCurrency.symbol },
    { label: t("explorer"), value: explorer, href: explorer },
  ];
  return (
    <div className="my-6 overflow-hidden rounded-[12px] border border-fg/[0.08]" data-testid="docs-network">
      <dl className="divide-y divide-fg/[0.07]">
        {rows.map((row) => (
          <div
            key={row.label}
            className="grid items-center gap-x-4 gap-y-1 px-4 py-2.5 sm:grid-cols-[12rem_minmax(0,1fr)]"
          >
            <dt className="text-sm text-fg">{row.label}</dt>
            <dd className="flex min-w-0 items-center gap-1">
              {row.href ? (
                <a href={row.href} target="_blank" rel="noreferrer" className="link min-w-0 truncate text-sm">
                  {row.value}
                </a>
              ) : (
                <span className="num min-w-0 truncate font-mono text-xs text-fg-2">{row.value}</span>
              )}
              {row.copy ? <CopyButton value={row.value} label={row.label} /> : null}
            </dd>
          </div>
        ))}
      </dl>
      {appChain.id !== chain.id ? (
        <p className="border-t border-fg/[0.07] px-4 py-2.5 text-xs text-fg-3">
          {t("otherChain", { name: appChain.name })}
        </p>
      ) : null}
    </div>
  );
}
