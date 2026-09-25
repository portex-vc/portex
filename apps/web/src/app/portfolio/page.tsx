"use client";
import { TestUsdgFaucet } from "@/components/test-usdg-faucet";
import { ProjectAvatar } from "@/components/raise/project-avatar";
import { StageBadge } from "@/components/raise/stage-badge";
import { PositionRecords } from "@/components/raise/position-ledger";
import { PortfolioInbox } from "@/components/portfolio/inbox";
import { CHEVRON, SUMMARY } from "@/components/disclosure";
import { ConnectPrompt } from "@/components/shell/wallet";
import { EmptyState, ErrorState } from "@/components/states";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { queryKeys, useConnectedAddress, useRaises } from "@/lib/hooks";
import { useNumbers } from "@/lib/use-numbers";
import { cn } from "@/lib/utils";
import { useQueries } from "@tanstack/react-query";
import { ArrowRight, Check, ChevronDown, Wallet } from "lucide-react";
import { useTranslations } from "next-intl";
import Link from "next/link";

export default function PortfolioPage() {
  const t = useTranslations("portfolio"),
    v = useTranslations("v31"),
    n = useNumbers();
  const address = useConnectedAddress();
  const raises = useRaises();
  const positions = useQueries({
    queries: (raises.data ?? []).map((r) => ({
      queryKey: queryKeys.position(r.address, address),
      queryFn: () => api.position(r.address, address!),
      enabled: Boolean(address),
      refetchInterval: 10000,
    })),
  });
  const rows = (raises.data ?? [])
    .map((r, i) => ({ r, p: positions[i]?.data }))
    .filter(
      ({ p }) =>
        p &&
        (p.positions.length > 0 ||
          BigInt(p.walletTokenBalance) > 0n ||
          BigInt(p.quota) > 0n ||
          BigInt(p.buyerLedger.tokens) > 0n),
    );
  const protectedTotal = rows.reduce(
    (sum, { p }) =>
      sum + (p && p.phase !== "Stage3" ? p.positions.reduce((a, x) => a + BigInt(x.guaranteedClaim.amount), 0n) : 0n),
    0n,
  );
  const positionCount = rows.reduce((sum, { p }) => sum + (p?.positions.length ?? 0), 0);
  const rewardsTotal = rows.reduce((sum, { p }) => sum + BigInt(p?.pendingRewards.quote ?? 0), 0n);
  const loading = raises.isLoading || positions.some((p) => p.isLoading);
  const failed = positions.find((p) => p.isError);
  const symbol = raises.data?.[0]?.quote.symbol ?? "USDG";
  return (
    <div className="space-y-8 pt-2 lg:pt-4">
      <header className="space-y-2">
        <h1 className="t-title">{t("title")}</h1>
        <p className="text-[0.9375rem] text-fg-2">{v("portfolioDescription")}</p>
      </header>
      {!address ? (
        <section
          className="surface-1 grid overflow-hidden lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]"
          data-testid="portfolio-connect"
        >
          <div className="flex flex-col justify-center gap-5 p-6 sm:p-9">
            <span className="flex size-10 items-center justify-center rounded-[12px] border border-fg/[0.1] bg-fg/[0.04] text-fg-2">
              <Wallet className="size-[18px]" aria-hidden />
            </span>
            <div className="space-y-2">
              <h2 className="t-section">{t("connectTitle")}</h2>
              <ConnectPrompt text={v("connectPortfolio")} className="max-w-md gap-5" />
            </div>
          </div>
          <div className="border-t border-fg/[0.07] bg-fg/[0.015] p-6 sm:p-9 lg:border-l lg:border-t-0">
            <dl className="grid grid-cols-2 gap-x-6 gap-y-6" aria-hidden>
              {[v("claimAtCostTotal"), v("raisesHeld"), v("positionsHeld"), v("pendingRewards")].map((label, i) => (
                <div key={label} className="min-w-0">
                  <dt className="truncate text-xs text-fg-3">{label}</dt>
                  <dd className={cn("t-figure mt-1.5 text-fg/25", i === 0 && "text-protected/40")}>—</dd>
                </div>
              ))}
            </dl>
            <ul className="mt-7 space-y-3 border-t border-fg/[0.07] pt-6 text-sm text-fg-2">
              {(["claims", "rewards", "actions"] as const).map((key) => (
                <li key={key} className="flex gap-3">
                  <Check className="mt-0.5 size-4 shrink-0 text-fg-3" aria-hidden />
                  <span className="leading-relaxed">{t(`preview.${key}`)}</span>
                </li>
              ))}
            </ul>
          </div>
        </section>
      ) : (
        <>
          <dl className="grid grid-cols-2 gap-y-8 border-y border-fg/[0.07] py-8 lg:grid-cols-[1.5fr_1fr_1fr_1fr]">
            <div className="col-span-2 min-w-0 lg:col-span-1">
              <dt className="text-xs text-fg-3">{v("claimAtCostTotal")}</dt>
              <dd className="t-figure-xl mt-2 text-protected">
                {loading ? (
                  <span aria-hidden className="skeleton inline-block h-9 w-44 align-bottom" />
                ) : (
                  <>
                    {n.quote(protectedTotal)}
                    <span className="ml-2 text-sm tracking-normal text-fg-3">{symbol}</span>
                  </>
                )}
              </dd>
            </div>
            {(
              [
                [v("raisesHeld"), n.number(rows.length, 0), ""],
                [v("positionsHeld"), n.number(positionCount, 0), ""],
                [v("pendingRewards"), n.quote(rewardsTotal), symbol],
              ] as const
            ).map(([label, value, unit]) => (
              <div key={label} className="min-w-0 lg:border-l lg:border-fg/[0.07] lg:pl-8">
                <dt className="text-xs text-fg-3">{label}</dt>
                <dd className="t-figure-lg mt-2">
                  {loading ? (
                    <span aria-hidden className="skeleton inline-block h-7 w-16 align-bottom" />
                  ) : (
                    <>
                      {value}
                      {unit ? <span className="ml-1.5 text-xs tracking-normal text-fg-3">{unit}</span> : null}
                    </>
                  )}
                </dd>
              </div>
            ))}
          </dl>
          <PortfolioInbox address={address} />
          <section className="space-y-3" aria-labelledby="holdings">
            <h2 id="holdings" className="t-section pt-4">
              {v("holdings")}
            </h2>
            {raises.isError ? (
              <ErrorState error={raises.error} retry={raises.refetch} />
            ) : failed ? (
              <ErrorState error={failed.error} retry={() => positions.forEach((p) => p.refetch())} />
            ) : loading ? (
              <div className="surface-1 divide-y divide-fg/[0.06]" aria-busy>
                {[0, 1, 2].map((i) => (
                  <div key={i} className="flex items-center gap-4 px-5 py-4">
                    <span className="skeleton size-6 shrink-0 rounded-[7px]" />
                    <span className="skeleton h-4 w-40" />
                    <span className="skeleton ml-auto h-4 w-24" />
                    <span className="skeleton hidden h-4 w-24 sm:block" />
                  </div>
                ))}
              </div>
            ) : rows.length ? (
              <>
                {/* Phones: one card per project instead of a table that scrolls sideways. */}
                <ul className="surface-1 divide-y divide-fg/[0.06] sm:hidden" data-testid="portfolio-cards">
                  {rows.map(({ r, p }) => {
                    const listed = p!.phase === "Stage3";
                    const claim = p!.positions.reduce((sum, x) => sum + BigInt(x.guaranteedClaim.amount), 0n);
                    const tokens = listed
                      ? BigInt(p!.walletTokenBalance)
                      : p!.positions.reduce((sum, x) => sum + BigInt(x.positionState.tokens), 0n) +
                        BigInt(p!.buyerLedger.tokens);
                    return (
                      <li key={r.address} className="space-y-3.5 px-4 py-4">
                        <div className="flex items-center gap-3">
                          <Link href={`/raise/${r.address}`} className="flex min-w-0 flex-1 items-center gap-3">
                            <ProjectAvatar symbol={r.symbol} profile={r.profile} />
                            <span className="min-w-0">
                              <span className="block truncate text-sm font-medium">{r.profile.name || r.name}</span>
                              <span className="block font-mono text-2xs text-fg-3">{r.symbol}</span>
                            </span>
                          </Link>
                          <span className="shrink-0">
                            <StageBadge state={r.phase} form="short" />
                          </span>
                        </div>
                        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-xs">
                          {listed ? (
                            <>
                              <div className="min-w-0">
                                <dt className="text-fg-3">{v("quota")}</dt>
                                <dd className="num mt-0.5 text-sm">
                                  {n.token(p!.quota)} <span className="text-xs text-fg-3">{r.symbol}</span>
                                </dd>
                              </div>
                              <div className="min-w-0">
                                <dt className="text-fg-3">{v("pendingRewards")}</dt>
                                <dd className="num mt-0.5 text-sm">
                                  {n.quote(p!.pendingRewards.quote)}{" "}
                                  <span className="text-xs text-fg-3">{r.quote.symbol}</span>
                                </dd>
                              </div>
                            </>
                          ) : (
                            <div className="min-w-0">
                              <dt className="text-fg-3">{v("guaranteedClaim")}</dt>
                              <dd className="num mt-0.5 text-sm text-protected">
                                {n.quote(claim)} <span className="text-xs text-fg-3">{r.quote.symbol}</span>
                              </dd>
                            </div>
                          )}
                          <div className="min-w-0">
                            <dt className="text-fg-3">{v("tokens")}</dt>
                            <dd className="num mt-0.5 text-sm">
                              {n.token(tokens)} <span className="text-xs text-fg-3">{r.symbol}</span>
                            </dd>
                          </div>
                        </dl>
                        {p!.positions.length || BigInt(p!.buyerLedger.tokens) > 0n ? (
                          <details className="group">
                            <summary className={cn(SUMMARY, "w-fit gap-1.5 py-1 text-xs text-fg-2")}>
                              {v("positionsCount", { count: p!.positions.length })}
                              <ChevronDown className={CHEVRON} aria-hidden />
                            </summary>
                            <div className="mt-3 rounded-[12px] border border-fg/[0.07] bg-fg/[0.02] p-4">
                              <PositionRecords raise={r} position={p!} />
                            </div>
                          </details>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
                <div className="surface-1 scroll-thin hidden overflow-x-auto sm:block" data-testid="portfolio-table">
                  <table className="w-full min-w-[52rem] text-sm">
                    <thead className="text-left text-xs text-fg-3">
                      <tr className="border-b border-fg/[0.07]">
                        <th className="px-5 py-3.5 font-normal">{t("raise")}</th>
                        <th className="px-5 py-3.5 font-normal">{t("stage")}</th>
                        <th className="px-5 py-3.5 text-right font-normal">{v("guaranteedClaim")}</th>
                        <th className="px-5 py-3.5 text-right font-normal">{v("tokens")}</th>
                        <th className="px-5 py-3.5 text-right font-normal">{v("quota")}</th>
                        <th className="px-5 py-3.5 text-right font-normal">{v("pendingRewards")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map(({ r, p }) => (
                        <tr
                          key={r.address}
                          className="border-b border-fg/[0.06] align-top transition-colors last:border-0 hover:bg-fg/[0.02]"
                        >
                          <td className="px-5 py-4">
                            <Link href={`/raise/${r.address}`} className="group inline-flex items-center gap-3">
                              <ProjectAvatar symbol={r.symbol} profile={r.profile} size="sm" />
                              <span className="font-medium group-hover:underline">{r.profile.name || r.name}</span>
                              <span className="font-mono text-2xs text-fg-3">{r.symbol}</span>
                            </Link>
                            {p!.positions.length || BigInt(p!.buyerLedger.tokens) > 0n ? (
                              <details className="group mt-2 min-w-60 max-w-sm">
                                <summary className={cn(SUMMARY, "w-fit gap-1.5 py-1 text-xs text-fg-2")}>
                                  {v("positionsCount", { count: p!.positions.length })}
                                  <ChevronDown className={CHEVRON} aria-hidden />
                                </summary>
                                <div className="mt-3 rounded-[12px] border border-fg/[0.07] bg-fg/[0.02] p-4">
                                  <PositionRecords raise={r} position={p!} />
                                </div>
                              </details>
                            ) : null}
                          </td>
                          <td className="whitespace-nowrap px-5 py-4">
                            <StageBadge state={r.phase} form="short" />
                          </td>
                          <td className="num whitespace-nowrap px-5 py-4 text-right">
                            {p!.phase === "Stage3" ? (
                              <span className="text-fg-3">—</span>
                            ) : (
                              <>
                                <span className="text-protected">
                                  {n.quote(p!.positions.reduce((sum, x) => sum + BigInt(x.guaranteedClaim.amount), 0n))}
                                </span>{" "}
                                <span className="text-xs text-fg-3">{r.quote.symbol}</span>
                              </>
                            )}
                          </td>
                          <td className="num whitespace-nowrap px-5 py-4 text-right">
                            {p!.phase === "Stage3" ? (
                              <>
                                {n.token(p!.walletTokenBalance)} <span className="text-xs text-fg-3">{r.symbol}</span>
                              </>
                            ) : (
                              <>
                                {n.token(
                                  p!.positions.reduce((sum, x) => sum + BigInt(x.positionState.tokens), 0n) +
                                    BigInt(p!.buyerLedger.tokens),
                                )}{" "}
                                <span className="text-xs text-fg-3">{r.symbol}</span>
                              </>
                            )}
                          </td>
                          <td className="num whitespace-nowrap px-5 py-4 text-right">
                            {p!.phase === "Stage3" ? (
                              <>
                                {n.token(p!.quota)} <span className="text-xs text-fg-3">{r.symbol}</span>
                              </>
                            ) : (
                              <span className="text-fg-3">—</span>
                            )}
                          </td>
                          <td className="num whitespace-nowrap px-5 py-4 text-right">
                            {p!.phase === "Stage3" ? (
                              <>
                                {n.token(p!.pendingRewards.tokens)}{" "}
                                <span className="text-xs text-fg-3">{r.symbol}</span>
                                <br />
                                {n.quote(p!.pendingRewards.quote)}{" "}
                                <span className="text-xs text-fg-3">{r.quote.symbol}</span>
                              </>
                            ) : (
                              <span className="text-fg-3">—</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            ) : (
              <>
                <TestUsdgFaucet />
                <EmptyState
                  title={v("noPositionsTitle")}
                  detail={v("noPositionsDetail")}
                  action={
                    <Button asChild variant="outline" size="sm">
                      <Link href="/#raises">{t("explore")}</Link>
                    </Button>
                  }
                />
              </>
            )}
          </section>
          <YourLaunches address={address} />
        </>
      )}
    </div>
  );
}

/** Projects this account launched, each one step from its builder console. */
function YourLaunches({ address }: { address: string }) {
  const t = useTranslations("portfolio");
  const tb = useTranslations("builderConsole");
  const { data } = useRaises();
  const mine = (data ?? []).filter((r) => r.builder.toLowerCase() === address.toLowerCase());
  if (!mine.length) return null;
  return (
    <section className="space-y-3" aria-labelledby="your-launches" data-testid="your-launches">
      <h2 id="your-launches" className="t-section pt-4">
        {t("launches")}
      </h2>
      <ul className="surface-1 divide-y divide-fg/[0.06] overflow-hidden">
        {mine.map((r) => (
          <li key={r.address} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-3.5">
            <Link href={`/raise/${r.address}`} className="group flex min-w-0 flex-1 items-center gap-3">
              <ProjectAvatar symbol={r.symbol} profile={r.profile} size="sm" />
              <span className="truncate font-medium group-hover:underline">{r.profile.name || r.name}</span>
              <span className="shrink-0 font-mono text-2xs text-fg-3">{r.symbol}</span>
            </Link>
            <StageBadge state={r.phase} form="short" />
            <Button asChild variant="ghost" size="sm" className="group -mr-2 gap-1">
              <Link href={`/raise/${r.address}/manage`}>
                {tb("title")}
                <ArrowRight className="!size-3.5 transition-transform duration-200 group-hover:translate-x-0.5" />
              </Link>
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}
