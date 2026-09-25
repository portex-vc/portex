"use client";

import { Mark } from "@/components/brand/logo";
import { Reveal } from "@/components/motion/reveal";
import { ErrorState, LoadingState } from "@/components/states";
import { useUpdates } from "@/lib/hooks";
import { useNumbers } from "@/lib/use-numbers";
import { cn } from "@/lib/utils";
import { useTranslations } from "next-intl";

export function BuilderUpdates({ raise }: { raise: string }) {
  const t = useTranslations("updates");
  const n = useNumbers();
  const { data, isLoading, isError, error, refetch } = useUpdates(raise);
  return (
    <section className="surface-1 p-5">
      <h3 className="mb-4 text-sm font-medium">{t("title")}</h3>
      {isLoading ? (
        <LoadingState rows={2} />
      ) : isError ? (
        <ErrorState error={error} retry={refetch} />
      ) : !data?.length ? (
        <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-hairline-strong py-6 text-center">
          <Mark size={24} className="text-fg-3" />
          <p className="text-xs text-fg-2">{t("empty")}</p>
        </div>
      ) : (
        <ol className="divide-y divide-hairline border-t border-hairline">
          {data.map((update, index) => (
            <li key={update.id} className="py-4 last:pb-0">
              <Reveal index={index}>
                <div className="flex items-center gap-3">
                  <span
                    className={cn(
                      "rounded-full px-2 py-0.5 text-2xs font-medium",
                      update.kind === "milestone"
                        ? "bg-positive/10 text-positive"
                        : update.kind === "incident"
                          ? "bg-negative/10 text-negative"
                          : "bg-surface-3 text-fg-2",
                    )}
                  >
                    {t(`kinds.${update.kind}`)}
                  </span>
                  <time className="num text-xs text-fg-3" dateTime={new Date(update.createdAt * 1000).toISOString()}>
                    {n.date(update.createdAt)}
                  </time>
                </div>
                <h4 className="mt-2.5 text-sm font-medium">{update.title}</h4>
                <p className="mt-1 whitespace-pre-wrap break-words text-sm leading-relaxed text-fg-2">{update.body}</p>
              </Reveal>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
