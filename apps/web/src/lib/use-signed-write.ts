"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { useAccount, useSignMessage } from "wagmi";
import { humanizeError } from "./errors";
import type { RequestSigner } from "./signed-request";
import { txStore, useTransaction } from "./tx-store";

/** Wallet authentication and API persistence share the transaction drawer. */
export function useSignedWrite() {
  const { address } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const queryClient = useQueryClient();
  const tx = useTransaction();
  const te = useTranslations("errors");
  const t = useTranslations("tx");
  async function send<T>(
    label: string,
    write: (signer: RequestSigner) => Promise<T>,
    invalidate: readonly (readonly unknown[])[],
  ) {
    if (!address || txStore.busy()) return null;
    const id = txStore.start(label, false, "", address);
    txStore.update(id, { signedRequest: true });
    try {
      const result = await write({
        address,
        signMessage: async (args) => {
          const signature = await signMessageAsync({ ...args, account: address });
          txStore.update(id, { phase: "confirming" });
          return signature;
        },
      });
      txStore.update(id, { phase: "complete" });
      await Promise.all(invalidate.map((queryKey) => queryClient.invalidateQueries({ queryKey })));
      toast.success(t("saved"));
      return result;
    } catch (error) {
      txStore.update(id, { phase: "error", error: humanizeError(error, te) });
      return null;
    }
  }
  return { send, pending: tx?.phase === "wallet" || tx?.phase === "confirming" };
}
