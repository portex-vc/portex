"use client";
import { ActionButton } from "@/components/action-button";
import { raiseInvalidations } from "@/components/raise/common";
import type { RaiseDetail } from "@/lib/api";
import { raiseAbi } from "@/lib/contracts";
import { useApiConfig, useNow, useTx } from "@/lib/hooks";
import { useNumbers } from "@/lib/use-numbers";
import { useTranslations } from "next-intl";
import type { Address } from "viem";
import { useAccount } from "wagmi";

/**
 * Builder-only: after the Stage 1 minimum the team may dissolve the project. Every position then
 * claims its full cost (or moves it to another project) and the team can relaunch a new version.
 */
export function DissolveCard({ detail: r }: { detail: RaiseDetail }) {
  const v = useTranslations("v31"),
    n = useNumbers(),
    now = useNow();
  const { address } = useAccount();
  const { data: config } = useApiConfig();
  const { send, pending } = useTx();
  if (r.phase !== "Stage1" || address?.toLowerCase() !== r.builder.toLowerCase()) return null;
  // The raise's own pinned timing wins; older APIs only expose the deployment-wide bounds.
  const minimum = Number(r.governance.config.parameters.stage1Min ?? config?.stageBounds?.stage1Min ?? 0);
  const from = r.deadlines.start + minimum;
  const ready = Boolean(config) && now >= from;
  return (
    <section className="surface-1 max-w-xl space-y-3 p-5" data-testid="dissolve-card">
      <h2 className="text-base font-medium">{v("dissolveTitle")}</h2>
      <p className="text-sm leading-relaxed text-fg-2">{v("dissolveBody")}</p>
      <ActionButton
        variant="outline"
        data-testid="dissolve"
        label={v("dissolveAction")}
        pending={pending}
        reason={!config ? v("checking") : ready ? null : v("dissolveAvailable", { date: n.date(from) })}
        onClick={() =>
          send(
            { address: r.address as Address, abi: raiseAbi, functionName: "dissolve", args: [] },
            {
              label: v("dissolveAction"),
              preview: [
                [v("outcome"), v("outcomeRefund"), "total"],
                [v("refundPool"), `${n.quote(r.E)} ${r.quote.symbol}`],
                [v("dissolveTitle"), v("dissolveConfirm"), "meta"],
              ],
              invalidate: raiseInvalidations(r.address, address),
            },
          )
        }
      />
    </section>
  );
}
