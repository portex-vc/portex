"use client";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { appChain, appChainSwitch, explorerUrl } from "@/lib/chains";
import { env, isLocalChain } from "@/lib/env";
import { humanizeError } from "@/lib/errors";
import { useApiConfig, useWallet } from "@/lib/hooks";
import { LOCAL_CONNECTOR_ID } from "@/lib/local-connector";
import { useLocalAccount, useLocalAccountName } from "@/lib/use-account-label";
import { useNumbers } from "@/lib/use-numbers";
import { cn, shortAddress } from "@/lib/utils";
import { OKX_CONNECTOR_ID, OKX_INSTALL_URL, OKX_RDNS } from "@/lib/wagmi";
import { useWalletSheetOpen, walletSheet } from "@/lib/wallet-sheet";
import * as Dialog from "@radix-ui/react-dialog";
import { Identicon } from "./identicon";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  ExternalLink,
  FlaskConical,
  Loader2,
  LogOut,
  QrCode,
  Wallet,
  X,
} from "lucide-react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { Address } from "viem";
import { useAccount, useConnect, useDisconnect, useSwitchChain, type Connector } from "wagmi";

/** Product network names are limited to the X Layer networks. */
export function useNetworkName() {
  const t = useTranslations("wallet.networks");
  return (chainId: number | undefined) => (chainId === 196 || chainId === 1952 ? t(String(chainId)) : t("unsupported"));
}

function useMounted() {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return mounted;
}

/** Neutral square used as the account glyph; the address itself carries identity. */
function AccountGlyph({ local }: { local?: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        "inline-flex size-[18px] shrink-0 items-center justify-center rounded-[4px] border border-hairline-strong bg-surface-3",
        local && "text-fg-2",
      )}
    >
      {local ? <FlaskConical className="!size-2.5" /> : null}
    </span>
  );
}

/** The app chain, and a switch offer when the connected wallet is elsewhere. */
export function NetworkIndicator() {
  const t = useTranslations("wallet");
  const name = useNetworkName();
  const mounted = useMounted();
  const { isConnected, chainId } = useAccount();
  const { switchChain, isPending } = useSwitchChain();
  const wrong = mounted && isConnected && chainId !== env.chainId;
  if (isLocalChain) return null;
  if (wrong)
    return (
      <Button
        variant="outline"
        size="sm"
        data-testid="network-wrong"
        className="gap-1.5 border-risk/35 bg-risk/[0.08] text-risk hover:border-risk/50 hover:bg-risk/[0.12] hover:text-risk"
        disabled={isPending}
        title={t("switchTo", { network: name(env.chainId) })}
        onClick={() => switchChain(appChainSwitch)}
      >
        {isPending ? <Loader2 className="animate-spin" /> : <AlertTriangle />}
        <span className="hidden sm:inline">{t("wrongNetwork")}</span>
      </Button>
    );
  return (
    <span
      data-testid="network-indicator"
      className="hidden h-8 items-center gap-2 px-1.5 text-xs text-fg-3 xl:inline-flex"
      title={t("appNetwork", { network: name(env.chainId) })}
    >
      <span aria-hidden className="relative flex size-2 items-center justify-center">
        <span className={cn("size-1.5 rounded-full", appChain.testnet || isLocalChain ? "bg-fg-3" : "bg-positive")} />
      </span>
      {name(env.chainId)}
    </span>
  );
}

/** The one wallet control in the header: "Connect wallet", or the connected account's menu. */
export function WalletControl() {
  const t = useTranslations("wallet");
  const mounted = useMounted();
  const { address, status, connector } = useAccount();
  const { switchChainAsync } = useSwitchChain();
  const attempted = useRef<string | null>(null);
  useEffect(() => {
    if (status === "disconnected") attempted.current = null;
    if (status !== "connected" || !address || !connector) return;
    const connection = `${connector.uid}:${address}`;
    if (attempted.current === connection) return;
    attempted.current = connection;
    // Covers new and restored sessions; declining leaves the fallback pill without a prompt loop.
    void switchChainAsync({ ...appChainSwitch, connector }).catch(() => {});
  }, [address, connector, status, switchChainAsync]);
  const connected = mounted && status === "connected" && address;
  return (
    <div id="wallet" className="flex items-center gap-1.5">
      <NetworkIndicator />
      {connected ? (
        <AccountMenu address={address} />
      ) : (
        <Button
          size="sm"
          data-testid="connect-wallet"
          className="px-3.5"
          onClick={walletSheet.open}
          disabled={mounted && (status === "connecting" || status === "reconnecting")}
        >
          {mounted && (status === "connecting" || status === "reconnecting") ? (
            <Loader2 className="animate-spin" />
          ) : (
            <Wallet />
          )}
          {t("connect")}
        </Button>
      )}
      <WalletSheet />
    </div>
  );
}

function AccountMenu({ address }: { address: Address }) {
  const t = useTranslations("wallet");
  const n = useNumbers();
  const networkName = useNetworkName();
  const { chainId, connector } = useAccount();
  const { disconnect } = useDisconnect();
  const { switchChain, isPending: switching } = useSwitchChain();
  const localName = useLocalAccountName();
  const local = useLocalAccount(isLocalChain ? address : undefined);
  const { data: config } = useApiConfig();
  const [copied, setCopied] = useState(false);
  const wrong = chainId !== env.chainId;
  const wallet = useWallet(address, 15_000);
  const balance = wallet.data?.quote.balance;
  const symbol = config?.quote.symbol ?? "USDG";
  const label = local ? localName(local) : shortAddress(address);
  const isLocalConnector = connector?.id === LOCAL_CONNECTOR_ID;

  return (
    <DropdownMenu onOpenChange={() => setCopied(false)}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          data-testid="wallet-button"
          className={cn("gap-2 pl-1.5 pr-2", wrong && "border-risk/40")}
        >
          <span className="relative">
            {isLocalConnector ? <AccountGlyph local /> : <Identicon address={address} size={20} />}
            <span
              aria-hidden
              className={cn(
                "absolute -bottom-px -right-px size-[7px] rounded-full ring-2 ring-bg",
                wrong ? "bg-risk" : "bg-positive",
              )}
            />
          </span>
          <span className={cn("max-w-[8.5rem] truncate", !local && "font-mono text-[0.75rem]")}>{label}</span>
          <ChevronDown className="!size-3.5 text-fg-3" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-[19rem] p-0" data-testid="wallet-menu">
        <div className="space-y-3 border-b border-fg/[0.07] p-4">
          <div className="flex items-center gap-3">
            {isLocalConnector ? <AccountGlyph local /> : <Identicon address={address} size={32} />}
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">{local ? localName(local) : shortAddress(address)}</p>
              <p className="text-xs text-fg-3">
                {isLocalConnector ? t("localAccount") : t("connectedWith", { wallet: connector?.name ?? t("wallet") })}
              </p>
            </div>
          </div>
          <div className="flex items-start gap-2">
            <p
              className="min-w-0 flex-1 break-all rounded-lg bg-fg/[0.04] px-2.5 py-2 font-mono text-[0.6875rem] leading-4 text-fg-2"
              data-testid="wallet-address"
            >
              {address}
            </p>
            <Button
              variant="ghost"
              size="icon"
              className="size-7 shrink-0 text-fg-2"
              aria-label={t(copied ? "copied" : "copyAddress")}
              title={t(copied ? "copied" : "copyAddress")}
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(address);
                  setCopied(true);
                } catch {
                  setCopied(false);
                }
              }}
            >
              {copied ? <Check className="!size-3.5" /> : <Copy className="!size-3.5" />}
            </Button>
          </div>
        </div>
        <dl className="space-y-2.5 border-b border-fg/[0.07] p-4 text-xs">
          <div className="flex items-baseline justify-between gap-3">
            <dt className="text-fg-2">{t("balance", { symbol })}</dt>
            <dd className="num text-sm font-medium" data-testid="wallet-balance">
              {wrong ? "—" : balance !== undefined ? n.quote(balance) : "…"}{" "}
              <span className="text-xs font-normal text-fg-3">{symbol}</span>
            </dd>
          </div>
          <div className="flex items-baseline justify-between gap-3">
            <dt className="text-fg-2">{t("network")}</dt>
            <dd className={cn("inline-flex items-center gap-1.5", wrong ? "text-risk" : "text-fg")}>
              <span aria-hidden className={cn("size-1.5 rounded-full", wrong ? "bg-risk" : "bg-positive")} />
              {isLocalChain ? "—" : networkName(chainId)}
            </dd>
          </div>
        </dl>
        {wrong ? (
          <div className="space-y-3 border-b border-fg/[0.07] p-4">
            <p className="text-xs leading-relaxed text-fg-2">
              {t("wrongNetworkHint", { current: networkName(chainId), network: networkName(env.chainId) })}
            </p>
            <Button size="sm" className="w-full" disabled={switching} onClick={() => switchChain(appChainSwitch)}>
              {switching ? <Loader2 className="animate-spin" /> : null}
              {t("switchTo", { network: networkName(env.chainId) })}
            </Button>
          </div>
        ) : null}
        <div className="p-1">
          {explorerUrl ? (
            <DropdownMenuItem asChild>
              <a href={`${explorerUrl}/address/${address}`} target="_blank" rel="noreferrer">
                <ExternalLink className="text-fg-2" />
                {t("explorer")}
              </a>
            </DropdownMenuItem>
          ) : null}
          {isLocalChain ? (
            <DropdownMenuItem asChild>
              <Link href="/dev#local-accounts">
                <FlaskConical className="text-fg-2" />
                {t("switchLocal")}
              </Link>
            </DropdownMenuItem>
          ) : null}
          {explorerUrl || isLocalChain ? <DropdownMenuSeparator className="mx-0" /> : null}
          <DropdownMenuItem data-testid="wallet-disconnect" onClick={() => disconnect()}>
            <LogOut className="text-fg-2" />
            {t("disconnect")}
          </DropdownMenuItem>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

type Option = {
  key: string;
  name: string;
  connector?: Connector;
  icon?: string;
  status: "detected" | "install" | "qr" | "none";
};

function useWalletOptions(): Option[] {
  const t = useTranslations("wallet");
  const { connectors } = useConnect();
  const mounted = useMounted();
  const w = mounted ? (window as unknown as { okxwallet?: unknown; ethereum?: unknown }) : undefined;
  const discovered = connectors.filter(
    (c) => c.type === "injected" && c.id !== "injected" && c.id !== OKX_CONNECTOR_ID,
  );
  const okxDiscovered = discovered.find((c) => c.id === OKX_RDNS);
  const okxExplicit = connectors.find((c) => c.id === OKX_CONNECTOR_ID);
  const okx = okxDiscovered ?? okxExplicit;
  const others = discovered.filter((c) => c.id !== OKX_RDNS);
  const generic = connectors.find((c) => c.id === "injected");
  const wc = connectors.find((c) => c.id === "walletConnect");
  const options: Option[] = [
    {
      key: "okx",
      name: "OKX Wallet",
      connector: okx,
      icon: okxDiscovered?.icon,
      status: okxDiscovered || w?.okxwallet ? "detected" : "install",
    },
    ...others.map((c) => ({
      key: c.id,
      name: c.name,
      connector: c,
      icon: c.icon,
      status: "detected" as const,
    })),
  ];
  // The generic injected connector covers wallets that do not announce themselves (EIP-6963).
  if (!others.length)
    options.push({
      key: "injected",
      name: t("browserWallet"),
      connector: generic,
      status: w?.ethereum ? "detected" : "none",
    });
  if (wc) options.push({ key: "walletConnect", name: "WalletConnect", connector: wc, status: "qr" });
  return options;
}

function WalletSheet() {
  const t = useTranslations("wallet");
  const te = useTranslations("errors");
  const networkName = useNetworkName();
  const open = useWalletSheetOpen();
  const { isConnected } = useAccount();
  const { connectAsync } = useConnect();
  const options = useWalletOptions();
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isConnected && open) walletSheet.set(false);
  }, [isConnected, open]);

  const choose = async (option: Option) => {
    if (!option.connector) return;
    setError(null);
    setPending(option.key);
    try {
      if (option.key === "walletConnect") walletSheet.set(false);
      await connectAsync({ connector: option.connector });
    } catch (err) {
      setError(humanizeError(err, te));
      if (option.key === "walletConnect") walletSheet.set(true);
    } finally {
      setPending(null);
    }
  };

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        walletSheet.set(next);
        if (!next) setError(null);
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-bg/70 backdrop-blur-sm data-[state=open]:animate-in data-[state=open]:fade-in" />
        <Dialog.Content
          data-testid="wallet-sheet"
          className="fixed inset-y-2 right-2 z-50 flex w-[calc(100%-1rem)] max-w-sm flex-col gap-6 overflow-y-auto rounded-2xl border border-fg/[0.08] bg-surface-1 p-6 shadow-2xl duration-300 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-right-8 data-[state=open]:slide-in-from-right-8"
        >
          <div className="flex items-start justify-between gap-3">
            <div className="space-y-1.5">
              <Dialog.Title className="text-xl font-medium">{t("sheetTitle")}</Dialog.Title>
              <Dialog.Description className="text-sm leading-relaxed text-fg-2">
                {isLocalChain
                  ? t("sheetDescriptionLocal")
                  : t("sheetDescription", { network: networkName(env.chainId) })}
              </Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <Button variant="ghost" size="icon" aria-label={t("close")} className="-mr-2 -mt-1">
                <X className="size-4" />
              </Button>
            </Dialog.Close>
          </div>
          <ul className="divide-y divide-fg/[0.06] overflow-hidden rounded-xl border border-fg/[0.08]">
            {options.map((option) => {
              const disabled = !option.connector || option.status === "none" || pending !== null;
              const body = (
                <>
                  <span className="flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-md border border-hairline bg-surface-1">
                    {option.icon ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={option.icon} alt="" className="size-5" />
                    ) : option.status === "qr" ? (
                      <QrCode className="size-4 text-fg-2" />
                    ) : (
                      <Wallet className="size-4 text-fg-2" />
                    )}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-fg">{option.name}</span>
                    <span className="block text-xs text-fg-3">
                      {t(
                        option.status === "detected"
                          ? "detected"
                          : option.status === "install"
                            ? "notInstalled"
                            : option.status === "qr"
                              ? "qrHint"
                              : "noneDetected",
                      )}
                    </span>
                  </span>
                  {pending === option.key ? (
                    <Loader2 className="size-4 animate-spin text-fg-2" />
                  ) : option.status === "install" ? (
                    <span className="inline-flex items-center gap-1 text-xs text-fg-2">
                      {t("install")} <ExternalLink className="size-3" />
                    </span>
                  ) : option.status !== "none" ? (
                    <ChevronRight className="size-4 text-fg-3" />
                  ) : null}
                </>
              );
              return (
                <li key={option.key}>
                  {option.status === "install" ? (
                    <a
                      href={OKX_INSTALL_URL}
                      target="_blank"
                      rel="noreferrer"
                      data-testid={`wallet-option-${option.key}`}
                      className="flex w-full items-center gap-3 px-4 py-3.5 text-left transition-colors hover:bg-fg/[0.04]"
                    >
                      {body}
                    </a>
                  ) : (
                    <button
                      type="button"
                      data-testid={`wallet-option-${option.key}`}
                      disabled={disabled}
                      onClick={() => choose(option)}
                      className="group flex w-full items-center gap-3 px-4 py-3.5 text-left transition-colors hover:bg-fg/[0.04] disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-transparent"
                    >
                      {body}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
          {error ? (
            <p role="alert" className="rounded-md border border-negative/40 bg-negative/10 p-3 text-sm text-negative">
              {error}
            </p>
          ) : null}
          <p className="text-xs leading-relaxed text-fg-3">{t("custody")}</p>
          {isLocalChain ? (
            <div className="mt-auto flex items-start gap-3 border-t border-hairline pt-4 text-xs leading-relaxed text-fg-2">
              <FlaskConical className="mt-0.5 size-3.5 shrink-0 text-fg-3" aria-hidden />
              <p>
                {t("localHint")}{" "}
                <Link
                  href="/dev#local-accounts"
                  className="link"
                  data-testid="wallet-local-link"
                  onClick={() => walletSheet.set(false)}
                >
                  {t("localLink")}
                </Link>
              </p>
            </div>
          ) : null}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** Inline prompt for surfaces that need an account: one sentence and the one Connect button. */
export function ConnectPrompt({ text, className }: { text: string; className?: string }) {
  const t = useTranslations("wallet");
  return (
    <div className={cn("flex flex-col items-start gap-3", className)} data-testid="connect-prompt">
      <p className="text-sm leading-relaxed text-fg-2">{text}</p>
      <Button size="sm" variant="outline" onClick={walletSheet.open}>
        <Wallet /> {t("connect")}
      </Button>
    </div>
  );
}
