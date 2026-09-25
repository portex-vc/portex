"use client";

import type { Phase } from "./api";
import { useApiConfig } from "./hooks";

const ZERO = /^0x0{40}$/i;

/**
 * Where a listed project trades: `/markets/<raise>` in Stage 3. Hidden when the API reports that no
 * swap router is deployed (`addresses.router` is the zero address); shown when the field is absent.
 */
export function useTradeHref(raise: { address: string; phase: Phase }): string | null {
  const { data: config } = useApiConfig();
  if (raise.phase !== "Stage3") return null;
  const router = (config?.addresses as { router?: string | null } | undefined)?.router;
  if (router !== undefined && (router === null || ZERO.test(router))) return null;
  return `/markets/${raise.address}`;
}
