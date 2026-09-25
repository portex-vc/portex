"use client";

import { ActionButton } from "@/components/action-button";
import { LocalAccountsPanel } from "@/components/dev/local-accounts";
import { Reveal } from "@/components/motion/reveal";
import { ConnectPrompt } from "@/components/shell/wallet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { displayAmountInput, normalizeAmountEdit } from "@/lib/amount-input";
import { erc20Abi } from "@/lib/contracts";
import { humanizeError } from "@/lib/errors";
import { isValidAmountInput, parseQuote } from "@/lib/format";
import { useApiConfig, useConnectedAddress, useHealth, useNow, useTx } from "@/lib/hooks";
import { localWarp } from "@/lib/local-dev";
import { useLocalAccount, useLocalAccountName } from "@/lib/use-account-label";
import { useNumbers } from "@/lib/use-numbers";
import { shortAddress } from "@/lib/utils";
import { useQueryClient } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import type { Address } from "viem";

const WARPS = [
  { value: 60, key: "minute" },
  { value: 3600, key: "hour" },
  { value: 86400, key: "day" },
  { value: 7 * 86400, key: "week" },
] as const;

export default function DevPage() {
  const t = useTranslations("dev");
  const te = useTranslations("errors");
  const locale = useLocale();
  const n = useNumbers();
  const now = useNow();
  const name = useLocalAccountName();
  const { data: apiConfig } = useApiConfig();
  const { send } = useTx();
  const user = useConnectedAddress();
  const local = useLocalAccount(user);
  const client = useQueryClient();
  const { data: health, isError: healthError } = useHealth();
  const [seconds, setSeconds] = useState("");
  const [amount, setAmount] = useState("10000");
  const [busy, setBusy] = useState<"time" | "mint" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const warp = async (value: number) => {
    setBusy("time");
    setError(null);
    try {
      await localWarp(value);
      await client.invalidateQueries();
      toast.success(t("warped", { time: n.date(now + value) }));
    } catch (err) {
      setError(humanizeError(err, te));
    } finally {
      setBusy(null);
    }
  };
  const mint = async () => {
    if (!user || !apiConfig) return;
    setBusy("mint");
    setError(null);
    try {
      await send(
        {
          address: apiConfig.quote.address as Address,
          abi: erc20Abi,
          functionName: "mint",
          args: [user, parseQuote(amount)],
        },
        {
          label: t("mint"),
          preview: [
            [t("recipient"), local ? name(local) : shortAddress(user)],
            [t("amount"), `${n.quote(parseQuote(amount))} ${apiConfig.quote.symbol}`],
          ],
          invalidate: [["readContract"], ["position"]],
        },
      );
    } finally {
      setBusy(null);
    }
  };

  const secondsValid = /^\d+$/.test(seconds) && Number(seconds) > 0 && Number.isSafeInteger(Number(seconds));

  return (
    <div className="space-y-8 pt-2 lg:pt-4">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="space-y-2">
          <h1 className="text-[1.75rem] font-medium leading-9 tracking-tight">{t("title")}</h1>
          <p className="max-w-2xl text-sm text-fg-2">{t("intro")}</p>
        </div>
        <p className="num inline-flex items-center gap-2 text-xs text-fg-2" data-testid="dev-health">
          <span
            aria-hidden
            className={`size-1.5 rounded-full ${health?.ok ? "bg-positive" : healthError ? "bg-negative" : "bg-fg-3"}`}
          />
          {health
            ? t("health", {
                chain: health.chainId,
                head: health.head != null ? n.number(health.head, 0) : "—",
                indexed: n.number(health.indexedBlock, 0),
              })
            : healthError
              ? t("unreachable")
              : t("checking")}
        </p>
      </header>
      {error ? (
        <p role="alert" className="rounded-md border border-negative/40 bg-negative/10 p-3 text-sm text-negative">
          {error}
        </p>
      ) : null}

      <LocalAccountsPanel />

      <div className="grid gap-4 lg:grid-cols-2">
        <Reveal className="surface-1 flex flex-col gap-4 p-5" data-testid="dev-time">
          <div className="space-y-1.5">
            <p className="eyebrow">{t("timeEyebrow")}</p>
            <h2 className="text-base font-medium">{t("time")}</h2>
            <p className="text-sm leading-relaxed text-fg-2">{t("timeHint")}</p>
          </div>
          <dl className="flex items-baseline justify-between gap-3 border-y border-hairline py-3 text-xs">
            <dt className="text-fg-2">{t("chainTime")}</dt>
            <dd className="num text-sm text-fg">{now ? n.date(now) : "—"}</dd>
          </dl>
          <div className="flex flex-wrap gap-2">
            {WARPS.map((item) => (
              <Button
                key={item.key}
                variant="outline"
                size="sm"
                data-testid={`warp-${item.key}`}
                disabled={busy !== null}
                onClick={() => warp(item.value)}
              >
                {t(item.key)}
              </Button>
            ))}
          </div>
          <div className="flex flex-wrap items-start gap-2">
            <Input
              className="w-40"
              aria-label={t("seconds")}
              placeholder={t("seconds")}
              value={seconds}
              inputMode="numeric"
              onChange={(e) => {
                if (/^\d*$/.test(e.target.value)) setSeconds(e.target.value);
              }}
            />
            <Button
              variant="outline"
              className="h-10"
              disabled={!secondsValid || busy !== null}
              title={!secondsValid ? t("enterSeconds") : undefined}
              onClick={() => warp(Number(seconds))}
            >
              {busy === "time" ? <Loader2 className="animate-spin" /> : null}
              {t("warp")}
            </Button>
          </div>
        </Reveal>
        <Reveal index={1} className="surface-1 flex flex-col gap-4 p-5" data-testid="dev-faucet">
          <div className="space-y-1.5">
            <p className="eyebrow">{t("faucetEyebrow")}</p>
            <h2 className="text-base font-medium">{t("faucet")}</h2>
            <p className="text-sm leading-relaxed text-fg-2">{t("faucetHint")}</p>
          </div>
          {user ? (
            <>
              <dl className="flex items-baseline justify-between gap-3 border-y border-hairline py-3 text-xs">
                <dt className="text-fg-2">{t("recipient")}</dt>
                <dd className="text-sm">
                  {local ? name(local) : <span className="font-mono">{shortAddress(user)}</span>}
                </dd>
              </dl>
              <label className="block space-y-2 text-xs text-fg-2">
                <span>{t("amount")}</span>
                <span className="flex items-center gap-2">
                  <Input
                    className="max-w-52"
                    value={displayAmountInput(amount, locale)}
                    inputMode="decimal"
                    onChange={(e) => {
                      const edit = normalizeAmountEdit(e.target.value, locale);
                      if (isValidAmountInput(edit)) setAmount(edit);
                    }}
                  />
                  <span className="text-sm text-fg-2">{apiConfig?.quote.symbol ?? "USDG"}</span>
                </span>
              </label>
              <ActionButton
                className="self-start"
                label={t("mint")}
                data-testid="dev-mint"
                pending={busy === "mint"}
                reason={
                  !apiConfig ? t("unreachable") : !(Number(amount) > 0) ? t("enterAmount") : busy ? t("busy") : null
                }
                onClick={mint}
              />
            </>
          ) : (
            <ConnectPrompt text={t("faucetConnect")} />
          )}
        </Reveal>
      </div>
    </div>
  );
}
