"use client";

import { ActionButton } from "@/components/action-button";
import { CopyValue } from "@/components/copy-value";
import { Input } from "@/components/ui/input";
import type { ApiConfig } from "@/lib/api";
import { erc20Abi, registryAbi } from "@/lib/contracts";
import { queryKeys, useTx } from "@/lib/hooks";
import { cn, shortAddress } from "@/lib/utils";
import { txPublicClient } from "@/lib/wallet-client";
import { useQuery } from "@tanstack/react-query";
import { Check, Minus } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { isAddress, type Address } from "viem";
import { useAccount, useConfig } from "wagmi";
import { AdminSection, ConfirmRow, Fact, Switch } from "./shared";

const FLAGS = ["feeOnTransfer", "rebasing", "pausable", "quoteFrozen"] as const;
type Flags = Record<(typeof FLAGS)[number], boolean>;

function Status({ ok, yes, no }: { ok: boolean | undefined; yes: string; no: string }) {
  if (ok === undefined) return <span className="skeleton inline-block h-5 w-20 align-middle" />;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-2xs font-medium",
        ok ? "bg-fg/[0.07] text-fg" : "bg-risk/10 text-risk",
      )}
    >
      {ok ? <Check className="size-3" aria-hidden /> : <Minus className="size-3" aria-hidden />}
      {ok ? yes : no}
    </span>
  );
}

/** Registry status of one quote asset (`quoteFrozen`, `quoteCodeHash`), served by `/v2/config`. */
export function quoteStatus(config: ApiConfig, quote?: string): { frozen: boolean; codeHash: string } | undefined {
  if (!quote) return undefined;
  return Object.entries(config.quotes ?? {}).find(([k]) => k.toLowerCase() === quote.toLowerCase())?.[1];
}

export function QuoteSection({ config, canEdit }: { config: ApiConfig; canEdit: boolean }) {
  const t = useTranslations("admin.quote");
  const tv = useTranslations("v31");
  const registry = config.addresses.registry as Address;
  const quote = config.quote.address as Address;
  const status = quoteStatus(config, quote);
  const hash = status?.codeHash;
  const whitelisted = hash === undefined ? undefined : !/^0x0{64}$/.test(hash);
  const frozen = status?.frozen ?? (config.quotes ? undefined : config.quote.quoteFrozen);

  return (
    <AdminSection id="quote" title={t("title")} description={t("description")} roles={["curator"]}>
      <div className={cn("grid items-start gap-5", canEdit && "lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]")}>
        <div className="surface-1 p-5 sm:p-6" data-testid="quote-status">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-base font-medium">{config.quote.symbol}</p>
            <span className="text-xs text-fg-3">· {tv("decimals", { count: config.quote.decimals })}</span>
            <span className="ml-auto flex gap-1.5">
              <Status ok={whitelisted} yes={t("whitelisted")} no={t("notWhitelisted")} />
              <Status ok={frozen} yes={t("frozen")} no={t("notFrozen")} />
            </span>
          </div>
          <dl className="mt-4 divide-y divide-fg/[0.06] border-t border-fg/[0.07]">
            <Fact label={tv("quoteAsset")}>
              <CopyValue value={quote} display={shortAddress(quote, 6)} />
            </Fact>
            <Fact label={t("codeHash")}>
              {hash && whitelisted ? <CopyValue value={hash} display={shortAddress(hash, 8)} /> : "—"}
            </Fact>
          </dl>
          <p className="mt-4 text-xs leading-relaxed text-fg-3">{tv("quoteAttestation")}</p>
        </div>
        {canEdit ? <WhitelistForm registry={registry} /> : null}
      </div>
    </AdminSection>
  );
}

function WhitelistForm({ registry }: { registry: Address }) {
  const t = useTranslations("admin.quote");
  const ta = useTranslations("admin");
  const [asset, setAsset] = useState("");
  const [flags, setFlags] = useState<Flags>({
    feeOnTransfer: false,
    rebasing: false,
    pausable: false,
    quoteFrozen: true,
  });
  const [confirming, setConfirming] = useState(false);
  const { send, pending } = useTx();
  const valid = isAddress(asset.trim());
  // A pre-signing check of an address the curator typed: asked through the curator's own wallet.
  const wagmiConfig = useConfig();
  const { isConnected } = useAccount();
  const decimals = useQuery({
    queryKey: ["wallet-check", "decimals", asset.trim().toLowerCase()],
    queryFn: async () =>
      (await txPublicClient(wagmiConfig)).readContract({
        address: asset.trim() as Address,
        abi: erc20Abi,
        functionName: "decimals",
      } as never) as Promise<number>,
    enabled: valid && isConnected,
    retry: false,
  });
  const badFlags = flags.feeOnTransfer || flags.rebasing || flags.pausable;
  const reason = !valid
    ? t("errors.address")
    : badFlags
      ? t("errors.flags")
      : !flags.quoteFrozen
        ? t("errors.frozen")
        : decimals.isLoading
          ? t("errors.checking")
          : decimals.isError || Number(decimals.data) !== 6
            ? t("errors.decimals")
            : null;

  async function submit() {
    setConfirming(false);
    await send(
      {
        address: registry,
        abi: registryAbi,
        functionName: "whitelistQuote",
        args: [asset.trim(), flags.feeOnTransfer, flags.rebasing, flags.pausable, flags.quoteFrozen],
      },
      {
        label: t("submit"),
        preview: [
          [t("address"), shortAddress(asset.trim(), 6)],
          ...FLAGS.map((f): [string, string] => [t(`flags.${f}`), f === "quoteFrozen" ? "✓" : "—"]),
        ],
        invalidate: [queryKeys.config],
        onSuccess: () => {
          setAsset("");
        },
      },
    );
  }

  return (
    <form
      className="surface-1 space-y-5 p-5 sm:p-6"
      data-testid="whitelist-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (!reason) setConfirming(true);
      }}
    >
      <div>
        <p className="text-sm font-medium">{t("admit")}</p>
        <p className="mt-1 text-xs leading-relaxed text-fg-3">{t("admitBody")}</p>
      </div>
      <label className="block space-y-2 text-xs text-fg-2">
        <span>{t("address")}</span>
        <Input
          className="font-mono text-[0.8125rem]"
          placeholder="0x…"
          spellCheck={false}
          autoComplete="off"
          value={asset}
          aria-invalid={(asset.length > 0 && !valid) || undefined}
          onChange={(e) => {
            setAsset(e.target.value);
            setConfirming(false);
          }}
        />
      </label>
      <ul className="divide-y divide-fg/[0.06] rounded-[12px] border border-fg/[0.08]">
        {FLAGS.map((f) => {
          const wrong = f === "quoteFrozen" ? !flags[f] : flags[f];
          return (
            <li key={f} className="flex items-center justify-between gap-4 px-4 py-3">
              <label htmlFor={`flag-${f}`} className={cn("text-sm", wrong ? "text-negative" : "text-fg-2")}>
                {t(`flags.${f}`)}
              </label>
              <Switch
                id={`flag-${f}`}
                label={t(`flags.${f}`)}
                checked={flags[f]}
                invalid={wrong}
                onChange={(value) => {
                  setFlags((x) => ({ ...x, [f]: value }));
                  setConfirming(false);
                }}
              />
            </li>
          );
        })}
      </ul>
      <p className="text-xs leading-relaxed text-fg-3">{t("rule")}</p>
      {confirming ? (
        <ConfirmRow
          testId="whitelist-confirm-row"
          message={t("confirmWhitelist", { address: shortAddress(asset.trim(), 6) })}
          confirmLabel={ta("confirm")}
          cancelLabel={ta("cancel")}
          onCancel={() => setConfirming(false)}
          onConfirm={submit}
        />
      ) : (
        <ActionButton
          type="submit"
          variant="outline"
          data-testid="whitelist-submit"
          label={t("submit")}
          pending={pending}
          reason={reason}
        />
      )}
    </form>
  );
}
