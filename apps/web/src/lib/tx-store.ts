"use client";

import { useSyncExternalStore } from "react";
import type { Hash } from "viem";
import type { Row } from "@/components/figures";

type TxPhase = "review" | "wallet" | "confirming" | "complete" | "error";
interface Transaction {
  id: number;
  open: boolean;
  action: string;
  approval: boolean;
  signedRequest?: boolean;
  approvalHash?: Hash;
  phase: TxPhase;
  hash?: Hash;
  error?: string;
  revertData?: string;
  /** The receipt was mined with status "reverted" (as opposed to a rejected or failed request). */
  reverted?: boolean;
  /** The user closed the review without signing. */
  cancelled?: boolean;
  preview?: Row[];
}
let transaction: Transaction | null = null;
let sequence = 0;
let approvalReceipt: { spender: string; owner: string; hash: Hash } | null = null;
let reviewResolve: ((confirmed: boolean) => void) | null = null;
const listeners = new Set<() => void>();
const publish = () => listeners.forEach((listener) => listener());
export const txStore = {
  start(action: string, approval: boolean, address: string, owner: string): number {
    const id = ++sequence;
    const approvalHash =
      !approval &&
      approvalReceipt?.spender.toLowerCase() === address.toLowerCase() &&
      approvalReceipt.owner.toLowerCase() === owner.toLowerCase()
        ? approvalReceipt.hash
        : undefined;
    approvalReceipt = null;
    transaction = {
      id,
      open: true,
      action,
      approval: approval || Boolean(approvalHash),
      approvalHash,
      phase: "wallet",
    };
    publish();
    return id;
  },
  review(id: number, preview: Row[]): Promise<boolean> {
    this.update(id, { phase: "review", preview });
    return new Promise((resolve) => {
      reviewResolve = resolve;
    });
  },
  confirm() {
    reviewResolve?.(true);
    reviewResolve = null;
  },
  rememberApproval(spender: string, owner: string, hash: Hash) {
    approvalReceipt = { spender, owner, hash };
  },
  update(id: number, patch: Partial<Transaction>) {
    if (transaction?.id !== id) return;
    transaction = { ...transaction, ...patch };
    publish();
  },
  setOpen(open: boolean) {
    if (!transaction) return;
    if (!open && transaction.phase === "review") {
      reviewResolve?.(false);
      reviewResolve = null;
      transaction = { ...transaction, phase: "error", cancelled: true };
    }
    transaction = { ...transaction, open };
    publish();
  },
  busy() {
    return transaction?.phase === "review" || transaction?.phase === "wallet" || transaction?.phase === "confirming";
  },
};
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
export function useTransaction() {
  return useSyncExternalStore(
    subscribe,
    () => transaction,
    () => null,
  );
}
