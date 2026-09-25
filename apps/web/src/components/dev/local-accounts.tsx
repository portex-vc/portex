"use client";

import { CopyValue } from "@/components/copy-value";
import { Button } from "@/components/ui/button";
import type { DevAccount } from "@/lib/api";
import { erc20Abi } from "@/lib/contracts";
import { humanizeError } from "@/lib/errors";
import { useApiConfig, useHydrated } from "@/lib/hooks";
import { LOCAL_CONNECTOR_ID, setSelectedLocalAccountIndex } from "@/lib/local-connector";
import { useLocalAccountName, useLocalAccounts } from "@/lib/use-account-label";
import { useNumbers } from "@/lib/use-numbers";
import { cn, shortAddress } from "@/lib/utils";
import { Check, Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import type { Address } from "viem";
import { useAccount, useConnect, useReadContract } from "wagmi";

/**
 * Local test accounts (chain 31337 only). This panel is the only place in the app where they
 * appear; the public test mnemonic of the local chain (anvil) derives them, and they never exist on X Layer.
 */
export function LocalAccountsPanel() {
  const t = useTranslations("localAccounts");
  const te = useTranslations("errors");
  const { data: accounts, isError } = useLocalAccounts();
  const { data: config } = useApiConfig();
  const hydrated = useHydrated();
  const account = useAccount();
  const address = hydrated ? account.address : undefined;
  const connector = hydrated ? account.connector : undefined;
  const isConnected = hydrated && account.isConnected;
  const { connectAsync, connectors } = useConnect();
  const [pending, setPending] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const local = connectors.find((c) => c.id === LOCAL_CONNECTOR_ID);
  const usingLocal = isConnected && connector?.id === LOCAL_CONNECTOR_ID;

  const use = async (account: DevAccount) => {
    if (!local) return;
    setPending(account.index);
    setError(null);
    try {
      if (usingLocal) {
        await (local as unknown as { selectAccount: (i: number) => Promise<void> }).selectAccount(account.index);
      } else {
        setSelectedLocalAccountIndex(account.index);
        await connectAsync({ connector: local });
      }
    } catch (err) {
      setError(humanizeError(err, te));
    } finally {
      setPending(null);
    }
  };

  return (
    <section id="local-accounts" className="surface-1 scroll-mt-24" data-testid="local-accounts">
      <header className="space-y-1.5 border-b border-hairline p-5">
        <p className="eyebrow">{t("eyebrow")}</p>
        <h2 className="text-base font-medium">{t("title")}</h2>
        <p className="max-w-2xl text-sm leading-relaxed text-fg-2">{t("hint")}</p>
      </header>
      {error ? (
        <p role="alert" className="m-5 rounded-md border border-negative/40 bg-negative/10 p-3 text-sm text-negative">
          {error}
        </p>
      ) : null}
      {isError || (accounts && !accounts.length) ? (
        <p className="p-5 text-sm text-fg-2">{t("unavailable")}</p>
      ) : !accounts ? (
        <div className="space-y-2 p-5">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="skeleton h-12 rounded-[10px]" />
          ))}
        </div>
      ) : (
        <div>
          <div className="eyebrow hidden grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_8.5rem_9.5rem] gap-4 border-b border-hairline bg-surface-2/50 px-5 py-2.5 md:grid">
            <span>{t("account")}</span>
            <span>{t("address")}</span>
            <span className="text-right">{t("balance", { symbol: config?.quote.symbol ?? "USDG" })}</span>
            <span className="sr-only">{t("use")}</span>
          </div>
          <ul className="divide-y divide-hairline">
            {accounts.map((account) => (
              <Row
                key={account.index}
                account={account}
                quote={config?.quote.address as Address | undefined}
                symbol={config?.quote.symbol ?? "USDG"}
                active={usingLocal && address?.toLowerCase() === account.address.toLowerCase()}
                pending={pending === account.index}
                disabled={pending !== null}
                onUse={() => use(account)}
              />
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function Row({
  account,
  quote,
  symbol,
  active,
  pending,
  disabled,
  onUse,
}: {
  account: DevAccount;
  quote?: Address;
  symbol: string;
  active: boolean;
  pending: boolean;
  disabled: boolean;
  onUse: () => void;
}) {
  const t = useTranslations("localAccounts");
  const name = useLocalAccountName();
  const n = useNumbers();
  const balance = useReadContract({
    address: quote,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [account.address as Address],
    query: { enabled: Boolean(quote), refetchInterval: 10_000 },
  });
  return (
    <li
      data-testid={`local-account-${account.index}`}
      className={cn(
        "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-2 px-5 py-3.5 md:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_8.5rem_9.5rem]",
        active && "bg-surface-2/60",
      )}
    >
      <div className="min-w-0">
        <p className="text-sm font-medium">{name(account)}</p>
        <p className="mt-0.5 text-xs leading-relaxed text-fg-3">{t(`roles.${account.role}`)}</p>
      </div>
      <div className="col-span-2 row-start-2 min-w-0 md:col-span-1 md:row-start-auto">
        <span className="md:hidden">
          <CopyValue value={account.address} />
        </span>
        <span className="hidden md:inline" title={account.address}>
          <CopyValueShort value={account.address} />
        </span>
      </div>
      <p className="num col-span-2 row-start-3 text-xs text-fg-2 md:col-span-1 md:row-start-auto md:text-right md:text-sm md:text-fg">
        <span className="text-fg-3 md:hidden">{t("balance", { symbol })} · </span>
        {balance.data !== undefined ? n.quote(balance.data as bigint) : "—"}{" "}
        <span className="text-xs text-fg-3">{symbol}</span>
      </p>
      <div className="col-start-2 row-start-1 flex justify-end md:col-start-auto md:row-start-auto">
        {active ? (
          <span className="inline-flex h-8 items-center gap-1.5 rounded-md bg-positive/10 px-3 text-xs font-medium text-positive">
            <Check className="size-3.5" /> {t("inUse")}
          </span>
        ) : (
          <Button
            size="sm"
            variant="outline"
            data-testid={`account-${account.index}`}
            disabled={disabled}
            onClick={onUse}
          >
            {pending ? <Loader2 className="animate-spin" /> : null}
            {t("use")}
          </Button>
        )}
      </div>
    </li>
  );
}

function CopyValueShort({ value }: { value: string }) {
  const tc = useTranslations("common");
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="inline-flex items-center gap-1.5 rounded font-mono text-xs text-fg-2 hover:text-fg"
      aria-label={`${tc(copied ? "copied" : "copy")}: ${value}`}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
        } catch {
          setCopied(false);
        }
      }}
    >
      {shortAddress(value, 6)}
      {copied ? <Check className="size-3" /> : null}
    </button>
  );
}
