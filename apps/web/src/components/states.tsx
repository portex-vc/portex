"use client";

import { Mark } from "@/components/brand/logo";
import { Button } from "@/components/ui/button";
import { humanizeError } from "@/lib/errors";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { useTranslations } from "next-intl";

export function LoadingState({ rows = 3 }: { rows?: number }) {
  return (
    <div className="flex flex-col gap-3" aria-busy>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="skeleton h-20 w-full rounded-[14px]" />
      ))}
    </div>
  );
}

export function ErrorState({ error, retry }: { error: unknown; retry?: () => void }) {
  const t = useTranslations("common");
  const te = useTranslations("errors");
  const message = humanizeError(error, te);
  return (
    <div
      role="alert"
      data-testid="error-state"
      className="surface-1 flex flex-col items-center gap-3 px-6 py-10 text-center"
    >
      <span className="flex size-9 items-center justify-center rounded-full bg-negative/10 text-negative">
        <AlertTriangle className="size-4" aria-hidden />
      </span>
      <p className="text-sm font-medium">{t("errorTitle")}</p>
      <p className="max-w-md text-sm leading-relaxed text-fg-2">{message}</p>
      {retry ? (
        <Button variant="outline" size="sm" onClick={retry} className="mt-1">
          <RefreshCw /> {t("retry")}
        </Button>
      ) : null}
    </div>
  );
}

export function EmptyState({ title, detail, action }: { title: string; detail?: string; action?: React.ReactNode }) {
  return (
    <div className="surface-1 flex flex-col items-center gap-2 px-6 py-10 text-center" data-testid="empty-state">
      <Mark size={24} className="mb-1 text-fg-3" />
      <p className="text-sm font-medium">{title}</p>
      {detail ? <p className="max-w-md text-sm leading-relaxed text-fg-2">{detail}</p> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}
