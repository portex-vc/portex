"use client";

import { Button } from "@/components/ui/button";
import { appChain } from "@/lib/chains";
import { erc20Abi } from "@/lib/contracts";
import { useApiConfig, useTx } from "@/lib/hooks";
import { useNumbers } from "@/lib/use-numbers";
import { useTranslations } from "next-intl";
import { useAccount } from "wagmi";
import type { Address } from "viem";

export function TestUsdgFaucet({ quoteAddress }: { quoteAddress?: string }) {
  const t = useTranslations("faucet");
  const n = useNumbers();
  const { address, chainId } = useAccount();
  const { data: config } = useApiConfig();
  const { send, pending } = useTx();
  if (appChain.id !== 1952 || !address || config?.chainId !== appChain.id || !config.quote.testToken) return null;
  if (quoteAddress && quoteAddress.toLowerCase() !== config.quote.address.toLowerCase()) return null;
  const amount = 10_000n * 10n ** 6n;
  return (
    <section className="surface-1 space-y-3 p-5" data-testid="test-usdg-faucet">
      <h2 className="text-base font-medium">{t("title")}</h2>
      <p className="text-sm text-fg-2">{t("description")}</p>
      <Button
        disabled={pending || chainId !== appChain.id}
        onClick={() =>
          send(
            { address: config.quote.address as Address, abi: erc20Abi, functionName: "mint", args: [address, amount] },
            {
              label: t("title"),
              preview: [
                [t("recipient"), address],
                [t("amount"), `${n.quote(amount)} TEST USDG`],
              ],
              invalidate: [["readContract"], ["position"]],
            },
          )
        }
      >
        {t(chainId !== appChain.id ? "switchNetwork" : "mint", { amount: n.quote(amount) })}
      </Button>
    </section>
  );
}
