"use client";

import { useSyncExternalStore } from "react";

/** Open state of the wallet sheet, so any "Connect wallet" prompt can open the one header sheet. */
let open = false;
const listeners = new Set<() => void>();
const publish = () => listeners.forEach((listener) => listener());

export const walletSheet = {
  open() {
    open = true;
    publish();
  },
  set(next: boolean) {
    open = next;
    publish();
  },
};

export function useWalletSheetOpen() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => open,
    () => false,
  );
}
