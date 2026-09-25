"use client";

import { OverviewTab, RaiseSkeleton } from "@/components/raise/raise-tabs";

import { Crossfade } from "@/components/motion/reveal";
import { ActionRail } from "@/components/raise/action-rail";
import { ActivityFeed } from "@/components/raise/activity-feed";
import { FeedbackPanel } from "@/components/raise/feedback-panel";
import { MarketPanel } from "@/components/raise/market-panel";
import { ProposalsPanel } from "@/components/raise/proposals-panel";
import { RaiseHeader } from "@/components/raise/raise-header";
import { StageTimeline } from "@/components/raise/stage-timeline";
import { ErrorState } from "@/components/states";
import { NotFoundView } from "@/components/not-found-view";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useRaise } from "@/lib/hooks";
import { useTranslations } from "next-intl";
import { useParams, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";

export default function RaiseDetailPage() {
  const params = useParams<{ address: string }>();
  const address = params.address;
  const search = useSearchParams();
  const requestedTab = search.get("tab");
  const tt = useTranslations("raise.tabs");
  const { data: detail, isLoading, isError, error, refetch } = useRaise(address);
  const [tab, setTab] = useState<string | null>(null);

  const previousRaiseStage = useRef<string | null>(null);

  // Default tab follows the stage: Market once a pool exists, Overview before.
  useEffect(() => {
    if (!detail) return;
    const key = `${detail.address}-${detail.phase}-${requestedTab ?? ""}`;
    if (previousRaiseStage.current !== key) {
      setTab(
        requestedTab && ["overview", "market", "governance", "activity"].includes(requestedTab)
          ? requestedTab
          : detail.phase === "Stage2" || detail.phase === "ListingPending" || detail.phase === "Stage3"
            ? "market"
            : "overview",
      );
      previousRaiseStage.current = key;
    }
  }, [detail, requestedTab]);

  if (isLoading || !detail) {
    if (isError) {
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
      if (code === "RAISE_NOT_FOUND" || code === "INVALID_ADDRESS") return <NotFoundView kind="raise" />;
      return <ErrorState error={error} retry={() => refetch()} />;
    }
    return <RaiseSkeleton />;
  }

  const active = tab ?? "overview";

  return (
    <div className="flex flex-col gap-10 pt-4 lg:pt-6">
      <RaiseHeader detail={detail} />
      <StageTimeline detail={detail} />
      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_23rem] xl:gap-12">
        <Tabs value={active} onValueChange={setTab} className="min-w-0">
          <TabsList className="scroll-thin overflow-x-auto pr-8 [mask-image:linear-gradient(to_right,#000_calc(100%-2.5rem),transparent)] sm:pr-0 sm:[mask-image:none]">
            {(["overview", "market", "governance", "activity"] as const).map((k) => (
              <TabsTrigger key={k} value={k}>
                {tt(k)}
              </TabsTrigger>
            ))}
          </TabsList>
          <TabsContent value="overview">
            <Crossfade id="overview">
              <OverviewTab detail={detail} />
            </Crossfade>
          </TabsContent>
          <TabsContent value="market">
            <Crossfade id="market">
              <MarketPanel detail={detail} />
            </Crossfade>
          </TabsContent>
          <TabsContent value="governance">
            <Crossfade id="governance">
              <ProposalsPanel detail={detail} />
            </Crossfade>
          </TabsContent>
          <TabsContent value="activity">
            <Crossfade id="activity">
              <div className="grid min-w-0 gap-4">
                <ActivityFeed raiseAddress={detail.address} />
                <FeedbackPanel raiseAddress={detail.address} />
              </div>
            </Crossfade>
          </TabsContent>
        </Tabs>
        <ActionRail detail={detail} />
      </div>
    </div>
  );
}
