"use client";

import { Mark } from "@/components/brand/logo";
import { Reveal } from "@/components/motion/reveal";
import { Button } from "@/components/ui/button";
import { useActivity } from "@/lib/hooks";
import { useNumbers } from "@/lib/use-numbers";
import { useTranslations } from "next-intl";

export function ActivityFeed({ raiseAddress }: { raiseAddress: string }) {
  const t = useTranslations("activity");
  const n = useNumbers();
  const { data, isLoading, isError, refetch } = useActivity(raiseAddress);
  return (
    <section className="surface-1 min-w-0 space-y-4 p-5">
      <h3 className="text-sm font-medium">{t("title")}</h3>
      {isLoading ? (
        <div className="space-y-3" aria-busy>
          {[0, 1, 2].map((i) => (
            <div key={i} className="skeleton h-16 rounded-[10px]" />
          ))}
        </div>
      ) : isError || !data?.length ? (
        <div className="flex flex-col items-center gap-3 py-6 text-center">
          <Mark size={28} />
          <p className="text-sm text-fg-2">{t(isError ? "error" : "empty")}</p>
          <Button size="sm" variant="outline" onClick={() => refetch()}>
            {t("refresh")}
          </Button>
        </div>
      ) : (
        <ol>
          {data.map((event, index) => (
            <li key={`${event.txHash}-${index}`} className="border-t border-hairline py-3">
              <Reveal index={index}>
                <p className="break-words text-sm leading-relaxed">{event.summary}</p>
                <time className="num mt-1 block text-2xs text-fg-2">{n.date(event.timestamp)}</time>
                <details className="mt-2 text-2xs text-fg-3">
                  <summary className="cursor-pointer">{t("details")}</summary>
                  <p className="mt-2 break-all font-mono">{event.txHash}</p>
                  <pre className="scroll-thin mt-2 max-h-48 overflow-auto rounded-md bg-surface-2 p-2">
                    {JSON.stringify(event.data, null, 2)}
                  </pre>
                </details>
              </Reveal>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
