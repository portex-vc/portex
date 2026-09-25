"use client";

import { MarkLoader } from "@/components/brand/logo";
import { QuoteTable } from "@/components/figures";
import { Button } from "@/components/ui/button";
import { explorerUrl } from "@/lib/chains";
import { txStore, useTransaction } from "@/lib/tx-store";
import { cn } from "@/lib/utils";
import * as Dialog from "@radix-ui/react-dialog";
import { AlertTriangle, Check, CircleSlash, Copy, ExternalLink, Loader2, PenLine, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";

type Status = "review" | "signing" | "pending" | "confirmed" | "reverted" | "failed" | "cancelled";

/**
 * The one transaction drawer: review → signing → pending → confirmed, or reverted / failed.
 * Every write passes through it, so the reviewed quote is on screen when the wallet asks to sign.
 */
export function TransactionDrawer() {
  const t = useTranslations("tx");
  const v = useTranslations("v31");
  const tx = useTransaction();
  const [copied, setCopied] = useState<string | null>(null);
  if (!tx) return null;
  const busy = tx.phase === "wallet" || tx.phase === "confirming";
  const status: Status =
    tx.phase === "review"
      ? "review"
      : tx.phase === "wallet"
        ? "signing"
        : tx.phase === "confirming"
          ? "pending"
          : tx.phase === "complete"
            ? "confirmed"
            : tx.cancelled
              ? "cancelled"
              : tx.reverted
                ? "reverted"
                : "failed";
  const steps = tx.signedRequest ? ["sign", "save"] : [...(tx.approval ? ["approve"] : []), "send", "confirm"];
  const active = tx.phase === "wallet" ? (tx.approval && !tx.approvalHash ? "approve" : "send") : "confirm";
  const statusTone =
    status === "confirmed"
      ? "text-positive"
      : status === "reverted" || status === "failed"
        ? "text-negative"
        : status === "cancelled"
          ? "text-fg-3"
          : "text-fg";
  const StatusIcon =
    status === "confirmed"
      ? Check
      : status === "reverted" || status === "failed"
        ? AlertTriangle
        : status === "cancelled"
          ? CircleSlash
          : status === "review"
            ? PenLine
            : Loader2;
  return (
    <>
      {!tx.open && busy ? (
        <Button className="fixed bottom-4 right-4 z-50 shadow-lg" onClick={() => txStore.setOpen(true)}>
          <Loader2 className="animate-spin" />
          {t("reopen")}
        </Button>
      ) : null}
      <Dialog.Root open={tx.open} onOpenChange={txStore.setOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-bg/70 backdrop-blur-sm duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
          <Dialog.Content
            className="fixed inset-y-2 right-2 z-50 flex w-[calc(100%-1rem)] max-w-md flex-col overflow-y-auto rounded-2xl border border-fg/[0.08] bg-surface-1 shadow-2xl duration-300 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-right-8 data-[state=open]:slide-in-from-right-8"
            data-testid="transaction-drawer"
            data-status={status}
          >
            <div className="flex items-start justify-between gap-3 border-b border-fg/[0.07] p-6 pb-5">
              <div className="min-w-0 space-y-1.5">
                <p className="micro">{t(tx.signedRequest ? "signedTitle" : "title")}</p>
                <Dialog.Title className="text-xl font-medium leading-7">{tx.action}</Dialog.Title>
                <Dialog.Description
                  className={cn("flex items-center gap-1.5 text-sm", statusTone)}
                  data-testid="transaction-status"
                >
                  {status === "signing" || status === "pending" ? (
                    <MarkLoader size={15} className="shrink-0" />
                  ) : (
                    <StatusIcon className="size-3.5 shrink-0" aria-hidden />
                  )}
                  {t(tx.signedRequest ? `signedStatus.${status === "reverted" ? "failed" : status}` : `status.${status}`)}
                </Dialog.Description>
              </div>
              <Dialog.Close asChild>
                <Button variant="ghost" size="icon" aria-label={t("close")} className="-mr-2 -mt-1 shrink-0">
                  <X className="size-4" />
                </Button>
              </Dialog.Close>
            </div>

            <div className="flex flex-1 flex-col gap-6 p-6">
              {tx.preview?.length ? (
                <section className="space-y-2">
                  <h3 className="micro">{t("reviewHeading")}</h3>
                  <div className="rounded-[12px] border border-fg/[0.07] bg-fg/[0.02] px-4 py-2.5">
                    <QuoteTable rows={tx.preview} testId="transaction-quote" />
                  </div>
                </section>
              ) : null}

              {status === "review" ? (
                <div className="space-y-2">
                  <Button data-testid="confirm-transaction" className="w-full" onClick={txStore.confirm}>
                    {v("confirm")}
                  </Button>
                  <p className="text-2xs leading-4 text-fg-3">{t("reviewHint")}</p>
                </div>
              ) : (
                <ol className="flex flex-col gap-4" aria-live="polite" data-testid="transaction-steps">
                  {steps.map((step, i) => {
                    const done =
                      (tx.signedRequest && step === "sign" && tx.phase === "confirming") ||
                      (step === "approve" && Boolean(tx.approvalHash)) ||
                      tx.phase === "complete" ||
                      (Boolean(tx.hash) && step !== "confirm");
                    const current =
                      (tx.signedRequest ? step === (tx.phase === "wallet" ? "sign" : "save") : step === active) &&
                      !done;
                    const failed = current && tx.phase === "error";
                    return (
                      <li key={step} className="flex gap-3">
                        <span
                          className={cn(
                            "mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border",
                            done
                              ? "border-positive bg-positive/10 text-positive"
                              : failed
                                ? "border-negative bg-negative/10 text-negative"
                                : current
                                  ? "border-fg bg-fg text-bg"
                                  : "border-fg/[0.07] text-fg-3",
                          )}
                        >
                          {done ? (
                            <Check className="size-3" />
                          ) : failed ? (
                            <X className="size-3" />
                          ) : (
                            <span className="num text-2xs">{i + 1}</span>
                          )}
                        </span>
                        <div className="min-w-0">
                          <p className={cn("text-sm font-medium", !done && !current && "text-fg-2")}>{t(step)}</p>
                          {step === "approve" && tx.approvalHash ? (
                            <p className="mt-1 break-all font-mono text-2xs text-fg-3">{tx.approvalHash}</p>
                          ) : null}
                          <p className="mt-0.5 text-xs text-fg-2">
                            {t(
                              done
                                ? "done"
                                : current
                                  ? tx.phase === "error"
                                    ? tx.cancelled
                                      ? "cancelledStep"
                                      : "failed"
                                    : step === "save"
                                      ? "saving"
                                      : step === "confirm"
                                        ? "confirming"
                                        : "wallet"
                                  : tx.phase === "error"
                                    ? "notReached"
                                    : "waiting",
                            )}
                          </p>
                        </div>
                      </li>
                    );
                  })}
                </ol>
              )}

              {tx.error ? (
                <p
                  role="alert"
                  className="rounded-md border border-negative/40 bg-negative/10 p-3 text-sm leading-relaxed text-negative"
                >
                  {tx.error}
                </p>
              ) : null}

              {tx.hash ? (
                <section className="space-y-2 border-t border-fg/[0.07] pt-5">
                  <h3 className="micro">{t("hash")}</h3>
                  <p className="break-all font-mono text-xs text-fg-2" data-testid="transaction-hash">
                    {tx.hash}
                  </p>
                  <div className="flex flex-wrap items-center gap-2 pt-1">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={async () => {
                        try {
                          await navigator.clipboard.writeText(tx.hash!);
                          setCopied(tx.hash!);
                        } catch {
                          setCopied(null);
                        }
                      }}
                    >
                      {copied === tx.hash ? <Check className="size-3" /> : <Copy className="size-3" />}
                      {t(copied === tx.hash ? "copied" : "copy")}
                    </Button>
                    {explorerUrl ? (
                      <Button asChild size="sm" variant="outline">
                        <a href={`${explorerUrl}/tx/${tx.hash}`} target="_blank" rel="noreferrer">
                          <ExternalLink className="size-3" />
                          {t("explorer")}
                        </a>
                      </Button>
                    ) : (
                      <span className="text-xs text-fg-3">{t("local")}</span>
                    )}
                  </div>
                </section>
              ) : null}

              {tx.phase === "complete" ? (
                <p className="text-sm text-positive" role="status">
                  {t(tx.signedRequest ? "saved" : "complete")}
                </p>
              ) : null}
            </div>

            <div className="border-t border-fg/[0.07] p-6 pt-4">
              <Dialog.Close asChild>
                <Button variant="outline" className="w-full">
                  {t(busy ? "background" : status === "review" ? "cancel" : "close")}
                </Button>
              </Dialog.Close>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}
