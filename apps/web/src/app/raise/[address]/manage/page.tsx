"use client";

import { ProtectionBoundary, TypeBadge } from "@/components/raise/type-badge";
import { Mark } from "@/components/brand/logo";
import { ProfileEditor } from "@/components/builder/profile-editor";
import { ProposalEditor } from "@/components/builder/proposal-editor";
import { SpendEditor } from "@/components/builder/spend-editor";
import { DissolveCard } from "@/components/builder/dissolve-card";
import { PublicPosts } from "@/components/builder/public-posts";
import { BuilderPanel } from "@/components/raise/builder-panel";
import { ErrorState, LoadingState } from "@/components/states";
import { NotFoundView } from "@/components/not-found-view";
import { useRaise } from "@/lib/hooks";
import { ProjectAvatar } from "@/components/raise/project-avatar";
import { StageBadge } from "@/components/raise/stage-badge";
import { ChevronLeft } from "lucide-react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { walletSheet } from "@/lib/wallet-sheet";
import { useParams } from "next/navigation";
import { useAccount } from "wagmi";

export default function ManageRaisePage() {
  const { address: raise } = useParams<{ address: string }>();
  const { address } = useAccount();
  const { data: detail, isError, error, refetch } = useRaise(raise);
  const t = useTranslations("builderConsole");
  if (isError) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    if (code === "RAISE_NOT_FOUND" || code === "INVALID_ADDRESS") return <NotFoundView kind="raise" />;
    return <ErrorState error={error} retry={refetch} />;
  }
  if (!detail) return <LoadingState />;
  const builder = address?.toLowerCase() === detail.builder.toLowerCase();
  return (
    <div className="space-y-8 pt-2 lg:pt-4">
      <header className="flex flex-col gap-6">
        <Link
          href={`/raise/${raise}`}
          className="-mb-2 inline-flex w-fit items-center gap-1 text-xs text-fg-3 transition-colors hover:text-fg"
        >
          <ChevronLeft className="size-3.5" aria-hidden />
          {t("back")}
        </Link>
        <div className="flex min-w-0 items-start gap-4">
          <ProjectAvatar symbol={detail.symbol} profile={detail.profile} size="lg" />
          <div className="min-w-0 space-y-2">
            <h1 className="t-title">{t("title")}</h1>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-sm text-fg-2">
              <span className="font-medium text-fg">{detail.profile.name || detail.name}</span>
              <span className="font-mono text-xs text-fg-3">{detail.symbol}</span>
              <StageBadge state={detail.phase} />
              <TypeBadge template={detail.template} />
            </div>
            <ProtectionBoundary template={detail.template} />
          </div>
        </div>
      </header>
      {builder ? (
        <div key={`${raise}-${address}`} className="space-y-6">
          <ProfileEditor detail={detail} />
          <PublicPosts detail={detail} />
          {detail.phase === "Stage2" || detail.phase === "Stage3" ? (
            <section className="surface-1 space-y-4 p-5">
              {detail.governance.config.enabled && detail.phase === "Stage2" ? (
                <ProposalEditor detail={detail} />
              ) : null}
              <SpendEditor detail={detail} />
            </section>
          ) : null}
          <DissolveCard detail={detail} />
          {detail.phase === "Stage3" ? (
            <section className="surface-1 max-w-xl space-y-4 p-5">
              <h2 className="text-base font-medium">{t("actions")}</h2>
              <BuilderPanel detail={detail} />
            </section>
          ) : null}
        </div>
      ) : (
        <section className="surface-1 flex flex-col items-center gap-4 p-10 text-center" data-testid="builder-only">
          <Mark size={32} />
          <p className="text-sm text-fg-2">{t("only")}</p>
          <Button size="sm" variant="outline" onClick={walletSheet.open}>
            {t("connect")}
          </Button>
        </section>
      )}
    </div>
  );
}
