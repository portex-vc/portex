"use client";

import { useMemo } from "react";
import { detectRoles, type AdminRole } from "./admin";
import { useApiConfig, useConnectedAddress, useRaises } from "./hooks";

export type RaiseModules = { attester: string; council: string };

/**
 * The attester and council of each Stage 1 raise (`modules()`, served by the API): who may act on it.
 * Keyed by lowercase raise address.
 */
export function useStage1Modules(enabled = true) {
  const raises = useRaises();
  return useMemo(() => {
    const out = new Map<string, RaiseModules>();
    if (enabled)
      for (const r of raises.data ?? [])
        if (r.phase === "Stage1" && r.modules?.attester && r.modules.council)
          out.set(r.address.toLowerCase(), { attester: r.modules.attester, council: r.modules.council });
    return { modules: out, isLoading: enabled && raises.isLoading, refetch: raises.refetch };
  }, [enabled, raises.data, raises.isLoading, raises.refetch]);
}

/**
 * Roles of the connected account, from the API only: the registry's `curator()`, the latest versions' pinned
 * attester and council (plus each Stage 1 raise's modules), and the API's `admins`.
 */
export function useAdminRoles() {
  const address = useConnectedAddress();
  const config = useApiConfig();
  const curator = config.data?.curator;
  const stage1 = useStage1Modules(Boolean(address));
  const roles = useMemo<AdminRole[]>(
    () =>
      detectRoles({
        address,
        curator,
        templates: config.data?.templates,
        admins: config.data?.admins,
        raiseModules: [...stage1.modules.values()],
      }),
    [address, curator, config.data, stage1.modules],
  );
  return {
    address,
    roles,
    has: (role: AdminRole) => roles.includes(role),
    curator,
    config: config.data,
    modules: stage1.modules,
    loading: Boolean(address) && (config.isLoading || stage1.isLoading),
  };
}
