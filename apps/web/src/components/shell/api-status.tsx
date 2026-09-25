"use client";

import { useHealth } from "@/lib/hooks";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { useTranslations } from "next-intl";

/** One quiet line under the header while the Portex API is unreachable, instead of silently empty pages. */
export function ApiStatus() {
  const t = useTranslations("apiStatus");
  const health = useHealth();
  if (!health.isError && health.data?.ok !== false) return null;
  const down = health.isError;
  return (
    <div className="border-t border-risk/30 bg-risk/10" role="status" data-testid="api-status">
      <div className="container flex flex-wrap items-center justify-between gap-2 py-2 text-xs text-risk">
        <span className="inline-flex items-center gap-2">
          <AlertTriangle className="size-3.5 shrink-0" aria-hidden />
          {t(down ? "down" : "degraded")}
        </span>
        <button
          type="button"
          onClick={() => health.refetch()}
          className="inline-flex items-center gap-1.5 rounded px-2 py-1 font-medium hover:bg-risk/10"
        >
          <RefreshCw className={`size-3 ${health.isFetching ? "animate-spin" : ""}`} aria-hidden />
          {t("retry")}
        </button>
      </div>
    </div>
  );
}
