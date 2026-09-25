"use client";
import type { RaiseDetail } from "@/lib/api";
import { usePosition } from "@/lib/hooks";
import { useAccount } from "wagmi";
import { TerminalActions } from "./action-rail";
export function BuilderPanel({ detail }: { detail: RaiseDetail }) {
  const { address } = useAccount();
  const { data } = usePosition(detail.address, address);
  return detail.phase === "Stage3" ? <TerminalActions detail={detail} position={data} /> : null;
}
