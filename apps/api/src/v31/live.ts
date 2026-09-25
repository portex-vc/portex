import { getAddress, keccak256, stringToHex, type Abi, type Address, type PublicClient } from 'viem';
import * as A from '../generated/v31-abis.ts';
import type { DB } from '../db.ts';
import { profileFromRow } from '../lib/profile.ts';
import { getRaiseV31, positionIds, type RaiseV31Row } from './db.ts';
import { bookPrice, curvePrice, PHASES, SCALE } from './indexer.ts';

type Struct = Record<string, any>;
const REASONS = ['None', 'PhaseClosed', 'InvalidPosition', 'InvalidQuantity', 'StaleNonce', 'EmptyBook', 'Insolvent', 'PriceInvalid', 'VenueUnavailable', 'Migrating', 'Unauthorized'];
const KINDS = ['Draw', 'Spend'];
const MODES = ['Capital', 'Token'];
const CLASSES = ['Backer', 'Buyer', 'BuilderPurchase'];
const STATUSES = ['None', 'Active', 'Passed', 'Defeated', 'Executed', 'Cancelled', 'Expired'];
export function typed(value: any, key = ''): any {
  if (key === 'phase') return PHASES[Number(value)];
  if (key === 'reason') return REASONS[Number(value)];
  if (key === 'class') return CLASSES[Number(value)];
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map((v) => typed(v));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, typed(v, k)]));
  return value;
}
function quote(value: Struct): Struct { return typed(value.validity.available ? value : { validity: value.validity }); }
export function effectivePhase(phase: number, deadlines: Struct, now: number): string {
  if ((phase === 1 || phase === 2) && Number(deadlines.stage2End) > 0 && now >= Number(deadlines.stage2End)) return 'ListingPending';
  return PHASES[phase];
}

/**
 * The former per-request RPC read model. No API route uses it any more (see snapshot.ts); the tests keep it as the
 * differential oracle that the DB-backed responses must equal. Every read uses one block, so quotes never mix blocks.
 */
export class LiveV31 {
  constructor(readonly client: PublicClient, readonly db: DB, readonly blockNumber: bigint, readonly now: number) {}
  static async atHead(client: PublicClient, db: DB): Promise<LiveV31> {
    const b = await client.getBlock({ blockTag: 'latest' });
    return new LiveV31(client, db, b.number, Number(b.timestamp));
  }
  read<T = any>(address: string, abi: Abi, functionName: string, args: readonly unknown[] = []): Promise<T> {
    return this.client.readContract({ address: address as Address, abi, functionName, args, blockNumber: this.blockNumber } as never) as Promise<T>;
  }
  raise<T = any>(row: RaiseV31Row, functionName: string, args: readonly unknown[] = []): Promise<T> {
    return this.read(row.address, A.RaiseCoreAbi, functionName, args);
  }
  async summary(row: RaiseV31Row): Promise<Struct> {
    const [deadlines, reserve, accounting, config] = await Promise.all([
      this.raise(row, 'stageDeadlines'), this.raise(row, 'reserveState'), this.raise(row, 'accounting'), this.raise(row, 'getConfig'),
    ]);
    const phase = effectivePhase(Number(deadlines.validity.phase), deadlines, this.now);
    const projected = { ...reserve };
    if (phase === 'Stage2' || phase === 'ListingPending') {
      const elapsed = BigInt(Math.max(0, this.now - Number(deadlines.stage2Start)));
      const duration = BigInt(deadlines.stage2End) - BigInt(deadlines.stage2Start);
      const t = elapsed >= duration ? SCALE : elapsed * SCALE / duration;
      const delta = BigInt(reserve.V) - BigInt(reserve.E) - BigInt(reserve.X0) * (SCALE - t) / SCALE;
      if (delta > 0n) { projected.T -= delta * BigInt(reserve.T) / (BigInt(reserve.R) + BigInt(reserve.V)); projected.V -= delta; }
    }
    const stored = this.db.query('SELECT profile FROM v31_profiles WHERE raiseAddr=?').get(row.address) as { profile: string } | null;
    const profile = profileFromRow(stored?.profile, '', '');
    const risk = this.db.query('SELECT riskScoreBps FROM v31_reports WHERE raiseAddr=? ORDER BY id DESC LIMIT 1').get(row.address) as { riskScoreBps: number } | null;
    const ids = positionIds(this.db, row.address).filter((p) => p.class === 0 && BigInt(p.tokens) > 0n);
    const states = await Promise.all(ids.map((p) => this.raise(row, 'positionState', [BigInt(p.id)])));
    const backers = new Set(states.filter((p) => p.tokens > 0n && (phase === 'Stage3' || p.basis > 0n)).map((p) => p.owner.toLowerCase())).size;
    const d = Object.fromEntries(Object.entries(deadlines).filter(([k]) => k !== 'validity').map(([k, v]) => [k, Number(v)]));
    return {
      address: row.address, name: row.name, symbol: row.symbol, token: row.token, builder: row.builder,
      template: row.templateId.toLowerCase() === keccak256(stringToHex('BUDGET_LAUNCH')) ? 'BUDGET_LAUNCH' : 'ESCROW_LAUNCH',
      templateId: row.templateId, templateVersion: String(row.version), phase, deadlines: d,
      E: String(projected.E), R: String(projected.R), V: String(projected.V), T: String(projected.T), O: String(projected.O),
      bookPrice: ['Stage2', 'ListingPending'].includes(phase) ? bookPrice(projected) : phase === 'Stage3' ? JSON.parse(row.state).listingPrice ?? null : null,
      curvePrice: curvePrice(config, accounting[0]).toString(), targetPrice: String(config.targetPrice),
      sold: String(accounting[0]), allocation: String(config.supply / 5n), backers,
      quote: { address: config.quote, symbol: 'USDG', decimals: 6 }, metadata: profile, profile,
      description: profile.description, createdAt: row.createdAt, riskScoreBps: risk?.riskScoreBps ?? null,
      vetoActive: phase === 'Stage1' && Number(deadlines.vetoUntil) > this.now,
      dissolvedAt: phase === 'Dissolved' ? JSON.parse(row.state).dissolvedAt ?? null : null,
      dissolvedBy: phase === 'Dissolved' ? JSON.parse(row.state).dissolvedBy ?? 'deadline' : null,
      stateNonce: String(reserve.stateNonce), blockNumber: Number(this.blockNumber), chainTime: this.now,
    };
  }
  async detail(row: RaiseV31Row): Promise<Struct> {
    const [summary, reserve, fees, cfg, modules, govCfg, govState, streams, totalQuota, rewardNonce] = await Promise.all([
      this.summary(row), this.raise(row, 'reserveState'), this.raise(row, 'feeAccruals'), this.raise(row, 'getConfig'), this.raise(row, 'modules'),
      this.raise(row, 'governanceConfig'), this.raise(row, 'governanceState'), this.read(row.token, A.ProjectTokenV31Abi, 'rewardState'),
      this.read(row.token, A.ProjectTokenV31Abi, 'totalQuota'), this.read(row.token, A.ProjectTokenV31Abi, 'rewardNonce'),
    ]);
    const pending = summary.phase === 'ListingPending';
    const treasury = await this.treasury(String(cfg.treasury));
    return {
      ...summary, config: typed(cfg), modules: typed(modules), reserveState: typed(reserve),
      feeAccruals: typed({ reserveRetained: fees[0], rewards: fees[1], treasury: fees[2] }),
      governance: typed({ config: { builder: govCfg[0], parameters: govCfg[1], enabled: govCfg[2] }, state: { end: govState[0], escrow: govState[1], remainingCeiling: govState[2] } }),
      listingPreview: pending ? quote(await this.raise(row, 'listingPreview')) : null,
      listingStatus: pending ? await Promise.all(positionIds(this.db, row.address).map(async (p) => ({ id: p.id, ...typed(await this.raise(row, 'listingStatus', [BigInt(p.id)])) }))) : null,
      listingRecord: summary.phase === 'Stage3' ? typed(await this.raise(row, 'listingRecord')) : null,
      tokenStream: typed({ tokens: streams[0], quote: streams[1], totalQuota, rewardNonce }),
      treasury,
    };
  }
  /** Governed treasury: balances, the linear unlock of the treasury allocation, and what a proposal may spend. */
  async treasury(address: string): Promise<Struct> {
    const t = (fn: string, args: readonly unknown[] = []) => this.read(address, A.TreasuryV31Abi, fn, args);
    const [token, quoteAddr, allocation, locked, spendable, available, vestingDuration, spentQuote, spentTokens, governor] = await Promise.all([
      t('token'), t('quote'), t('allocation'), t('lockedTokens'), t('spendableTokens'), t('availableQuote'),
      t('vestingDuration'), t('spentQuote'), t('spentTokens'), t('governor'),
    ]);
    const [tokenBalance, quoteBalance, spendCapBps] = await Promise.all([
      this.read(token, A.ProjectTokenV31Abi, 'balanceOf', [address]), this.read(quoteAddr, A.MockUSDGV31Abi, 'balanceOf', [address]),
      this.read(governor, A.GovernanceV31Abi, 'spendCapBps'),
    ]);
    return typed({ address, allocation, lockedTokens: locked, spendableTokens: spendable, tokenBalance, quoteBalance,
      availableQuote: available, vestingDuration, spentQuote, spentTokens, spendCapBps: Number(spendCapBps) });
  }
  async positions(row: RaiseV31Row, user: string): Promise<Struct> {
    const u = getAddress(user);
    const [deadlines, nonce, buyerTokens, delivery, quota, rewards, tokenBalance, config, grant, vested, claimed] = await Promise.all([
      this.raise(row, 'stageDeadlines'), this.raise(row, 'stateNonce'), this.raise(row, 'buyerTokens', [u]), this.raise(row, 'deliveryOf', [u]),
      this.read(row.token, A.ProjectTokenV31Abi, 'quotaOf', [u]), this.read(row.token, A.ProjectTokenV31Abi, 'pendingRewards', [u]),
      this.read(row.token, A.ProjectTokenV31Abi, 'balanceOf', [u]), this.raise(row, 'getConfig'), this.raise(row, 'builderGrant', [u]),
      this.read(row.vesting, A.VestingVaultV31Abi, 'vested', [u]), this.read(row.vesting, A.VestingVaultV31Abi, 'claimed', [u]),
    ]);
    const phase = effectivePhase(Number(deadlines.validity.phase), deadlines, this.now);
    const positions = await Promise.all(positionIds(this.db, row.address, u).map(async ({ id }) => {
      const p = await this.raise(row, 'positionState', [BigInt(id)]);
      const [claim, redeem, protectedQuote, status, atRisk] = await Promise.all([
        this.raise(row, 'guaranteedClaim', [BigInt(id)]), this.raise(row, 'redeemQuote', [BigInt(id), p.tokens, nonce]),
        phase === 'Stage2' ? this.raise(row, 'protectedExitQuote', [BigInt(id), p.tokens]) : null,
        this.raise(row, 'listingStatus', [BigInt(id)]), this.raise(row, 'atRiskBasis', [BigInt(id)]),
      ]);
      return { id, positionState: typed(p), guaranteedClaim: typed(claim), redeemQuote: quote(redeem),
        protectedExitQuote: protectedQuote ? quote(protectedQuote) : null, listingStatus: typed(status), atRiskBasis: String(atRisk) };
    }));
    return {
      user: u, raise: row.address, phase, stateNonce: String(nonce), blockNumber: Number(this.blockNumber), chainTime: this.now, positions,
      buyerLedger: { tokens: String(buyerTokens), marketExitQuote: quote(await this.raise(row, 'marketExitQuote', [u, buyerTokens])) },
      delivery: typed({ tokens: delivery[0], originalQuota: delivery[1], frozenRecord: true }), quota: String(quota),
      pendingRewards: typed({ tokens: rewards[0], quote: rewards[1] }), walletTokenBalance: String(tokenBalance),
      walletQuoteBalance: String(await this.read(config.quote, A.MockUSDGV31Abi, 'balanceOf', [u])),
      vesting: typed({ grant, vested, claimed, claimable: vested - claimed }),
    };
  }
  /**
   * Everything a user could roll into another project in one transaction: live Stage 1/Stage 2 positions (exit at
   * cost, or with protected profit in Stage 2) and funded dissolution claims.
   */
  async rolloverSources(rows: RaiseV31Row[], user: string): Promise<Struct[]> {
    const u = getAddress(user);
    const out: Struct[] = [];
    for (const row of rows) {
      const owned = positionIds(this.db, row.address, u).filter((p) => p.class !== 1);
      if (!owned.length) continue;
      const [deadlines, nonce] = await Promise.all([this.raise(row, 'stageDeadlines'), this.raise(row, 'stateNonce')]);
      const phase = effectivePhase(Number(deadlines.validity.phase), deadlines, this.now);
      if (phase === 'Stage3') continue;
      const positions = [];
      for (const { id } of owned) {
        const state = await this.raise(row, 'positionState', [BigInt(id)]);
        if (phase === 'Dissolved') {
          const claimable = await this.read(row.claims, A.ClaimVaultAbi, 'claimable', [BigInt(id)]);
          if (claimable > 0n) positions.push({ id, kind: 'DissolutionClaim', amount: String(claimable), tokens: '0', minPayout: '0' });
          continue;
        }
        if (state.tokens === 0n) continue;
        const cost = await this.raise(row, 'redeemQuote', [BigInt(id), state.tokens, nonce]);
        if (!cost.validity.available) continue;
        const item: Struct = { id, kind: 'CostExit', amount: String(cost.result.payout), tokens: String(state.tokens), minPayout: String(cost.result.payout), cost: String(cost.result.cost) };
        if (phase === 'Stage2' && Number(state.class) === 0) {
          const withProfit = await this.raise(row, 'protectedExitQuote', [BigInt(id), state.tokens]);
          if (withProfit.validity.available && withProfit.result.payout > cost.result.payout) {
            Object.assign(item, { kind: 'ProtectedExit', amount: String(withProfit.result.payout), minPayout: String(withProfit.result.payout), profit: String(withProfit.result.profit) });
          }
        }
        positions.push(item);
      }
      if (positions.length) out.push({ raise: row.address, name: row.name, symbol: row.symbol, phase, stateNonce: String(nonce), positions });
    }
    return out;
  }
  async proposals(row: RaiseV31Row): Promise<Struct[]> {
    const count = Number(await this.read(row.governor, A.GovernanceV31Abi, 'proposalsCount'));
    return Promise.all(Array.from({ length: count }, async (_, i) => {
      const p = await this.read(row.governor, A.GovernanceV31Abi, 'getProposal', [BigInt(i + 1)]);
      const status = STATUSES[p.status];
      const state = status === 'Active' ? (this.now < Number(p.votingEnds) ? 'Voting' : 'AwaitingFinalization') : status === 'Passed' ? (this.now < Number(p.disputeEnds) ? 'Dispute' : 'Executable') : status;
      const indexed = this.db.query('SELECT data FROM v31_proposals WHERE raiseAddr=? AND id=?').get(row.address, String(i + 1)) as { data: string } | null;
      const mode = MODES[Number(p.mode)];
      const cap = mode === 'Token' ? await this.read(row.governor, A.GovernanceV31Abi, 'spendCapacity', [BigInt(i + 1)]) : p.yesWeight / 10n;
      return { id: String(i + 1), ...typed(p), kind: KINDS[Number(p.kind)], mode, status, state,
        quorumBps: mode === 'Token' ? 0 : 4000, approvalBps: 6000, cap: String(cap),
        executedTx: indexed ? JSON.parse(indexed.data).executedTx ?? null : null };
    }));
  }
}
