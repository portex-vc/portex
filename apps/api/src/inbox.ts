/**
 * Per-user inbox derivation (GET /v1/users/:address/inbox). Pure: the server assembles
 * `InboxRaiseInput[]` from indexed state and passes the chain clock as `now`; this module
 * only derives the upcoming/actionable items. No push, no persistence.
 */

export type InboxItemType =
  | 'claimable_tranche'     // a Committed tranche whose claim lag has elapsed (or will)
  | 'commitment_closing'    // commitment window open; the user still has Locked tranches
  | 'vote_open'             // a Rule 2 spend vote is open and the user can still vote
  | 'dispute_exit'          // a spend passed; the user (non-YES) can still exit whole
  | 'graduation_ready'      // all graduation gates are met; anyone can call graduate()
  | 'refund_available';     // the raise Failed; the user's principal is withdrawable 1:1

export interface InboxItem {
  type: InboxItemType;
  severity: 'action' | 'upcoming';
  raise: string;
  raiseName: string;
  symbol: string;
  title: string;
  /** chain-time deadline / availability moment relevant to the item (null = no clock). */
  dueAt: number | null;
  data: Record<string, unknown>;
}

export interface InboxTranche {
  k: number;
  state: 'Locked' | 'Committed' | 'Claimed' | 'Redeemed';
  principal: string;
  /** 0/undefined when unknown (pool not open yet). */
  claimableAt: number;
}

export interface InboxProposal {
  id: number;
  /** raw on-chain status */
  status: 'Active' | 'Passed' | 'Defeated' | 'Executed' | 'Expired';
  votingEndsAt: number | null;
  disputeEndsAt: number | null;
  /** whether THIS user voted at all, and whether they voted YES (withdraw-locked). */
  userVoted: boolean;
  userVotedYes: boolean;
}

export interface InboxRaiseInput {
  address: string;
  name: string;
  symbol: string;
  state: string;
  governor: string | null;
  /** net principal of the user (quote units, decimal string). */
  principal: string;
  commitmentEnd: number | null;
  growthStart: number | null;
  epochLength: number;
  numTranches: number;
  minGraduationLiquidity: string;
  minRealRatioBps: number;
  /** latest indexed pool real ratio (null before the pool opens). */
  realRatioBps: number | null;
  /** latest indexed pool real reserve R (decimal string; null before the pool opens). */
  poolR: string | null;
  tranches: InboxTranche[];
  proposals: InboxProposal[];
}

function item(
  r: InboxRaiseInput, type: InboxItemType, severity: InboxItem['severity'],
  title: string, dueAt: number | null, data: Record<string, unknown> = {},
): InboxItem {
  return { type, severity, raise: r.address, raiseName: r.name, symbol: r.symbol, title, dueAt, data };
}

export function deriveInbox(now: number, raises: InboxRaiseInput[]): InboxItem[] {
  const items: InboxItem[] = [];

  for (const r of raises) {
    const principal = BigInt(r.principal || '0');
    if (principal <= 0n) continue;

    // ---- refunds: a failed raise leaves every backer's principal claimable 1:1 --------
    if (r.state === 'Failed') {
      items.push(item(r, 'refund_available', 'action',
        `${r.name} failed — your principal is withdrawable 1:1, forever`,
        null, { principal: r.principal }));
      continue; // nothing else is actionable on a failed raise
    }

    // ---- tranches: claimable now, or unlocking at a known time ------------------------
    let lockedCount = 0;
    let lockedPrincipal = 0n;
    for (const t of r.tranches) {
      if (t.state === 'Committed' && t.claimableAt > 0) {
        if (t.claimableAt <= now) {
          items.push(item(r, 'claimable_tranche', 'action',
            `Tranche ${t.k} of your ${r.name} position is claimable`, t.claimableAt,
            { k: t.k, principal: t.principal }));
        } else {
          items.push(item(r, 'claimable_tranche', 'upcoming',
            `Tranche ${t.k} of your ${r.name} position becomes claimable`, t.claimableAt,
            { k: t.k, principal: t.principal }));
        }
      } else if (t.state === 'Locked') {
        lockedCount += 1;
        lockedPrincipal += BigInt(t.principal || '0');
      }
    }

    // ---- commitment window closing with uncommitted tranches ---------------------------
    if (r.state === 'Commitment' && r.commitmentEnd && r.commitmentEnd > now && lockedCount > 0) {
      items.push(item(r, 'commitment_closing', 'action',
        `${r.name}'s commitment window closes soon — ${lockedCount} of your tranches are still protected (decide: commit or stay protected)`,
        r.commitmentEnd, { lockedTranches: lockedCount, lockedPrincipal: lockedPrincipal.toString() }));
    }

    // ---- graduation gates met ----------------------------------------------------------
    if (r.state === 'Growth' && r.growthStart) {
      const epochsDone = now >= r.growthStart + r.numTranches * r.epochLength;
      const R = r.poolR !== null ? BigInt(r.poolR) : 0n;
      const liquidityMet = R >= BigInt(r.minGraduationLiquidity || '0');
      const ratioMet = (r.realRatioBps ?? 0) >= r.minRealRatioBps;
      if (epochsDone && liquidityMet && ratioMet) {
        items.push(item(r, 'graduation_ready', 'action',
          `${r.name} has met every graduation gate — anyone can migrate it to the open market`,
          null, { poolR: R.toString(), realRatioBps: r.realRatioBps }));
      }
    }

    // ---- Rule 2: open votes and dispute-window exits -----------------------------------
    if (r.governor) {
      for (const p of r.proposals) {
        if (p.status === 'Active' && p.votingEndsAt !== null && now < p.votingEndsAt && !p.userVoted) {
          items.push(item(r, 'vote_open', 'action',
            `${r.name} milestone proposal #${p.id} is open for voting — your principal is your vote weight`,
            p.votingEndsAt, { proposalId: p.id }));
        }
        if (p.status === 'Passed' && p.disputeEndsAt !== null && now < p.disputeEndsAt && !p.userVotedYes) {
          items.push(item(r, 'dispute_exit', 'action',
            `${r.name} proposal #${p.id} passed — you can still exit with 100% of principal until the dispute window closes`,
            p.disputeEndsAt, { proposalId: p.id }));
        }
      }
    }
  }

  // actions first, each group ordered by the soonest deadline (null last within actions)
  const rank = (i: InboxItem) => (i.severity === 'action' ? 0 : 1);
  items.sort((a, b) => rank(a) - rank(b)
    || (a.dueAt ?? Number.MAX_SAFE_INTEGER) - (b.dueAt ?? Number.MAX_SAFE_INTEGER)
    || a.raise.localeCompare(b.raise));
  return items;
}
