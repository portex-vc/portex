"use client";
import { ActionButton } from "@/components/action-button";
import { Mark } from "@/components/brand/logo";
import { ProposalEditor } from "@/components/builder/proposal-editor";
import { SpendEditor } from "@/components/builder/spend-editor";
import { TreasuryPanel } from "./treasury-panel";
import { CardHeading, Fig, Meter, NativeSelect, QuoteTable, type Row } from "@/components/figures";
import type { Position, Proposal, RaiseDetail } from "@/lib/api";
import { governanceAbi, raiseAbi, tokenAbi } from "@/lib/contracts";
import { useNow, usePosition, useProposals, useTx } from "@/lib/hooks";
import { useNumbers } from "@/lib/use-numbers";
import { cn, shortAddress } from "@/lib/utils";
import { useTranslations } from "next-intl";
import { useState } from "react";
import type { Address } from "viem";
import { useAccount, useBlockNumber, useReadContract } from "wagmi";
import { raiseInvalidations } from "./common";

const QUORUM = 40;
const APPROVAL = 60;

export function ProposalsPanel({ detail: r }: { detail: RaiseDetail }) {
  const v = useTranslations("v31"),
    n = useNumbers();
  const { address } = useAccount();
  const { data: p } = usePosition(r.address, address);
  const { data: proposals, isLoading } = useProposals(r.address, true);
  const listed = r.phase === "Stage3";
  const budget = r.governance.config.enabled;
  const capital = useReadContract({
    address: r.address as Address,
    abi: raiseAbi,
    functionName: "eligibleCapital",
    query: { refetchInterval: 10000, enabled: !listed },
  });
  const held =
    p?.positions.filter((x) => x.positionState.class !== "Buyer" && BigInt(x.positionState.tokens) > 0n) ?? [];
  return (
    <div className="space-y-4" data-testid="governance-tab">
      <TreasuryPanel detail={r} />
      <section className="surface-1 space-y-5 p-5">
        <CardHeading eyebrow={v("proposalsEyebrow")} title={v(listed ? "governanceTitleToken" : "governanceTitle")} />
        {listed ? (
          <dl className="grid grid-cols-2 gap-5 sm:grid-cols-3">
            <Fig label={v("capPerSpend")} value={n.pct(r.treasury.spendCapBps)} />
            <Fig label={v("approval")} value={n.pct(APPROVAL * 100)} />
            <Fig
              label={v("votingTimelock")}
              value={`${n.duration(Number(r.governance.config.parameters.voting))} · ${n.duration(Number(r.governance.config.parameters.dispute))}`}
            />
          </dl>
        ) : (
          <dl className="grid grid-cols-2 gap-5 sm:grid-cols-4">
            <Fig
              label={v("eligibleCapital")}
              value={capital.data !== undefined ? n.quote(capital.data as bigint) : "—"}
              unit={r.quote.symbol}
            />
            {budget ? (
              <Fig
                label={v("remainingBudget")}
                value={n.quote(r.governance.state.remainingCeiling)}
                unit={r.quote.symbol}
              />
            ) : (
              <Fig label={v("treasuryQuote")} value={n.quote(r.treasury.availableQuote)} unit={r.quote.symbol} />
            )}
            <Fig label={v("quorumShort")} value={n.pct(QUORUM * 100)} />
            <Fig label={v("approval")} value={n.pct(APPROVAL * 100)} />
          </dl>
        )}
        <ul className="space-y-1.5 border-t border-hairline pt-4 text-xs leading-relaxed text-fg-2">
          {listed ? (
            <>
              <li>{v("capCaptionToken", { pct: n.pct(r.treasury.spendCapBps) })}</li>
              <li>{v("voteNoteToken")}</li>
            </>
          ) : (
            <>
              {budget ? <li>{v("yesCap")}</li> : null}
              {budget ? <li>{v("haircutExplanation")}</li> : null}
              <li>{v("voteNote")}</li>
            </>
          )}
        </ul>
        {budget && r.phase === "Stage2" ? <ProposalEditor detail={r} /> : null}
        {r.phase === "Stage2" || listed ? <SpendEditor detail={r} /> : null}
      </section>

      {budget && held.length && !listed ? (
        <section className="surface-1 space-y-3 p-5">
          <CardHeading eyebrow={v("futureBounds")} />
          <ul className="divide-y divide-hairline">
            {held.map((x) => (
              <Bounds key={x.id} detail={r} id={x.id} label={`#${x.id} · ${v(`class${x.positionState.class}`)}`} />
            ))}
          </ul>
          <p className="text-2xs leading-relaxed text-fg-3">{v("boundsConditions")}</p>
        </section>
      ) : null}

      {isLoading ? (
        <div className="skeleton h-40 rounded-[14px]" />
      ) : proposals?.length ? (
        [...proposals]
          .reverse()
          .map((proposal) => <ProposalCard key={proposal.id} detail={r} proposal={proposal} positions={p} />)
      ) : (
        <section className="surface-1 flex flex-col items-center gap-3 p-8 text-center" data-testid="no-proposals">
          <Mark size={24} className="text-fg-3" />
          <p className="text-sm font-medium">{v("noProposals")}</p>
          <p className="max-w-sm text-xs leading-relaxed text-fg-2">{v("noProposalsDetail")}</p>
        </section>
      )}
    </div>
  );
}

function Bounds({ detail: r, id, label }: { detail: RaiseDetail; id: string; label: string }) {
  const v = useTranslations("v31"),
    n = useNumbers();
  const bounds = useReadContract({
    address: r.address as Address,
    abi: raiseAbi,
    functionName: "futureClaimBounds",
    args: [BigInt(id), 1],
    query: { refetchInterval: 5000 },
  });
  const b = bounds.data as { validity: { available: boolean }; lower: bigint; upper: bigint } | undefined;
  return (
    <li className="flex items-baseline justify-between gap-3 py-2.5" data-testid={`claim-bounds-${id}`}>
      <span className="text-xs text-fg-2">{label}</span>
      <span className="num text-right text-sm">
        {b?.validity.available ? (
          <>
            {n.quote(b.lower)} – {n.quote(b.upper)} <span className="text-xs text-fg-3">{r.quote.symbol}</span>
          </>
        ) : bounds.isLoading ? (
          "…"
        ) : (
          <span className="text-xs text-fg-3">{v("unavailableShort")}</span>
        )}
      </span>
      <span className="sr-only">{v("boundsConditions")}</span>
    </li>
  );
}

const STATUS_TONE: Record<Proposal["state"], string> = {
  Voting: "bg-info/10 text-info",
  AwaitingFinalization: "bg-risk/10 text-risk",
  Dispute: "bg-risk/10 text-risk",
  Executable: "bg-positive/10 text-positive",
  Executed: "bg-surface-3 text-fg",
  Defeated: "bg-negative/10 text-negative",
  Cancelled: "bg-surface-3 text-fg-3",
  Expired: "bg-surface-3 text-fg-3",
  None: "bg-surface-3 text-fg-3",
};

function ProposalCard({
  detail: r,
  proposal: p,
  positions,
}: {
  detail: RaiseDetail;
  proposal: Proposal;
  positions?: Position;
}) {
  const v = useTranslations("v31"),
    n = useNumbers(),
    now = useNow();
  const { address } = useAccount();
  const { send, pending } = useTx();
  const [picked, setPicked] = useState("");
  const token = p.mode === "Token";
  const draw = p.kind === "Draw";
  const eligible =
    positions?.positions.filter((x) => x.positionState.class === "Backer" && BigInt(x.positionState.basis) > 0n) ?? [];
  const selected = eligible.find((x) => x.id === picked) ?? eligible[0];
  const governor = r.modules.governor as Address;
  const vote = useReadContract({
    address: governor,
    abi: governanceAbi,
    functionName: "voteOf",
    args: [BigInt(p.id), BigInt(selected?.id ?? 0)],
    query: { enabled: !token && Boolean(selected), refetchInterval: 5000 },
  });
  const tokenVote = useReadContract({
    address: governor,
    abi: governanceAbi,
    functionName: "tokenVoteOf",
    args: address ? [BigInt(p.id), address] : undefined,
    query: { enabled: token && Boolean(address), refetchInterval: 5000 },
  });
  const power = useReadContract({
    address: governor,
    abi: governanceAbi,
    functionName: "votingPower",
    args: address ? [BigInt(p.id), address] : undefined,
    query: { enabled: token && Boolean(address) && p.state === "Voting", refetchInterval: 10000 },
  });
  // The snapshot measures the end of the proposal's block, so voting opens with the next block.
  const snapshotBlock = useReadContract({
    address: r.token as Address,
    abi: tokenAbi,
    functionName: "snapshotBlock",
    query: { enabled: token && p.state === "Voting", refetchInterval: 10000 },
  });
  const { data: head } = useBlockNumber({ watch: token && p.state === "Voting" });
  const opening =
    token && snapshotBlock.data !== undefined && head !== undefined && head <= (snapshotBlock.data as bigint);
  const tokenValue = useReadContract({
    address: governor,
    abi: governanceAbi,
    functionName: "quoteValue",
    args: [BigInt(p.tokenAmount)],
    query: { enabled: token && BigInt(p.tokenAmount) > 0n, refetchInterval: 15000 },
  });
  const active = useReadContract({
    address: governor,
    abi: governanceAbi,
    functionName: "activeProposalId",
    query: { refetchInterval: 5000 },
  });
  const cast = token
    ? (tokenVote.data as { cast: boolean } | undefined)?.cast
    : (vote.data as { cast: boolean } | undefined)?.cast;
  const weight = (power.data as bigint | undefined) ?? 0n;
  const yes = BigInt(p.yesWeight),
    no = BigInt(p.noWeight),
    snapshot = BigInt(p.capitalSnapshot),
    amount = BigInt(p.amount),
    cap = BigInt(p.cap);
  const spendValue = amount + ((tokenValue.data as bigint | undefined) ?? 0n);
  const ratio = (a: bigint, b: bigint) => (b > 0n ? Number((a * 10000n) / b) / 100 : 0);
  const participation = ratio(yes + no, snapshot);
  const approval = ratio(yes, yes + no);
  const capUse = ratio(token ? spendValue : amount, cap);
  const haircut = ratio(amount, snapshot);
  const action =
    p.state === "AwaitingFinalization"
      ? "finalize"
      : p.state === "Executable"
        ? "execute"
        : p.state === "Expired" && active.data === BigInt(p.id)
          ? "expire"
          : null;
  const usd = (x: bigint | string) => `${n.quote(x)} ${r.quote.symbol}`;
  const tok = (x: bigint | string) => `${n.token(x)} ${r.symbol}`;
  const weightText = (x: bigint | string) => (token ? tok(x) : usd(x));
  const call = (fn: string, args: unknown[], label: string) =>
    send(
      { address: governor, abi: governanceAbi, functionName: fn, args },
      {
        label: v(label),
        preview: [
          [v("proposal"), `#${p.id} · ${v(draw ? "kindDraw" : "kindSpend")}`],
          ...(fn === "vote" && selected ? ([[v("position"), `#${selected.id}`]] as [string, string][]) : []),
          ...(fn === "voteWithTokens" ? ([[v("votingPower"), tok(weight)]] as [string, string][]) : []),
          ...(amount > 0n ? ([[v("amount"), usd(p.amount)]] as [string, string][]) : []),
          ...(BigInt(p.tokenAmount) > 0n ? ([[v("spendTokens"), tok(p.tokenAmount)]] as [string, string][]) : []),
          ...(!draw ? ([[v("recipient"), p.recipient]] as [string, string][]) : []),
          [v(token ? "yesTokens" : "yesWeight"), weightText(p.yesWeight)],
          ...(draw ? ([[v("haircutPreview"), n.pct(haircut * 100), "total"]] as Row[]) : []),
        ],
        invalidate: raiseInvalidations(r.address, address),
      },
    );
  const timing = (end: number) =>
    now < end ? v("endsIn", { date: n.date(end) }) : v("endedAt", { date: n.date(end) });
  return (
    <section id={`proposal-${p.id}`} data-testid={`proposal-${p.id}`} className="surface-1 scroll-mt-24 space-y-5 p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <p className="eyebrow">
            {v("proposal")} #{p.id} · {v(draw ? "kindDraw" : "kindSpend")} · {v(token ? "modeToken" : "modeCapital")}
          </p>
          <p className="num text-2xl font-medium tracking-tight">
            {amount > 0n ? (
              <>
                {n.quote(p.amount)} <span className="text-sm font-normal text-fg-3">{r.quote.symbol}</span>
              </>
            ) : null}
            {amount > 0n && BigInt(p.tokenAmount) > 0n ? <span className="mx-2 text-fg-3">+</span> : null}
            {BigInt(p.tokenAmount) > 0n ? (
              <>
                {n.token(p.tokenAmount)} <span className="text-sm font-normal text-fg-3">{r.symbol}</span>
              </>
            ) : null}
          </p>
          {!draw ? (
            <p className="text-xs text-fg-3">
              {v("recipient")} <span className="font-mono text-fg-2">{shortAddress(p.recipient, 6)}</span>
            </p>
          ) : null}
          <p className="break-all font-mono text-2xs text-fg-3">{p.uri}</p>
        </div>
        <span className={cn("rounded-full px-2 py-0.5 text-2xs font-medium", STATUS_TONE[p.state])}>
          {v(`proposal${p.state}`)}
        </span>
      </div>

      <div className="grid gap-5 sm:grid-cols-2">
        {token ? null : (
          <Meter
            label={v("participation")}
            value={`${n.pct(participation * 100)} / ${n.pct(QUORUM * 100)}`}
            percent={participation}
            threshold={QUORUM}
            tone={participation >= QUORUM ? "positive" : "fg"}
            caption={v("participationCaption", { capital: usd(p.capitalSnapshot) })}
            testId="meter-quorum"
          />
        )}
        <Meter
          label={v("approvalShare")}
          value={`${n.pct(approval * 100)} / ${n.pct(APPROVAL * 100)}`}
          percent={approval}
          threshold={APPROVAL}
          tone={yes + no === 0n ? "fg" : approval >= APPROVAL ? "positive" : "negative"}
          caption={v("approvalCaption", { yes: weightText(p.yesWeight), no: weightText(p.noWeight) })}
          testId="meter-approval"
        />
        <Meter
          label={v(token ? "capacity" : "capUse")}
          value={`${usd(token ? spendValue : amount)} / ${usd(p.cap)}`}
          percent={capUse}
          tone={(token ? spendValue : amount) > cap ? "negative" : "positive"}
          caption={token ? v("capCaptionToken", { pct: n.pct(r.treasury.spendCapBps) }) : v("capCaption")}
          testId="meter-cap"
        />
        {draw ? (
          <div className="space-y-2 rounded-md border border-risk/30 bg-risk/5 p-3" data-testid="haircut-preview">
            <p className="eyebrow text-risk">{v(p.state === "Executed" ? "haircutApplied" : "haircutPreview")}</p>
            <p className="num text-lg font-medium text-risk">−{n.pct(haircut * 100)}</p>
            <p className="text-2xs leading-4 text-fg-2">{v("haircutPreviewCaption")}</p>
          </div>
        ) : null}
      </div>

      <QuoteTable
        rows={[
          [v("votingEnds"), timing(Number(p.votingEnds))],
          [v(token ? "timelockEnds" : "disputeEnds"), timing(Number(p.disputeEnds))],
          [v("executeEnds"), timing(Number(p.executeEnds))],
        ]}
        className="border-t border-hairline pt-3"
      />

      {p.state === "Voting" ? (
        token ? (
          <div className="space-y-3 border-t border-hairline pt-4" data-testid="vote-controls">
            {!address ? (
              <p className="text-xs text-fg-2">{v("connectToVoteTokens")}</p>
            ) : cast ? (
              <p className="text-xs text-positive">{v("alreadyVoted")}</p>
            ) : weight > 0n ? (
              <>
                <p className="flex items-baseline justify-between text-xs">
                  <span className="text-fg-3">{v("votingPower")}</span>
                  <span className="num text-sm text-fg">{tok(weight)}</span>
                </p>
                <div className="grid grid-cols-2 gap-2">
                  {[true, false].map((support) => (
                    <ActionButton
                      key={String(support)}
                      className="w-full"
                      variant={support ? "default" : "outline"}
                      data-testid={support ? "vote-yes" : "vote-no"}
                      label={v(support ? "voteYes" : "voteNo")}
                      pending={pending}
                      onClick={() => call("voteWithTokens", [BigInt(p.id), support], support ? "voteYes" : "voteNo")}
                    />
                  ))}
                </div>
              </>
            ) : (
              <p className="text-xs text-fg-2">
                {power.isLoading ? v("checking") : opening ? v("votingOpensNextBlock") : v("noVotingTokens")}
              </p>
            )}
            <p className="text-2xs leading-relaxed text-fg-3">{v("voteNoteToken")}</p>
          </div>
        ) : eligible.length ? (
          <div className="space-y-3 border-t border-hairline pt-4" data-testid="vote-controls">
            <label className="block space-y-1.5">
              <span className="eyebrow block">{v("votingPosition")}</span>
              <NativeSelect aria-label={v("position")} value={selected?.id} onChange={(e) => setPicked(e.target.value)}>
                {eligible.map((x) => (
                  <option key={x.id} value={x.id}>
                    #{x.id} · {usd(x.positionState.basis)}
                  </option>
                ))}
              </NativeSelect>
            </label>
            {cast ? (
              <p className="text-xs text-positive">{v("alreadyVoted")}</p>
            ) : (
              <div className="grid grid-cols-2 gap-2">
                {[true, false].map((support) => (
                  <ActionButton
                    key={String(support)}
                    className="w-full"
                    variant={support ? "default" : "outline"}
                    data-testid={support ? "vote-yes" : "vote-no"}
                    label={v(support ? "voteYes" : "voteNo")}
                    reason={vote.isPending ? v("checking") : null}
                    pending={pending}
                    onClick={() =>
                      call("vote", [BigInt(p.id), BigInt(selected!.id), support], support ? "voteYes" : "voteNo")
                    }
                  />
                ))}
              </div>
            )}
            <p className="text-2xs leading-relaxed text-fg-3">{v("voteNote")}</p>
          </div>
        ) : (
          <p className="border-t border-hairline pt-4 text-xs text-fg-2">
            {v(address ? "noVotingPosition" : "connectToVote")}
          </p>
        )
      ) : null}

      {action ? (
        <ActionButton
          className="w-full"
          data-testid={action}
          label={v(action === "execute" && !draw ? "executeSpend" : action)}
          pending={pending}
          reason={!address ? v("connect") : null}
          onClick={() => call(action, [BigInt(p.id)], action)}
        />
      ) : null}
      {p.executedTx ? (
        <p className="break-all font-mono text-2xs text-fg-3">
          {v("executedTx")} · {p.executedTx}
        </p>
      ) : null}
    </section>
  );
}
