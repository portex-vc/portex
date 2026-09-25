"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { simulateContract, getPublicClient } from "@wagmi/core";
import { useTranslations } from "next-intl";
import { useEffect, useState, useSyncExternalStore } from "react";
import { toast } from "sonner";
import type { Abi, Address } from "viem";
import { useAccount, useReadContract, useConfig as useWagmiConfig, useWriteContract } from "wagmi";
import { api, type Phase } from "./api";
import { erc20Abi } from "./contracts";
import { humanizeError } from "./errors";
import { env } from "./env";
import { txStore, useTransaction } from "./tx-store";
import type { Row } from "@/components/figures";

/**
 * Ticking clock for countdowns and time gates (1s resolution). Tracks the CHAIN's clock
 * (head block timestamp from /v2/health + wall elapsed) so the UI stays correct after
 * dev time-travel; falls back to wall time while the backend is unreachable.
 */
export function useNow(intervalMs = 1000): number {
  const health = useHealth();
  const [wallNow, setWallNow] = useState(0);
  useEffect(() => {
    setWallNow(Date.now());
    const id = setInterval(() => setWallNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  if (wallNow === 0) return 0;
  const chainBase = health.data?.headTimestamp;
  if (chainBase != null) {
    return Math.floor(chainBase + (wallNow - health.dataUpdatedAt) / 1000);
  }
  return Math.floor(wallNow / 1000);
}

/* ---------- API queries ---------- */

export const queryKeys = {
  config: ["config"] as const,
  inbox: (user?: string) => ["inbox", user ?? "none"] as const,
  updates: (raise: string) => ["updates", raise] as const,
  raises: (state?: Phase) => ["raises", state ?? "all"] as const,
  raise: (address: string) => ["raise", address] as const,
  position: (raise: string, user?: string) => ["position", raise, user ?? "none"] as const,
  trades: (raise: string) => ["trades", raise] as const,
  priceHistory: (raise: string) => ["price-history", raise] as const,
  activity: (raise: string) => ["activity", raise] as const,
  report: (raise: string) => ["report", raise] as const,
  feedback: (raise: string) => ["feedback", raise] as const,
  proposals: (raise: string) => ["proposals", raise] as const,
  rolloverSources: (user?: string) => ["rollover-sources", user ?? "none"] as const,
  health: ["health"] as const,
};

export function useInbox(user?: string) {
  return useQuery({
    queryKey: queryKeys.inbox(user),
    queryFn: () => api.inbox(user!),
    enabled: Boolean(user),
    refetchInterval: 10000,
    retry: 1,
  });
}

export function useUpdates(raise: string) {
  return useQuery({
    queryKey: queryKeys.updates(raise),
    queryFn: () => api.updates(raise),
    refetchInterval: 10000,
    retry: 1,
  });
}

export function useApiConfig() {
  return useQuery({
    queryKey: queryKeys.config,
    queryFn: api.config,
    staleTime: 60_000,
    retry: 1,
  });
}

export function useHealth() {
  return useQuery({
    queryKey: queryKeys.health,
    queryFn: api.health,
    refetchInterval: 15_000,
    retry: 1,
  });
}

export function useRaises(state?: Phase) {
  return useQuery({
    queryKey: queryKeys.raises(state),
    queryFn: () => api.raises(state),
    refetchInterval: 20_000,
    retry: 1,
  });
}

export function useRaise(address: string) {
  return useQuery({
    queryKey: queryKeys.raise(address),
    queryFn: () => api.raise(address),
    refetchInterval: 10_000,
    retry: 1,
  });
}

export function usePosition(raise: string, user?: string) {
  return useQuery({
    queryKey: queryKeys.position(raise, user),
    queryFn: () => api.position(raise, user!),
    enabled: Boolean(user),
    refetchInterval: 10_000,
    retry: 1,
  });
}

export function useTrades(raise: string) {
  return useQuery({
    queryKey: queryKeys.trades(raise),
    queryFn: () => api.trades(raise),
    retry: 1,
  });
}

export function usePriceHistory(raise: string) {
  return useQuery({
    queryKey: queryKeys.priceHistory(raise),
    queryFn: () => api.priceHistory(raise),
    retry: 1,
  });
}

export function useActivity(raise: string) {
  return useQuery({
    queryKey: queryKeys.activity(raise),
    queryFn: () => api.activity(raise),
    refetchInterval: 15_000,
    retry: 1,
  });
}

export function useFeedback(raise: string) {
  return useQuery({
    queryKey: queryKeys.feedback(raise),
    queryFn: () => api.feedback(raise),
    retry: 1,
  });
}

/** Positions and dissolution claims the user could move into another project in one transaction. */
export function useRolloverSources(user?: string) {
  return useQuery({
    queryKey: queryKeys.rolloverSources(user),
    queryFn: () => api.rolloverSources(user!),
    enabled: Boolean(user),
    refetchInterval: 8_000,
    retry: 1,
  });
}

export function useProposals(raise: string, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.proposals(raise),
    queryFn: () => api.proposals(raise),
    enabled,
    refetchInterval: 10_000,
    retry: 1,
  });
}

/* ---------- Chain writes ---------- */

interface TxRequest {
  address: Address;
  abi: Abi;
  functionName: string;
  args?: unknown[];
}

/**
 * Contract writes with a shared transaction drawer, completion toast and automatic
 * invalidation of affected queries.
 */
export function useTx() {
  const { address: owner, chainId } = useAccount();
  const { writeContractAsync } = useWriteContract();
  const wagmiConfig = useWagmiConfig();
  const queryClient = useQueryClient();
  const transaction = useTransaction();
  const t = useTranslations("tx");
  const te = useTranslations("errors");
  const pending = transaction?.phase === "wallet" || transaction?.phase === "confirming";

  async function send(
    tx: TxRequest,
    opts: {
      label: string;
      preview?: Row[];
      invalidate?: readonly (readonly unknown[])[];
      onSuccess?: (hash: `0x${string}`) => void | Promise<void>;
    },
  ): Promise<`0x${string}` | null> {
    if (txStore.busy()) return null;
    const action = t.has(`actions.${tx.functionName}`) ? t(`actions.${tx.functionName}`) : opts.label;
    const id = txStore.start(action, tx.functionName === "approve", tx.address, owner ?? "");
    let submitted: `0x${string}` | undefined;
    let revertedReceipt = false;
    try {
      if (!(await txStore.review(id, opts.preview ?? []))) return null;
      txStore.update(id, { phase: "wallet" });
      if (chainId !== env.chainId) throw { errorName: "WrongChain" };
      await simulateContract(wagmiConfig, {
        account: owner,
        address: tx.address,
        abi: tx.abi,
        functionName: tx.functionName,
        args: tx.args,
      });
      // Gas can grow between estimate and mining (Stage 2 decay after its first second, a swap crossing
      // ticks), so send a 1.5x limit; unused gas is refunded.
      const estimate = await getPublicClient(wagmiConfig)!.estimateContractGas({
        account: owner,
        address: tx.address,
        abi: tx.abi,
        functionName: tx.functionName,
        args: tx.args ?? [],
      } as never);
      const hash = await writeContractAsync({
        account: owner,
        address: tx.address,
        abi: tx.abi,
        functionName: tx.functionName,
        args: (tx.args ?? []) as never[],
        gas: (estimate * 3n) / 2n,
      });
      submitted = hash;
      txStore.update(id, { hash, phase: "confirming" });
      const receipt = await getPublicClient(wagmiConfig)!.waitForTransactionReceipt({ hash });
      if (receipt.status === "reverted") {
        revertedReceipt = true;
        throw new Error("Transaction reverted");
      }
      if (tx.functionName === "approve" && typeof tx.args?.[0] === "string")
        txStore.rememberApproval(tx.args[0], owner ?? "", hash);
      // The receipt may precede the indexer. Do not refetch a missing position ID.
      for (let attempt = 0; attempt < 60; attempt++) {
        const health = await api.health().catch(() => null);
        if (health && BigInt(health.indexedBlock) >= receipt.blockNumber) break;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      for (const key of opts.invalidate ?? []) {
        await queryClient.invalidateQueries({ queryKey: key as unknown[] });
      }
      await opts.onSuccess?.(hash);
      txStore.update(id, { phase: "complete" });
      toast.success(t("confirmed", { action }));
      return hash;
    } catch (err) {
      if (tx.functionName === "list" && submitted && revertedReceipt) {
        let revertData = String(err);
        try {
          const client = getPublicClient(wagmiConfig);
          const sent = await client!.getTransaction({ hash: submitted });
          await client!.call({
            account: sent.from,
            to: sent.to!,
            data: sent.input,
            blockNumber: sent.blockNumber ?? undefined,
          });
        } catch (revert) {
          revertData = String(revert);
        }
        const key = "portex.ListingAttemptFailed";
        txStore.update(id, { revertData });
        try {
          const stored: unknown = JSON.parse(localStorage.getItem(key) ?? "[]");
          const records = Array.isArray(stored) ? stored : [];
          localStorage.setItem(
            key,
            JSON.stringify([...records, { raise: tx.address, hash: submitted, revertData, at: Date.now() }]),
          );
        } catch {
          /* The open drawer retains the receipt if browser storage is unavailable. */
        }
        for (const key of opts.invalidate ?? []) await queryClient.invalidateQueries({ queryKey: key });
      }
      txStore.update(id, { phase: "error", reverted: revertedReceipt, error: humanizeError(err, te) });
      return null;
    }
  }

  return { send, pending };
}

/** ERC-20 approval helper: reports current allowance and exposes an approve write. */
export function useAllowance(
  token: Address | undefined,
  owner: Address | undefined,
  spender: Address | undefined,
  needed: bigint,
) {
  const query = useReadContract({
    address: token,
    abi: erc20Abi,
    functionName: "allowance",
    args: owner && spender ? [owner, spender] : undefined,
    query: {
      enabled: Boolean(token && owner && spender),
      refetchInterval: 15_000,
    },
  });
  const allowance = (query.data as bigint | undefined) ?? 0n;
  return {
    allowance,
    needsApproval: needed > 0n && allowance < needed,
    refetch: query.refetch,
    isLoading: query.isLoading,
  };
}

const noopSubscribe = () => () => {};
/** False during server render and hydration, true afterwards (no extra effect pass). */
export function useHydrated(): boolean {
  return useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false,
  );
}

/**
 * The connected account, but only after hydration: wagmi may reconnect before a page subtree
 * hydrates, and rendering the connected state on that first pass would not match the server HTML.
 */
export function useConnectedAddress(): Address | undefined {
  const { address } = useAccount();
  return useHydrated() ? address : undefined;
}
