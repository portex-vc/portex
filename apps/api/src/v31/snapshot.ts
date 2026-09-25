/**
 * DB-backed read model of the v2 API. Every response is computed from the indexer's database: materialized view
 * results (`v31_state`, refreshed per touched block), event-derived tables (positions, ERC-20 ledger, votes) and exact
 * JS mirrors of the time-dependent contract math (`mirror.ts`) evaluated at the head's chain time. No RPC.
 *
 * Response shapes are identical to the former per-request RPC implementation (`LiveV31`, kept in live.ts as the
 * differential-test oracle). `blockNumber` is the indexed block the state reflects; `chainTime` the head timestamp.
 */
import { getAddress, keccak256, stringToHex } from 'viem';
import type { DB } from '../db.ts';
import { profileFromRow } from '../lib/profile.ts';
import { positionIds, type RaiseV31Row } from './db.ts';
import { bookPrice, curvePrice, PHASES } from './indexer.ts';
import { typed } from './live.ts';
import * as M from './mirror.ts';
import { allowancesOf, balanceOf, isMaterialized, stateRow, stateRows, ZERO_ADDRESS } from './state-db.ts';

type Struct = Record<string, any>;
const KINDS = ['Draw', 'Spend'];
const MODES = ['Capital', 'Token'];
const STATUSES = ['None', 'Active', 'Passed', 'Defeated', 'Executed', 'Cancelled', 'Expired'];
const BUDGET = keccak256(stringToHex('BUDGET_LAUNCH'));

/** The raise has no materialized state yet (its first refresh is pending); the API answers 503. */
export class StateUnavailable extends Error {
  constructor(readonly raise: string) { super(`state of ${raise} is not materialized yet`); }
}

interface Loaded {
  row: RaiseV31Row;
  data: Struct;
  math: M.RaiseMath;
  /** Storage phase (never ListingPending). */
  storagePhase: number;
  positions: Map<string, Struct>;
  proposals: Map<string, Struct>;
  rewards: Map<string, Struct>;
}

const big = (v: unknown) => BigInt((v ?? 0) as never);
function quote(value: Struct): Struct { return typed(value.validity.available ? value : { validity: value.validity }); }

export class StateV31 {
  private loaded = new Map<string, Loaded>();
  constructor(readonly db: DB, readonly blockNumber: number, readonly now: number) {}

  // ---------------------------------------------------------------------------------------------- state access

  load(row: RaiseV31Row): Loaded {
    const hit = this.loaded.get(row.address.toLowerCase());
    if (hit) return hit;
    const stored = stateRow(this.db, 'raise', row.address);
    if (!stored) throw new StateUnavailable(row.address);
    const data = JSON.parse(stored.data) as Struct;
    const reserve = data.reserve, deadlines = data.deadlines, cfg = data.config, accounting = data.accounting;
    const viewPhase = Number(deadlines.validity.phase);
    const storagePhase = viewPhase === M.PHASE.ListingPending ? M.PHASE.Stage2 : viewPhase;
    const book: M.Book = { E: big(reserve.E), R: big(reserve.R), V: big(reserve.V), T: big(reserve.T), O: big(reserve.O) };
    const builders = new Set([String(data.governanceConfig?.[0] ?? row.builder), ...(cfg.builders ?? [])].map((a) => String(a).toLowerCase()));
    const lastPrice = M.bookPriceOf(book) || this.lastBookPrice(row.address);
    const math: M.RaiseMath = {
      phase: storagePhase, nonce: big(reserve.stateNonce), book, x0: big(reserve.X0), lastT: big(reserve.lastT),
      stage2Start: big(deadlines.stage2Start), stage2End: big(deadlines.stage2End), stage2Length: big(cfg.stage2Length),
      tokenFirst: BigInt(row.token) < BigInt(cfg.quote), migrating: Number(deadlines.validity.reason) === M.REASON.Migrating,
      isBuilder: (owner) => builders.has(owner.toLowerCase()),
      buyerTokens: (owner) => this.buyerLedger(row.address, owner),
      token: getAddress(row.token), vesting: getAddress(data.modules?.vesting ?? row.vesting),
      pEnd: M.curveMarginalPrice(big(cfg.targetPrice), big(cfg.supply) / 5n, big(accounting[0])), lastPrice,
      liquidityReserve: big(accounting[1]), totalBackerTokens: big(accounting[2]), totalBuilderTokens: big(accounting[3]),
      claimLiabilities: big(data.claims?.liability),
    };
    const byKey = (kind: string) => new Map(stateRows(this.db, kind, row.address).map((r) => [r.key.toLowerCase(), JSON.parse(r.data) as Struct]));
    const out: Loaded = { row, data, math, storagePhase, positions: byKey('position'), proposals: byKey('proposal'), rewards: byKey('rewards') };
    this.loaded.set(row.address.toLowerCase(), out);
    return out;
  }
  /** `s.lastPrice` when the stored book has no price: the last positive book price in the indexed history. */
  private lastBookPrice(raise: string): bigint {
    const r = this.db.query("SELECT price FROM v31_prices WHERE raiseAddr=? AND kind='book' AND price IS NOT NULL AND price!='0' ORDER BY blockNumber DESC, logIndex DESC LIMIT 1").get(raise) as { price: string } | null;
    return big(r?.price);
  }
  private buyerLedger(raise: string, owner: string): bigint {
    const r = this.db.query('SELECT tokens FROM v31_positions WHERE raiseAddr=? AND owner=? AND class=1').get(raise, owner) as { tokens: string } | null;
    return big(r?.tokens);
  }
  private classTokens(raise: string, owner: string, classes: number[]): bigint {
    const rows = this.db.query(`SELECT tokens FROM v31_positions WHERE raiseAddr=? AND owner=? AND class IN (${classes.join(',')})`).all(raise, owner) as { tokens: string }[];
    return rows.reduce((sum, r) => sum + big(r.tokens), 0n);
  }
  effectiveIndex(s: Loaded): number { return M.effectivePhaseIndex(s.storagePhase, s.math.stage2End, this.now); }
  phaseOf(row: RaiseV31Row): string { return PHASES[this.effectiveIndex(this.load(row))]; }
  /** A stored view result with its time-dependent phase fields moved to the current effective phase. */
  private patched<T extends Struct | null>(s: Loaded, value: T): T {
    if (!value) return value;
    const out = structuredClone(value) as Struct;
    const eff = this.effectiveIndex(s);
    if (out.validity) {
      const was = Number(out.validity.phase);
      out.validity.phase = eff;
      if ('phase' in out && Number(out.phase) === was) out.phase = eff;
    }
    return out as T;
  }
  private positionMath(p: Struct): M.PositionMath {
    return { owner: String(p.owner ?? ZERO_ADDRESS), class: Number(p.class ?? 0), tokens: big(p.tokens), basis: big(p.basis) };
  }

  // ---------------------------------------------------------------------------------------------- ERC-20 ledger

  /** ProjectTokenV31.balanceOf: stored ERC-20 balance plus the undelivered listing credit (backer + buyer ledger). */
  tokenBalance(row: RaiseV31Row, holder: string): bigint {
    const raw = balanceOf(this.db, row.token, holder);
    const s = this.load(row);
    if (s.storagePhase !== M.PHASE.Stage3 || holder.toLowerCase() === row.address.toLowerCase() || isMaterialized(this.db, row.address, holder)) return raw;
    return raw + this.classTokens(row.address, holder, [M.CLASS.Backer, M.CLASS.Buyer]);
  }
  /** Effective project-token balance at the end of `block` (the Stage 3 vote snapshot). */
  tokenBalanceAt(row: RaiseV31Row, holder: string, block: number): bigint {
    const h = holder.toLowerCase();
    const rows = this.db.query(`SELECT args FROM v31_events WHERE raiseAddr=? AND contract='token' AND name='Transfer' AND blockNumber<=?
      AND (lower(json_extract(args,'$.from'))=? OR lower(json_extract(args,'$.to'))=?)`).all(row.address, block, h, h) as { args: string }[];
    let raw = 0n;
    let delivered = false;
    for (const r of rows) {
      const a = JSON.parse(r.args);
      if (String(a.to).toLowerCase() === h) raw += big(a.value);
      if (String(a.from).toLowerCase() === h) raw -= big(a.value);
      if (String(a.from).toLowerCase() === row.address.toLowerCase() && String(a.to).toLowerCase() === h) delivered = true;
    }
    const listing = this.db.query("SELECT blockNumber FROM v31_events WHERE raiseAddr=? AND name='ListingFinalized' LIMIT 1").get(row.address) as { blockNumber: number } | null;
    if (!listing || listing.blockNumber > block || delivered) return raw;
    return raw + this.classTokens(row.address, holder, [M.CLASS.Backer, M.CLASS.Buyer]);
  }
  quoteBalance(quoteToken: string, holder: string): bigint {
    const b = balanceOf(this.db, quoteToken, holder);
    return b < 0n ? 0n : b;
  }
  /** ProjectTokenV31.quotaOf: the listing quota, reduced by the token's QuotaDestroyed events. */
  quotaOf(row: RaiseV31Row, holder: string): bigint {
    if (this.load(row).storagePhase !== M.PHASE.Stage3) return 0n;
    const rows = this.db.query("SELECT args FROM v31_events WHERE raiseAddr=? AND contract='token' AND name='QuotaDestroyed' AND lower(json_extract(args,'$.owner'))=? ORDER BY blockNumber DESC, logIndex DESC LIMIT 1")
      .all(row.address, holder.toLowerCase()) as { args: string }[];
    return rows.length ? big(JSON.parse(rows[0].args).remainingQuota) : this.classTokens(row.address, holder, [M.CLASS.Backer]);
  }
  private vestingClaimed(row: RaiseV31Row, owner: string): bigint {
    const rows = this.db.query("SELECT args FROM v31_events WHERE raiseAddr=? AND contract='vesting' AND name='VestedClaimed' AND lower(json_extract(args,'$.owner'))=?")
      .all(row.address, owner.toLowerCase()) as { args: string }[];
    return rows.reduce((sum, r) => sum + big(JSON.parse(r.args).amount), 0n);
  }

  // ---------------------------------------------------------------------------------------------- raises

  summary(row: RaiseV31Row): Struct {
    const s = this.load(row);
    const { data } = s;
    const deadlines = data.deadlines, reserve = data.reserve, config = data.config, accounting = data.accounting;
    const phase = PHASES[this.effectiveIndex(s)];
    const projected: Struct = { E: reserve.E, R: reserve.R, V: reserve.V, T: reserve.T, O: reserve.O };
    if (phase === 'Stage2' || phase === 'ListingPending') {
      try {
        const d = M.decay(s.math.book, s.math.x0, s.math.lastT, M.stage2Time(s.math.stage2Start, s.math.stage2End, s.math.stage2Length, this.now));
        Object.assign(projected, { V: d.book.V, T: d.book.T });
      } catch { /* The view would revert; show the stored book. */ }
    }
    const stored = this.db.query('SELECT profile FROM v31_profiles WHERE raiseAddr=?').get(row.address) as { profile: string } | null;
    const profile = profileFromRow(stored?.profile, '', '');
    const risk = this.db.query('SELECT riskScoreBps FROM v31_reports WHERE raiseAddr=? ORDER BY id DESC LIMIT 1').get(row.address) as { riskScoreBps: number } | null;
    const owners = new Set<string>();
    for (const p of positionIds(this.db, row.address).filter((p) => p.class === 0 && BigInt(p.tokens) > 0n)) {
      const st = s.positions.get(p.id)?.positionState;
      if (st && big(st.tokens) > 0n && (phase === 'Stage3' || big(st.basis) > 0n)) owners.add(String(st.owner).toLowerCase());
    }
    const d = Object.fromEntries(Object.entries(deadlines).filter(([k]) => k !== 'validity').map(([k, v]) => [k, Number(v)]));
    const rowState = JSON.parse(row.state);
    return {
      address: row.address, name: row.name, symbol: row.symbol, token: row.token, builder: row.builder,
      template: row.templateId.toLowerCase() === BUDGET ? 'BUDGET_LAUNCH' : 'ESCROW_LAUNCH',
      templateId: row.templateId, templateVersion: String(row.version), phase, deadlines: d,
      E: String(projected.E), R: String(projected.R), V: String(projected.V), T: String(projected.T), O: String(projected.O),
      bookPrice: ['Stage2', 'ListingPending'].includes(phase) ? bookPrice(projected) : phase === 'Stage3' ? rowState.listingPrice ?? null : null,
      curvePrice: curvePrice(config, big(accounting[0])).toString(), targetPrice: String(config.targetPrice),
      sold: String(accounting[0]), allocation: String(big(config.supply) / 5n), backers: owners.size,
      quote: { address: config.quote, symbol: 'USDG', decimals: 6 }, metadata: profile, profile,
      description: profile.description, createdAt: row.createdAt, riskScoreBps: risk?.riskScoreBps ?? null,
      vetoActive: phase === 'Stage1' && Number(deadlines.vetoUntil) > this.now,
      dissolvedAt: phase === 'Dissolved' ? rowState.dissolvedAt ?? null : null,
      dissolvedBy: phase === 'Dissolved' ? rowState.dissolvedBy ?? 'deadline' : null,
      stateNonce: String(reserve.stateNonce), blockNumber: this.blockNumber, chainTime: this.now,
      // Role detection (attester, council) without a detail fetch; the detail replaces it with every module.
      modules: { attester: data.modules?.attester ?? null, council: data.modules?.council ?? null },
    };
  }

  detail(row: RaiseV31Row): Struct {
    const s = this.load(row);
    const summary = this.summary(row);
    const { data } = s;
    const fees = data.fees ?? [0, 0, 0], govCfg = data.governanceConfig, govState = data.governanceState;
    const pending = summary.phase === 'ListingPending';
    const token = data.token ?? {};
    const streams = token.rewardState ?? [null, null];
    return {
      ...summary, config: typed(data.config), modules: typed(data.modules), reserveState: typed(this.patched(s, data.reserve)),
      feeAccruals: typed({ reserveRetained: fees[0], rewards: fees[1], treasury: fees[2] }),
      governance: typed({ config: { builder: govCfg[0], parameters: govCfg[1], enabled: govCfg[2] }, state: { end: govState[0], escrow: govState[1], remainingCeiling: govState[2],
        lastProposalAt: data.governor?.lastProposalAt ?? 0, activeProposalId: data.governor?.activeProposalId ?? 0, eligibleCapital: data.eligibleCapital ?? 0,
        tokenSnapshotBlock: Number(token.snapshotBlock ?? 0) } }),
      listingPreview: pending ? quote(M.listingPreview(s.math, this.now) as never) : null,
      listingStatus: pending ? positionIds(this.db, row.address).filter((p) => s.positions.has(p.id)).map((p) => ({ id: p.id, ...typed(this.patched(s, s.positions.get(p.id)?.listingStatus ?? null)) })) : null,
      listingRecord: summary.phase === 'Stage3' ? typed(data.listingRecord) : null,
      tokenStream: typed({ tokens: streams[0], quote: streams[1], totalQuota: token.totalQuota, rewardNonce: token.rewardNonce }),
      treasury: this.treasury(row),
    };
  }

  /** Governed treasury: balances from the ERC-20 ledger, the unlock line in JS, constants from the refresh. */
  treasury(row: RaiseV31Row): Struct {
    const { data } = this.load(row);
    const address = String(data.config.treasury);
    const t = data.treasury ?? {};
    const allocation = big(t.allocation);
    const locked = M.lockedTokensAt(allocation, big(data.token?.listedAt), big(t.vestingDuration), this.now);
    const tokenBalance = this.tokenBalance(row, address);
    const quoteBalance = this.quoteBalance(String(data.config.quote), address);
    return typed({ address, allocation, lockedTokens: locked, spendableTokens: tokenBalance > locked ? tokenBalance - locked : 0n, tokenBalance, quoteBalance,
      availableQuote: quoteBalance + big(data.fees?.[2]), vestingDuration: t.vestingDuration, spentQuote: t.spentQuote, spentTokens: t.spentTokens,
      spendCapBps: Number(data.governor?.spendCapBps ?? 0), disposedQuote: data.token?.disposedQuote ?? 0 });
  }

  positions(row: RaiseV31Row, user: string): Struct {
    const u = getAddress(user);
    const s = this.load(row);
    const { data, math } = s;
    const phase = PHASES[this.effectiveIndex(s)];
    const listed = s.storagePhase === M.PHASE.Stage3;
    const nonce = math.nonce;
    const buyerTokens = listed ? 0n : this.buyerLedger(row.address, u);
    const backerTokens = this.classTokens(row.address, u, [M.CLASS.Backer]);
    const delivery = listed ? [backerTokens + this.buyerLedger(row.address, u), backerTokens] : [0n, 0n];
    // pendingRewards is re-read for every quota holder at each refresh and daily release; others have none.
    const storedRewards = listed ? s.rewards.get(u.toLowerCase()) as unknown as string[] | undefined : undefined;
    const pendingRewards = storedRewards ? [big(storedRewards[0]), big(storedRewards[1])] : [0n, 0n];
    const grant = listed ? this.classTokens(row.address, u, [M.CLASS.BuilderPurchase]) : 0n;
    const vested = M.vestedAt(grant, big(data.token?.listedAt), this.now);
    const claimed = this.vestingClaimed(row, u);
    const budget = Boolean(data.governanceConfig?.[2]);
    // A position indexed moments ago appears once its batched refresh lands (the same poll), never half-built.
    const positions = positionIds(this.db, row.address, u).filter(({ id }) => s.positions.has(id)).map(({ id }) => {
      const stored = s.positions.get(id) ?? {};
      const p = stored.positionState;
      const pm = this.positionMath(p ?? {});
      const redeem = M.exitQuote(math, pm, pm.tokens, false, nonce, this.now);
      const protectedQuote = phase === 'Stage2' ? M.exitQuote(math, pm, pm.tokens, true, nonce, this.now) : null;
      return { id, positionState: typed(this.patched(s, p)), guaranteedClaim: typed(this.patched(s, stored.guaranteedClaim)), redeemQuote: quote(redeem as never),
        protectedExitQuote: protectedQuote ? quote(protectedQuote as never) : null, listingStatus: typed(this.patched(s, stored.listingStatus)),
        atRiskBasis: String(stored.atRiskBasis ?? 0),
        // Budget launches only, while Stage 1/2 governance can still draw: futureClaimBounds(id, Stage2).
        futureClaimBounds: budget && (phase === 'Stage1' || phase === 'Stage2') && stored.bounds ? typed(this.patched(s, stored.bounds)) : null };
    });
    return {
      user: u, raise: row.address, phase, stateNonce: String(nonce), blockNumber: this.blockNumber, chainTime: this.now, positions,
      buyerLedger: { tokens: String(buyerTokens), marketExitQuote: quote(M.tradeQuote(math, u, buyerTokens, false, this.now) as never) },
      delivery: typed({ tokens: delivery[0], originalQuota: delivery[1], frozenRecord: true }), quota: String(this.quotaOf(row, u)),
      pendingRewards: typed({ tokens: pendingRewards[0], quote: pendingRewards[1] }), walletTokenBalance: String(this.tokenBalance(row, u)),
      walletQuoteBalance: String(this.quoteBalance(String(data.config.quote), u)),
      vesting: typed({ grant, vested, claimed, claimable: vested - claimed }),
    };
  }

  /**
   * Everything a user could roll into another project in one transaction: live Stage 1/Stage 2 positions (exit at
   * cost, or with protected profit in Stage 2) and funded dissolution claims.
   */
  rolloverSources(rows: RaiseV31Row[], user: string): Struct[] {
    const u = getAddress(user);
    const out: Struct[] = [];
    for (const row of rows) {
      const owned = positionIds(this.db, row.address, u).filter((p) => p.class !== 1);
      if (!owned.length) continue;
      let s: Loaded;
      try { s = this.load(row); } catch (e) { if (e instanceof StateUnavailable) continue; throw e; }
      const phase = PHASES[this.effectiveIndex(s)];
      if (phase === 'Stage3') continue;
      const positions = [];
      for (const { id } of owned) {
        const stored = s.positions.get(id) ?? {};
        const state = stored.positionState ?? {};
        if (phase === 'Dissolved') {
          const claimable = big(stored.claimable);
          if (claimable > 0n) positions.push({ id, kind: 'DissolutionClaim', amount: String(claimable), tokens: '0', minPayout: '0' });
          continue;
        }
        const pm = this.positionMath(state);
        if (pm.tokens === 0n) continue;
        const cost = M.exitQuote(s.math, pm, pm.tokens, false, s.math.nonce, this.now);
        if (!cost.validity.available) continue;
        const item: Struct = { id, kind: 'CostExit', amount: String(cost.result.payout), tokens: String(pm.tokens), minPayout: String(cost.result.payout), cost: String(cost.result.cost) };
        if (phase === 'Stage2' && pm.class === 0) {
          const withProfit = M.exitQuote(s.math, pm, pm.tokens, true, s.math.nonce, this.now);
          if (withProfit.validity.available && withProfit.result.payout > cost.result.payout) {
            Object.assign(item, { kind: 'ProtectedExit', amount: String(withProfit.result.payout), minPayout: String(withProfit.result.payout), profit: String(withProfit.result.profit) });
          }
        }
        positions.push(item);
      }
      if (positions.length) out.push({ raise: row.address, name: row.name, symbol: row.symbol, phase, stateNonce: String(s.math.nonce), positions });
    }
    return out;
  }

  // ---------------------------------------------------------------------------------------------- governance

  proposals(row: RaiseV31Row): Struct[] {
    const s = this.load(row);
    const eff = this.effectiveIndex(s);
    const ids = [...s.proposals.keys()].sort((a, b) => Number(a) - Number(b));
    const ref = s.data.governor?.referencePrice;
    return ids.map((id) => {
      const stored = s.proposals.get(id)!;
      const p = stored.proposal;
      if (!p) throw new StateUnavailable(row.address);
      let status = STATUSES[Number(p.status)];
      // GovernanceV31.getProposal: Active/Passed read as Expired past the execution window, or (capital votes)
      // once the raise is no longer in Stage 2.
      if ((status === 'Active' || status === 'Passed') && (this.now >= Number(p.executeEnds) || (Number(p.mode) === 0 && eff !== M.PHASE.Stage2))) status = 'Expired';
      const state = status === 'Active' ? (this.now < Number(p.votingEnds) ? 'Voting' : 'AwaitingFinalization') : status === 'Passed' ? (this.now < Number(p.disputeEnds) ? 'Dispute' : 'Executable') : status;
      const indexed = this.db.query('SELECT data FROM v31_proposals WHERE raiseAddr=? AND id=?').get(row.address, id) as { data: string } | null;
      const mode = MODES[Number(p.mode)];
      const cap = mode === 'Token' ? big(stored.spendCapacity) : big(p.yesWeight) / 10n;
      const extra: Struct = {};
      if (mode === 'Token') {
        const opened = this.db.query("SELECT blockNumber FROM v31_events WHERE raiseAddr=? AND contract='governor' AND name='Proposed' AND json_extract(args,'$.proposal')=?").get(row.address, id) as { blockNumber: number } | null;
        extra.snapshotBlock = opened?.blockNumber ?? null;
        extra.tokenValue = ref ? M.quoteValueAt(big(p.tokenAmount), big(ref[0]), Boolean(ref[1])).toString() : '0';
      }
      return { id, ...typed(p), kind: KINDS[Number(p.kind)], mode, status, state,
        quorumBps: mode === 'Token' ? 0 : 4000, approvalBps: 6000, cap: String(cap),
        executedTx: indexed ? JSON.parse(indexed.data).executedTx ?? null : null, ...extra };
    });
  }

  /** GovernanceV31.voteOf from VoteChanged events (a cancellation keeps weight and side). */
  voteOf(row: RaiseV31Row, proposal: string, position: string): Struct {
    const r = this.db.query(`SELECT args FROM v31_events WHERE raiseAddr=? AND contract='governor' AND name='VoteChanged'
      AND json_extract(args,'$.proposal')=? AND json_extract(args,'$.position')=? ORDER BY blockNumber DESC, logIndex DESC LIMIT 1`).get(row.address, proposal, position) as { args: string } | null;
    if (!r) return { weight: '0', support: false, cast: false, cancelled: false };
    const a = JSON.parse(r.args);
    return { weight: String(a.weight), support: Boolean(a.support), cast: true, cancelled: Boolean(a.cancelled) };
  }
  /** GovernanceV31.tokenVoteOf from TokenVoteCast events. */
  tokenVoteOf(row: RaiseV31Row, proposal: string, voter: string): Struct {
    const r = this.db.query(`SELECT args FROM v31_events WHERE raiseAddr=? AND contract='governor' AND name='TokenVoteCast'
      AND json_extract(args,'$.proposal')=? AND lower(json_extract(args,'$.voter'))=? LIMIT 1`).get(row.address, proposal, voter.toLowerCase()) as { args: string } | null;
    if (!r) return { weight: '0', support: false, cast: false, cancelled: false };
    const a = JSON.parse(r.args);
    return { weight: String(a.weight), support: Boolean(a.support), cast: true, cancelled: false };
  }
  /** GovernanceV31.canVoteWithTokens: builders and protocol custody never vote. */
  canVoteWithTokens(row: RaiseV31Row, voter: string): boolean {
    const { data } = this.load(row);
    const v = voter.toLowerCase();
    const m = data.modules ?? {};
    const blocked = [ZERO_ADDRESS, data.governanceConfig?.[0], row.address, data.config?.treasury, m.token, m.vesting, m.claims, m.adapter, ...(data.config?.builders ?? [])];
    return !blocked.some((a) => a && String(a).toLowerCase() === v);
  }
  /** GovernanceV31.votingPower: the voter's effective token balance at the end of the proposal's snapshot block. */
  votingPower(row: RaiseV31Row, proposal: Struct, voter: string): bigint {
    if (proposal.mode !== 'Token' || proposal.status === 'None' || !this.canVoteWithTokens(row, voter)) return 0n;
    const block = proposal.snapshotBlock as number | null;
    if (block === null || this.blockNumber <= block) return 0n;
    return this.tokenBalanceAt(row, voter, block);
  }
  /** Per-user vote state for every proposal: Stage 2 position votes, Stage 3 token votes and voting power. */
  votesOf(row: RaiseV31Row, user: string): Struct[] {
    const u = getAddress(user);
    const owned = positionIds(this.db, row.address, u).filter((p) => p.class === 0);
    return this.proposals(row).map((p) => p.mode === 'Token'
      ? { proposal: p.id, mode: p.mode, tokenVote: this.tokenVoteOf(row, p.id, u), votingPower: String(this.votingPower(row, p, u)), canVote: this.canVoteWithTokens(row, u) }
      : { proposal: p.id, mode: p.mode, positions: Object.fromEntries(owned.map((x) => [x.id, this.voteOf(row, p.id, x.id)])) });
  }

  // ---------------------------------------------------------------------------------------------- users

  inbox(rows: RaiseV31Row[], user: string): Struct {
    const u = getAddress(user);
    const items: Struct[] = [];
    for (const row of rows) {
      let p: Struct, s: Struct;
      try { p = this.positions(row, u); s = this.summary(row); } catch (e) { if (e instanceof StateUnavailable) continue; throw e; }
      const add = (type: string, title: string, dueAt: number | null, data: unknown = {}, severity = 'action') => items.push({ type, severity, raise: row.address, raiseName: row.name, symbol: row.symbol, title, dueAt, data });
      const basis = p.positions.reduce((sum: bigint, x: any) => sum + BigInt(x.guaranteedClaim.amount), 0n);
      const held = basis > 0n || BigInt(p.buyerLedger.tokens) > 0n || BigInt(p.walletTokenBalance) > 0n || BigInt(p.vesting.grant) > 0n;
      if (!held) continue;
      if (p.phase === 'Dissolved' && basis > 0n) add('dissolution_claim', 'The project dissolved; claim your capital or roll it into another project', null, { amount: String(basis) });
      if (p.phase === 'ListingPending') add('listing_ready', 'Listing is ready; cost exits and buyer sells remain open until it succeeds', s.deadlines.stage2End);
      if (p.phase === 'Stage2') add('listing_scheduled', 'Mandatory listing ends basis protection', s.deadlines.stage2End, {}, 'upcoming');
      if (p.phase === 'Stage1' && this.now >= s.deadlines.stage1End && !s.vetoActive) add('stage1_ready', 'Stage 1 is ready to resolve its gates', s.deadlines.stage1End);
      if (BigInt(p.pendingRewards.tokens) + BigInt(p.pendingRewards.quote) > 0n) add('rewards_available', 'Diamond Hand rewards are ready to claim', null, p.pendingRewards);
      if (BigInt(p.vesting.claimable) > 0n) add('vesting_available', 'Builder purchase tokens are vested', null, p.vesting);
      for (const proposal of this.proposals(row)) {
        if (proposal.state === 'Voting' && proposal.mode === 'Token') {
          const power = this.votingPower(row, proposal, u);
          const vote = this.tokenVoteOf(row, proposal.id, u);
          if (power > 0n && !vote.cast) add('vote_open', `Treasury proposal #${proposal.id} is open for your tokens`, Number(proposal.votingEnds), { proposalId: proposal.id });
        } else if (proposal.state === 'Voting') {
          for (const position of p.positions.filter((x: any) => x.positionState.class === 'Backer' && BigInt(x.positionState.basis) > 0n)) {
            if (!this.voteOf(row, proposal.id, position.id).cast) add('vote_open', `Proposal #${proposal.id} is open for position #${position.id}`, Number(proposal.votingEnds), { proposalId: proposal.id, positionId: position.id });
          }
        }
        if (proposal.state === 'Dispute' && proposal.mode === 'Capital' && basis > 0n) add('dispute_exit', `Proposal #${proposal.id} passed; cost exits remain available`, Number(proposal.disputeEnds), { proposalId: proposal.id });
      }
    }
    items.sort((a, b) => (a.severity === 'action' ? 0 : 1) - (b.severity === 'action' ? 0 : 1) || (a.dueAt ?? Infinity) - (b.dueAt ?? Infinity));
    return { user: u, now: this.now, items };
  }

  /** Quote-token and project-token balances and allowances from the ERC-20 ledger. */
  wallet(rows: RaiseV31Row[], user: string, quoteToken: string): Struct {
    const u = getAddress(user);
    const tokens: Struct[] = [];
    for (const row of rows) {
      let balance: bigint;
      try { balance = this.tokenBalance(row, u); } catch (e) { if (e instanceof StateUnavailable) continue; throw e; }
      const allowances = allowancesOf(this.db, row.token, u);
      if (balance === 0n && !Object.keys(allowances).length) continue;
      tokens.push({ raise: row.address, token: row.token, symbol: row.symbol, decimals: 18, balance: String(balance), allowances });
    }
    return { user: u, blockNumber: this.blockNumber, chainTime: this.now,
      quote: { address: getAddress(quoteToken), symbol: 'USDG', decimals: 6, balance: String(this.quoteBalance(quoteToken, u)), allowances: allowancesOf(this.db, quoteToken, u) },
      tokens };
  }

  // ---------------------------------------------------------------------------------------------- quotes

  /**
   * Stage 1/2 quotes shaped like the on-chain views: `deposit` (Curve purchase), `buy` (marketBuyQuote[For]),
   * `sell` of the buyer ledger (marketExitQuote), and a position exit (redeemQuote at the current nonce, or
   * protectedExitQuote with `exit=protected`).
   */
  raiseQuote(row: RaiseV31Row, q: { side: string; amount: bigint; position?: string; owner?: string; exit?: string }): Struct {
    const s = this.load(row);
    const base = { raise: row.address, stateNonce: String(s.math.nonce), blockNumber: this.blockNumber, chainTime: this.now };
    if (q.side === 'deposit') {
      const cfg = s.data.config;
      const allocation = big(cfg.supply) / 5n, sold = big(s.data.accounting[0]);
      const open = this.effectiveIndex(s) === M.PHASE.Stage1 && this.now < Number(s.data.deadlines.stage1End);
      const reason = !open ? M.REASON.PhaseClosed : q.amount === 0n || q.amount > M.MAX_QUOTE / 4n ? M.REASON.InvalidQuantity : M.REASON.None;
      const buy = reason === M.REASON.None ? M.curvePurchase(big(cfg.targetPrice), allocation, sold, q.amount) : { quantity: 0n, debit: 0n };
      const validity = M.validityOf(s.math, reason === M.REASON.None && buy.quantity === 0n ? M.REASON.InvalidQuantity : reason, this.now);
      return { ...base, kind: 'deposit', ...typed({ validity, amount: q.amount, tokens: buy.quantity, debit: buy.debit, change: q.amount - buy.debit,
        priceAfter: M.curveMarginalPrice(big(cfg.targetPrice), allocation, sold + buy.quantity) }), amountOut: String(buy.quantity) };
    }
    if (q.side === 'buy') {
      const r = M.tradeQuote(s.math, q.owner ?? null, q.amount, true, this.now);
      return { ...base, kind: 'buy', ...quote(r as never), amountOut: r.validity.available ? String(r.tokens) : '0' };
    }
    if (q.position !== undefined) {
      const stored = s.positions.get(q.position);
      const pm = this.positionMath(stored?.positionState ?? {});
      const isProtected = q.exit === 'protected';
      const r = M.exitQuote(s.math, pm, q.amount, isProtected, s.math.nonce, this.now);
      return { ...base, kind: isProtected ? 'protectedExit' : 'costExit', position: q.position, owner: pm.owner, ...quote(r as never),
        amountOut: r.validity.available ? String(r.result.payout) : '0' };
    }
    const r = M.tradeQuote(s.math, q.owner ?? ZERO_ADDRESS, q.amount, false, this.now);
    return { ...base, kind: 'sell', ...quote(r as never), amountOut: r.validity.available ? String(r.net) : '0' };
  }
}

