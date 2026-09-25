"use client";

import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import type { DevAccount } from "./api";
import { isLocalChain } from "./env";
import { localAccounts } from "./local-dev";

/** Display name of a local test account ("Deployer", "Backer 3", "Whale"). */
export function useLocalAccountName() {
  const t = useTranslations("localAccounts.names");
  return (account: DevAccount) =>
    account.role === "backer" ? t("backer", { n: account.ordinal ?? 0 }) : t(account.role);
}

/** The local test accounts (chain 31337 only; empty elsewhere). */
export function useLocalAccounts() {
  return useQuery({
    queryKey: ["local-accounts"],
    queryFn: localAccounts,
    enabled: isLocalChain,
    staleTime: Infinity,
  });
}

/** The local account matching `address`, if the app runs on the local chain. */
export function useLocalAccount(address?: string) {
  const { data } = useLocalAccounts();
  if (!address) return undefined;
  return data?.find((a) => a.address.toLowerCase() === address.toLowerCase());
}
