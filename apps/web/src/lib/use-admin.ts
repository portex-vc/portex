"use client";

import { useMemo } from "react";
import type { Address } from "viem";
import { useReadContract, useReadContracts } from "wagmi";
import { detectRoles, type AdminRole } from "./admin";
import { appChain } from "./chains";
import { raiseAbi, registryAbi } from "./contracts";
import { useApiConfig, useConnectedAddress, useRaises } from "./hooks";

export type RaiseModules = { attester: string; council: string };

/**
 * `modules()` of each Stage 1 raise, read from the chain: the attester and council that may act on it.
 * Keyed by lowercase raise address; undefined until read.
 */
export function useStage1Modules(enabled = true) {
  const { data: raises } = useRaises();
  const stage1 = useMemo(() => (raises ?? []).filter((r) => r.phase === "Stage1"), [raises]);
  const reads = useReadContracts({
    contracts: stage1.map((r) => ({
      address: r.address as Address,
      abi: raiseAbi,
      functionName: "modules",
      chainId: appChain.id,
    })),
    query: { enabled: enabled && stage1.length > 0, staleTime: 30_000 },
  });
  return useMemo(() => {
    const out = new Map<string, RaiseModules>();
    stage1.forEach((r, i) => {
      const m = reads.data?.[i]?.result as RaiseModules | undefined;
      if (m?.attester && m?.council) out.set(r.address.toLowerCase(), { attester: m.attester, council: m.council });
    });
    return { modules: out, isLoading: reads.isLoading, refetch: reads.refetch };
  }, [reads.data, reads.isLoading, reads.refetch, stage1]);
}

/**
 * Roles of the connected account, from reads only: the registry's `curator()`, the latest versions' pinned
 * attester and council (plus each Stage 1 raise's `modules()`), and the API's `admins`.
 */
export function useAdminRoles() {
  const address = useConnectedAddress();
  const config = useApiConfig();
  const registry = config.data?.addresses.registry as Address | undefined;
  const curator = useReadContract({
    address: registry,
    abi: registryAbi,
    functionName: "curator",
    chainId: appChain.id,
    query: { enabled: Boolean(registry && address), staleTime: 60_000 },
  });
  const stage1 = useStage1Modules(Boolean(address));
  const roles = useMemo<AdminRole[]>(
    () =>
      detectRoles({
        address,
        curator: curator.data as string | undefined,
        templates: config.data?.templates,
        admins: config.data?.admins,
        raiseModules: [...stage1.modules.values()],
      }),
    [address, curator.data, config.data, stage1.modules],
  );
  return {
    address,
    roles,
    has: (role: AdminRole) => roles.includes(role),
    curator: curator.data as string | undefined,
    config: config.data,
    modules: stage1.modules,
    loading: Boolean(address) && (config.isLoading || curator.isLoading || stage1.isLoading),
  };
}
