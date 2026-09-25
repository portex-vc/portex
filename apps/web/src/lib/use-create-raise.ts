"use client";
import { api } from "./api";
import { raiseFactoryAbi } from "./contracts";
import { creationConfig, validateCreation, type FormState } from "./create-form";
import { useApiConfig, useTx } from "./hooks";
import { useSignedWrite } from "./use-signed-write";
import { waitForTransactionReceipt } from "@wagmi/core";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { decodeEventLog, type Address } from "viem";
import { useAccount, useConfig } from "wagmi";
export function useCreateRaise(form: FormState) {
  const t = useTranslations("create"),
    v = useTranslations("v31");
  const router = useRouter();
  const { address } = useAccount();
  const config = useConfig();
  const { data: apiConfig } = useApiConfig();
  const { send, pending } = useTx();
  const signed = useSignedWrite();
  const [created, setCreated] = useState<Address | null>(null);
  const template = apiConfig?.templates.find((x) => x.name === form.templateName && !x.deprecated);
  const chainReason = !apiConfig
    ? t("backend")
    : !template
      ? t("noTemplate")
      : apiConfig.chainId !== config.state.chainId
        ? v("wrongChain")
        : !apiConfig.quote.quoteFrozen
          ? v("templateError")
          : null;
  async function save(raise: Address) {
    if (form.description.trim() || form.website.trim()) {
      const result = await signed.send(
        t("retryMetadata"),
        (signer) =>
          api.postMetadata(
            raise,
            { description: form.description.trim(), website: form.website.trim() || undefined },
            signer,
          ),
        [["raises"], ["raise", raise]],
      );
      if (!result) return;
    }
    router.push(`/raise/${raise}`);
  }
  async function submit() {
    if (!address || !apiConfig || !template || chainReason || validateCreation(form, apiConfig).length) return;
    if (created) {
      await save(created);
      return;
    }
    const cfg = creationConfig(form, apiConfig.quote.address as Address, apiConfig);
    const hash = await send(
      {
        address: apiConfig.addresses.factory as Address,
        abi: raiseFactoryAbi,
        functionName: "createRaise",
        args: [template.id, BigInt(template.version), cfg, { name: form.name.trim(), symbol: form.symbol.trim() }],
      },
      {
        label: t("submit"),
        preview: [
          [v("name"), form.name],
          [v("symbol"), form.symbol],
          [v("supply"), form.supply],
          [v("treasury"), v("treasuryIntro"), "meta"],
        ],
        invalidate: [["raises"]],
      },
    );
    if (!hash) return;
    const receipt = await waitForTransactionReceipt(config, { hash });
    for (const log of receipt.logs) {
      try {
        const decoded = decodeEventLog({ abi: raiseFactoryAbi, data: log.data, topics: log.topics });
        if (decoded.eventName === "RaiseCreated") {
          const raise = (decoded.args as unknown as { raise: Address }).raise;
          setCreated(raise);
          await save(raise);
          return;
        }
      } catch {
        /* Ignore unrelated module logs. */
      }
    }
  }
  return { apiConfig, chainReason, submit, pending: pending || signed.pending, created };
}
