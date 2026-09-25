/**
 * The mock activity engine. Every tick reads chain time and each managed raise, then drives whatever is due:
 * launches, Stage 1 deposits and exits, rollovers, Stage 2 ledger trades and Budget votes, listing, Stage 3 swaps,
 * treasury proposals and votes, dissolutions and claims, and the builder's off-chain profile, updates and feedback.
 *
 * Every on-chain decision is derived from chain state, so a restarted runner picks up where it stopped. State
 * files only remember what the chain cannot tell us cheaply (which persona owns which position, what was posted).
 */
import {
  formatEther,
  formatUnits,
  getAddress,
  parseEther,
  zeroAddress,
  type Abi,
  type Address,
  type Hex,
  type TransactionReceipt,
} from 'viem';
import type { PrivateKeyAccount } from 'viem/accounts';
import {
  PROJECTS,
  FEEDBACK,
  byTicker,
  markPng,
  profileBody,
  remainingFillCost,
  sizing,
  USDG,
  type CatalogProject,
  type Template,
} from '../catalog';
import { ApiClient } from './api';
import { GasCapError, isFundsError, isRangeError, revertName, sleep, type Call, type Chain } from './chain';
import type { MockConfig, Range } from './config';
import { errorText, log } from './log';
import {
  A,
  MAX_UINT256,
  SwapRouterAbi,
  events,
  raiseSnapshot,
  versionParams,
  type Deployment,
  type RaiseSnapshot,
  type VersionParams,
} from './protocol';
import { hash, rng, type Rng } from './random';
import {
  saveState,
  type Fate,
  type Hold,
  type MockState,
  type PositionRecord,
  type ProjectState,
  type ProposalRecord,
  type ReviewRecord,
} from './state';
import { ofKind, type Persona } from './wallets';
import type { MindService } from '../ai/mind';
import { raiseFacts, type RaiseFacts } from '../ai/context';
import { mindFor } from '../ai/personas';
import type { CatalogBrief, ProposalFacts } from '../ai/prompts';

const RaiseAbi = A.RaiseCoreAbi as Abi;
const GovAbi = A.GovernanceV31Abi as Abi;
const TokenAbi = A.ProjectTokenV31Abi as Abi;
const QuoteAbi = A.MockUSDGV31Abi as Abi;
const ClaimsAbi = A.ClaimVaultAbi as Abi;
const TreasuryAbi = A.TreasuryV31Abi as Abi;
const FactoryAbi = A.RaiseFactoryV31Abi as Abi;
const RolloverAbi = A.RolloverRouterV31Abi as Abi;
const STATUSES = ['None', 'Active', 'Passed', 'Defeated', 'Executed', 'Cancelled', 'Expired'];
/** How far back (blocks) startup recovery looks for lost receipts; 10 getLogs calls at 100 blocks each. */
const RECOVER_BLOCKS = 1000n;

export const usd = (n: number) => BigInt(Math.max(0, Math.floor(n * 1e6)));
export const fmtUsd = (v: bigint) =>
  `${Number(formatUnits(v, 6)).toLocaleString('en-US', { maximumFractionDigits: 2 })} USDG`;
const fmtDur = (s: number) =>
  s >= 86400 ? `${(s / 86400).toFixed(1)}d` : s >= 3600 ? `${(s / 3600).toFixed(1)}h` : `${Math.round(s / 60)}m`;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const minBig = (a: bigint, b: bigint) => (a < b ? a : b);
const maxBig = (a: bigint, b: bigint) => (a > b ? a : b);

export type TempoMode = 'auto' | 'bootstrap' | 'steady';

export interface EngineDeps {
  chain: Chain;
  dep: Deployment;
  api: ApiClient;
  personas: Persona[];
  funder: PrivateKeyAccount | null;
  state: MockState;
  statePath: string;
  config: MockConfig;
  dryRun: boolean;
  warp: boolean;
  tempo: TempoMode;
  /** AI persona minds (disabled without MIMO_API_KEY; every use has a template fallback). */
  mind: MindService;
}

/** A project the seed wants created, and where it should come to rest. */
export interface LaunchSpec {
  fate: Fate;
  template?: Template;
  stage1?: 'min' | 'long';
  stage2?: 'min' | 'long';
  /** Explicit stage lengths in minutes (clamped to the registry bounds); win over stage1/stage2. */
  stage1Minutes?: Range;
  stage2Minutes?: Range;
  hold?: Hold;
  /** Why this launch happened (cadence, a stage gap, the seed). */
  reason?: string;
}

async function pool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(limit, queue.length)) }, async () => {
      for (let item = queue.shift(); item !== undefined; item = queue.shift()) await fn(item);
    }),
  );
}

export class Engine {
  params!: Record<Template, VersionParams>;
  now = 0;
  head = 0n;
  dt = 0;
  private lastNow = 0;
  private r: Rng;
  private snaps = new Map<string, RaiseSnapshot>();
  private gasOkUntil = new Map<string, number>();
  private funding = new Map<string, Promise<void>>();
  private notes = new Set<string>();
  /** Public facts per raise, fetched at most once per tick for prompts. */
  private factsCache = new Map<string, { tick: number; facts: RaiseFacts | null }>();
  stopping = false;

  constructor(readonly d: EngineDeps) {
    this.r = rng(`${d.state.rngSeed}:${d.state.tick}`);
  }

  get state() {
    return this.d.state;
  }
  get config() {
    return this.d.config;
  }
  private persona(index: number): Persona {
    return this.d.personas[index];
  }
  private catalog(p: ProjectState): CatalogProject {
    return byTicker(p.catalogTicker ?? p.ticker);
  }
  save() {
    if (this.d.dryRun) return;
    this.state.ai = this.d.mind.client.snapshot();
    saveState(this.d.statePath, this.d.state);
  }
  private get ai() {
    return this.config.ai;
  }
  /**
   * How long this AI wait may block: every wait in a tick shares one budget (long in warp mode, where chain time is
   * compressed), so a slow provider delays a tick by at most that much and unfinished answers land on a later tick.
   */
  private aiDeadline = 0;
  private get aiWait() {
    return Math.max(0, this.aiDeadline - Date.now());
  }
  private once(key: string, fn: () => void) {
    if (!this.notes.has(key)) {
      this.notes.add(key);
      fn();
    }
  }
  /** Probability that an event with the given hourly rate happens during this tick. */
  private chance(perHour: number) {
    return this.r.chance(1 - Math.exp(-(perHour * this.dt) / 3600));
  }
  private between([lo, hi]: Range) {
    return this.r.range(lo, hi);
  }
  private deadline() {
    return BigInt(this.now + 1800);
  }

  async init(): Promise<void> {
    const [escrow, budget] = await Promise.all([
      versionParams(this.d.chain, this.d.dep, this.d.dep.escrowTemplate),
      versionParams(this.d.chain, this.d.dep, this.d.dep.budgetTemplate),
    ]);
    this.params = { ESCROW_LAUNCH: escrow, BUDGET_LAUNCH: budget };
    const head = await this.d.chain.head();
    this.now = head.timestamp;
    this.head = head.number;
    log.info('params', {
      stage1: `${fmtDur(escrow.stage1Min)}..${fmtDur(escrow.stage1Max)}`,
      stage2: `${fmtDur(escrow.stage2Min)}..${fmtDur(escrow.stage2Max)}`,
      voting: fmtDur(budget.voting),
      dispute: fmtDur(budget.dispute),
      execution: fmtDur(budget.execution),
      proposalInterval: fmtDur(budget.proposalInterval),
      minimumBackers: escrow.minimumBackers,
      version: escrow.version,
    });
    if (this.d.tempo === 'steady' && !this.state.tempo.bootstrapDone) {
      this.state.tempo.bootstrapDone = true;
      this.state.tempo.nextLaunchAt ??= this.now;
    }
    this.d.mind.client.restore(this.state.ai);
    await this.recover();
    await this.attempt('discover', null, () => this.discover());
  }

  /** Re-attach raises whose create receipt was lost, and positions whose deposit receipt was lost. */
  private async recover(): Promise<void> {
    const owners = this.d.personas.map((p) => p.address);
    for (const p of Object.values(this.state.projects)) {
      if (!p.raise && p.createFromBlock !== undefined) await this.findCreated(p);
      if (!p.raise || p.done || !p.createdBlock) continue;
      if (this.now - (p.createdAt ?? 0) > 2 * 86400) continue;
      try {
        // Only the recent past can hold a lost receipt (state is saved after every transaction).
        const from = maxBig(BigInt(p.createdBlock), this.head > RECOVER_BLOCKS ? this.head - RECOVER_BLOCKS : 0n);
        const logs = await this.logs(p.raise as Address, 'Deposited', { owner: owners }, from);
        let added = 0;
        for (const entry of logs) {
          const id = String(entry.args.id);
          if (p.positions.some((x) => x.id === id)) continue;
          const owner = this.d.personas.find((x) => x.address === getAddress(entry.args.owner));
          if (!owner) continue;
          p.positions.push({ id, owner: owner.index, class: Number(entry.args.class) === 2 ? 'Builder' : 'Backer' });
          added++;
        }
        if (added) log.info('recovered-positions', { project: p.ticker, added });
      } catch (error) {
        log.warn('recover-skipped', { project: p.ticker, error: errorText(error) });
      }
    }
    this.save();
  }

  private async logs(
    address: Address,
    eventName: string,
    args: Record<string, unknown>,
    fromBlock: bigint,
    toBlock: bigint = this.head,
  ): Promise<any[]> {
    const abi = (address === this.d.dep.factory ? FactoryAbi : RaiseAbi) as Abi;
    const event = abi.find((x) => x.type === 'event' && x.name === eventName) as never;
    const out: any[] = [];
    // Public X Layer testnet RPC caps eth_getLogs at 100 blocks per query.
    let step = 100n;
    const last = toBlock > this.head ? this.head : toBlock;
    for (let from = fromBlock; from <= last;) {
      const to = from + step - 1n > last ? last : from + step - 1n;
      try {
        out.push(
          ...(await this.d.chain.retry(
            'getLogs',
            () => this.d.chain.client.getLogs({ address, event, args, fromBlock: from, toBlock: to } as never),
            3,
          )),
        );
        from = to + 1n;
      } catch (error) {
        if (!isRangeError(error) || step <= 10n) throw error;
        step /= 4n;
      }
    }
    return out;
  }

  // ------------------------------------------------------------------ main loop

  async tick(): Promise<void> {
    const head = await this.d.chain.head();
    this.now = head.timestamp;
    this.head = head.number;
    this.dt = this.lastNow ? clamp(this.now - this.lastNow, 1, 3600) : this.config.tickSeconds;
    this.lastNow = this.now;
    this.state.tick++;
    this.r = rng(`${this.state.rngSeed}:${this.state.tick}`);
    this.aiDeadline = Date.now() + (this.d.warp ? this.ai.warpWaitMs : this.ai.waitMs);
    try {
      await this.d.chain.gasPrice();
    } catch (error) {
      if (error instanceof GasCapError) {
        log.warn('gas-cap', { error: error.message });
        return;
      }
      throw error;
    }
    const sentBefore = this.d.chain.stats.sent;
    const active = Object.values(this.state.projects).filter((p) => p.raise && !p.done);
    await pool(active, this.config.concurrency, async (p) => {
      try {
        await this.step(p);
      } catch (error) {
        log.error('project-step', { project: p.ticker, error: errorText(error) });
      }
    });
    const discover = this.state.tick % Math.max(1, this.ai.discoverEveryTicks) === 0;
    for (const [label, fn] of [
      ['rollovers', () => this.rollovers()],
      ['launches', () => this.launches()],
      ['discover', () => (discover ? this.discover() : Promise.resolve())],
    ] as const) {
      try {
        await fn();
      } catch (error) {
        log.error(label, { error: errorText(error) });
      }
    }
    this.save();
    const phases: Record<string, number> = {};
    for (const p of Object.values(this.state.projects)) {
      const phase = p.done ? `${p.lastPhase ?? 'pending'}*` : (p.lastPhase ?? (p.raise ? 'unknown' : 'pending'));
      phases[phase] = (phases[phase] ?? 0) + 1;
    }
    log.info('tick', {
      n: this.state.tick,
      chainTime: new Date(this.now * 1000).toISOString().slice(0, 19),
      txs: this.d.chain.stats.sent - sentBefore,
      phases,
      aiPending: this.d.mind.pending || undefined,
    });
    if (this.d.mind.enabled && this.state.tick % 30 === 0) this.logAiUsage();
    this.logOccupancy();
  }

  /** Once per chain hour: how many projects sit in each stage (catalog projects; user raises separately). */
  private logOccupancy(): void {
    const hour = Math.floor(this.now / 3600);
    if (this.state.tempo.occupancyHour === hour) return;
    this.state.tempo.occupancyHour = hour;
    const counts: Record<string, number> = { Stage1: 0, Stage2: 0, ListingPending: 0, Stage3: 0, Dissolved: 0 };
    let users = 0;
    for (const p of Object.values(this.state.projects)) {
      if (p.external) {
        users++;
        continue;
      }
      const phase = p.raise ? (this.snaps.get(this.key(p))?.phase ?? p.lastPhase) : 'Stage1';
      if (phase) counts[phase] = (counts[phase] ?? 0) + 1;
    }
    const markets = Object.values(this.state.projects).filter((p) => !p.external);
    log.info('occupancy', {
      chainTime: new Date(hour * 3600 * 1000).toISOString().slice(0, 13) + ':00',
      ...counts,
      userRaises: users || undefined,
      trades: markets.reduce((n, p) => n + p.market.trades, 0),
      swaps: markets.reduce((n, p) => n + p.market.swaps, 0),
    });
  }

  /** AI usage for the current hour (counts only). */
  logAiUsage(all = false): void {
    const usage = this.d.mind.client.usage;
    const hours = Object.keys(usage).sort();
    for (const hour of all ? hours : hours.slice(-1)) {
      const u = usage[hour];
      log.info('ai-usage', {
        hour,
        calls: u.calls,
        cacheHits: u.cacheHits,
        repairs: u.repairs,
        failures: u.failures,
        fallbacks: u.fallbacks,
        promptTokens: u.promptTokens,
        completionTokens: u.completionTokens,
        reasoningTokens: u.reasoningTokens,
        byTask: u.byTask,
      });
    }
  }

  /** Run until stopped, `ticks` ticks have passed, or `stopWhen` says so. */
  async loop(opts: { ticks?: number; stopWhen?: () => boolean } = {}): Promise<void> {
    const first = this.state.tick;
    let failures = 0;
    while (!this.stopping) {
      const started = Date.now();
      try {
        await this.tick();
        failures = 0;
      } catch (error) {
        failures++;
        const wait = Math.min(120_000, 2000 * 2 ** failures);
        log.error('tick-failed', { failures, waitMs: wait, error: errorText(error) });
        for (let left = wait; left > 0 && !this.stopping; left -= 250) await sleep(Math.min(250, left));
        continue;
      }
      if ((opts.ticks && this.state.tick - first >= opts.ticks) || opts.stopWhen?.() || this.stopping) break;
      if (this.d.warp) {
        await this.d.chain.warp(this.config.warpSeconds);
        await sleep(50);
      } else {
        const wait = started + this.config.tickSeconds * 1000 - Date.now();
        for (let left = wait; left > 0 && !this.stopping; left -= 250) await sleep(Math.min(250, left));
      }
    }
    this.save();
  }

  // ------------------------------------------------------------------ transactions

  private async tx(
    persona: Persona,
    call: Call,
    action: string,
    p?: ProjectState,
    fields: Record<string, unknown> = {},
  ): Promise<TransactionReceipt | null> {
    await this.ensureGas(persona);
    try {
      return await this.d.chain.send(persona.account, call, action, {
        as: persona.label,
        ...(p ? { project: p.ticker } : {}),
        ...fields,
      });
    } catch (error) {
      if (isFundsError(error)) this.gasOkUntil.delete(persona.address);
      throw error;
    }
  }

  /** A raise action that takes (…, nonce, deadline); retried when another actor moved the nonce first. */
  private async guarded(
    persona: Persona,
    p: ProjectState,
    fn: string,
    args: readonly unknown[],
    action: string,
    fields: Record<string, unknown> = {},
  ) {
    for (let attempt = 1; ; attempt++) {
      const nonce = await this.d.chain.read<bigint>(p.raise!, RaiseAbi, 'stateNonce');
      try {
        return await this.tx(
          persona,
          { address: p.raise!, abi: RaiseAbi, functionName: fn, args: [...args, nonce, this.deadline()] },
          action,
          p,
          fields,
        );
      } catch (error) {
        if (revertName(error) === 'StaleNonce' && attempt < 3) continue;
        throw error;
      }
    }
  }

  /** Run one action; log and swallow its failure so the rest of the tick continues. */
  private async attempt(action: string, p: ProjectState | null, fn: () => Promise<unknown>): Promise<boolean> {
    try {
      await fn();
      return true;
    } catch (error) {
      log.warn('action-failed', {
        action,
        ...(p ? { project: p.ticker } : {}),
        revert: revertName(error) ?? undefined,
        error: errorText(error),
      });
      return false;
    }
  }

  /** Lifecycle calls anyone may make (advance, list, finalize, execute) back off after failures. */
  private async keeper(p: ProjectState, persona: Persona, call: Call, action: string): Promise<boolean> {
    if (p.nextKeeperAt && this.now < p.nextKeeperAt) return false;
    const ok = await this.attempt(action, p, () => this.tx(persona, call, action, p));
    if (ok) {
      p.keeperFailures = 0;
      p.nextKeeperAt = undefined;
    } else {
      p.keeperFailures = (p.keeperFailures ?? 0) + 1;
      p.nextKeeperAt = this.now + Math.min(1800, 30 * 2 ** p.keeperFailures);
    }
    return ok;
  }

  private keeperPersona(): Persona {
    return this.r.pick(ofKind(this.d.personas, 'voter', 'conservative'));
  }

  private fundingProfile() {
    return this.d.chain.isLocal ? this.config.funding.local : this.config.funding.testnet;
  }

  /** Native gas top-up from the funder, conservatively capped per day and never below the funder's reserve. */
  private async ensureGas(persona: Persona): Promise<void> {
    if (this.d.dryRun || (this.gasOkUntil.get(persona.address) ?? 0) > Date.now()) return;
    const inflight = this.funding.get(persona.address);
    if (inflight) return inflight;
    const job = (async () => {
      const f = this.fundingProfile();
      const balance = await this.d.chain.balance(persona.address);
      if (balance >= parseEther(f.nativeMin)) {
        this.gasOkUntil.set(persona.address, Date.now() + 10 * 60_000);
        return;
      }
      if (!this.d.funder) {
        this.once(`nofunder:${persona.address}`, () => log.warn('no-funder', { persona: persona.label }));
        return;
      }
      const amount = parseEther(persona.kind === 'builder' ? f.builderNativeTopUp : f.nativeTopUp) - balance;
      const fund = this.state.funding;
      if (Date.now() - fund.windowStart > 86_400_000) {
        fund.windowStart = Date.now();
        fund.nativeSpent = '0';
      }
      if (BigInt(fund.nativeSpent) + amount > parseEther(f.nativeMaxPerDay)) {
        this.once(`cap:${fund.windowStart}`, () =>
          log.warn('funding-cap', { spentToday: formatEther(BigInt(fund.nativeSpent)), cap: f.nativeMaxPerDay }),
        );
        return;
      }
      const funderBalance = await this.d.chain.balance(this.d.funder.address);
      if (funderBalance < amount + parseEther(f.funderReserve)) {
        this.once(`funderlow:${Math.floor(Date.now() / 3_600_000)}`, () =>
          log.warn('funder-low', { balance: formatEther(funderBalance), reserve: f.funderReserve }),
        );
        return;
      }
      await this.d.chain.sendValue(this.d.funder, persona.address, amount, 'fund-gas', {
        to: persona.label,
        amount: formatEther(amount),
      });
      fund.nativeSpent = String(BigInt(fund.nativeSpent) + amount);
      this.gasOkUntil.set(persona.address, Date.now() + 10 * 60_000);
    })().finally(() => this.funding.delete(persona.address));
    this.funding.set(persona.address, job);
    return job;
  }

  /** Test USDG comes from the unrestricted MockUSDGV31 faucet (`mint`), called by the persona itself. */
  private async ensureUsdg(persona: Persona, amount: bigint): Promise<void> {
    if (this.d.dryRun) return;
    const balance = await this.d.chain.read<bigint>(this.d.dep.quote, QuoteAbi, 'balanceOf', [persona.address]);
    if (balance >= amount) return;
    const target = maxBig(usd(this.config.funding.usdgTarget[persona.kind] ?? 100_000), amount * 2n);
    const mint = target - balance;
    await this.tx(
      persona,
      { address: this.d.dep.quote, abi: QuoteAbi, functionName: 'mint', args: [persona.address, mint] },
      'faucet-mint',
      undefined,
      { amount: fmtUsd(mint) },
    );
    const minted = BigInt(this.state.funding.usdgMinted) + mint;
    this.state.funding.usdgMinted = String(minted);
  }

  private async ensureApproval(
    persona: Persona,
    token: Address | string,
    spender: Address | string,
    amount: bigint,
    p?: ProjectState,
  ): Promise<void> {
    const key = `${persona.address}:${token}:${spender}`.toLowerCase();
    if (this.state.approvals[key]) return;
    if (!this.d.dryRun) {
      const allowance = await this.d.chain.read<bigint>(token, QuoteAbi, 'allowance', [persona.address, spender]);
      if (allowance >= amount && allowance > MAX_UINT256 / 2n) {
        this.state.approvals[key] = true;
        return;
      }
    }
    await this.tx(
      persona,
      { address: token, abi: QuoteAbi, functionName: 'approve', args: [spender, MAX_UINT256] },
      'approve',
      p,
      { spender },
    );
    if (!this.d.dryRun) this.state.approvals[key] = true;
  }

  // ------------------------------------------------------------------ launches

  lengths(
    template: Template,
    fate: Fate,
    fast: { stage1: boolean; stage2: boolean },
    ranges: { stage1?: Range; stage2?: Range } = {},
  ): [number, number] {
    const prm = this.params[template];
    let s1 = ranges.stage1
      ? Math.round(this.between(ranges.stage1) * 60)
      : fast.stage1
        ? prm.stage1Min
        : Math.round(this.between(this.config.steady.stage1Minutes) * 60);
    let s2 = ranges.stage2
      ? Math.round(this.between(ranges.stage2) * 60)
      : fast.stage2
        ? prm.stage2Min
        : Math.round(this.between(this.config.steady.stage2Minutes) * 60);
    // A builder dissolution needs Stage 1 to outlast its pinned minimum.
    if (fate === 'dissolve-builder') s1 = Math.max(s1, prm.stage1Min * 2, prm.stage1Min + 600);
    // A Budget draw's whole vote/dispute/execution schedule must fit inside Stage 2, with room to propose.
    if (template === 'BUDGET_LAUNCH')
      s2 = Math.max(s2, Math.ceil((prm.voting + prm.dispute + prm.execution) * 1.3) + 120);
    return [clamp(s1, prm.stage1Min, prm.stage1Max), clamp(s2, prm.stage2Min, prm.stage2Max)];
  }

  /** What the bootstrap tempo would launch next, without side effects (for --dry-run). */
  planBootstrap(): {
    at: string;
    ticker: string;
    name: string;
    template: Template;
    fate: Fate;
    stage1: string;
    stage2: string;
  }[] {
    const b = this.config.bootstrap;
    const start = this.state.tempo.bootstrapStartedAt ?? this.now;
    const used = new Set(Object.keys(this.state.projects));
    const next = PROJECTS.filter((x) => !used.has(x.ticker));
    const out = [];
    for (let i = this.state.tempo.bootstrapLaunched; i < b.launches && next.length; i++) {
      const project = next.shift()!;
      const fate = b.fates[i % b.fates.length];
      const [s1, s2] = this.lengths(project.template, fate, { stage1: true, stage2: true });
      out.push({
        at: new Date((start + i * b.spacingMinutes * 60) * 1000).toISOString().slice(0, 19),
        ticker: project.ticker,
        name: project.name,
        template: project.template,
        fate,
        stage1: fmtDur(s1),
        stage2: fmtDur(s2),
      });
    }
    return out;
  }

  private activeCount(): number {
    return Object.values(this.state.projects).filter(
      (p) => !p.done && !p.external && !['Stage3', 'Dissolved'].includes(p.lastPhase ?? ''),
    ).length;
  }

  async launches(): Promise<void> {
    for (const p of Object.values(this.state.projects)) {
      if (p.raise || p.done) continue;
      if (await this.attempt('create-raise', p, () => this.create(p))) continue;
      p.keeperFailures = (p.keeperFailures ?? 0) + 1;
      if (p.keeperFailures >= 3) {
        p.done = true;
        p.lastPhase = 'CreateFailed';
        log.error('create-abandoned', { project: p.ticker });
      }
    }
    const tempo = this.state.tempo;
    if (!tempo.bootstrapDone) {
      const b = this.config.bootstrap;
      tempo.bootstrapStartedAt ??= this.now;
      while (
        tempo.bootstrapLaunched < b.launches &&
        this.now >= tempo.bootstrapStartedAt + tempo.bootstrapLaunched * b.spacingMinutes * 60
      ) {
        const fate = b.fates[tempo.bootstrapLaunched % b.fates.length];
        tempo.bootstrapLaunched++;
        if (!(await this.launch({ fate, stage1: 'min', stage2: 'min' }))) break;
      }
      if (tempo.bootstrapLaunched >= b.launches) {
        tempo.bootstrapDone = true;
        tempo.nextLaunchAt = this.now + Math.round(this.between(this.config.steady.launchEveryMinutes) * 60);
        log.info('tempo', {
          mode: this.d.tempo === 'bootstrap' ? 'bootstrap-complete' : 'steady',
          nextLaunchAt: new Date(tempo.nextLaunchAt * 1000).toISOString(),
        });
      }
      return;
    }
    if (this.d.tempo === 'bootstrap') return;
    const s = this.config.steady;
    const o = this.config.occupancy;
    tempo.nextLaunchAt ??= this.now;
    const occ = this.occupancy();
    const gap2 = occ.stage2 < o.stage2Min;
    const gap1 = occ.stage1 < o.stage1Min;
    const due = this.now >= tempo.nextLaunchAt;
    const canFill =
      this.now - (tempo.lastGapFillAt ?? 0) >= 3600 / Math.max(1, o.maxGapFillsPerHour) &&
      tempo.nextLaunchAt - this.now > o.gapLeadMinutes * 60;
    if (!due && !((gap1 || gap2) && canFill)) return;
    if (this.activeCount() >= this.config.maxActiveProjects) {
      if (due) {
        log.info('launch-deferred', { active: this.activeCount(), max: this.config.maxActiveProjects });
        tempo.nextLaunchAt = this.now + Math.round(this.between(s.launchEveryMinutes) * 60);
      }
      return;
    }
    const batch = due ? Math.max(1, Math.round(this.between(s.launchBatch))) : 1;
    for (let i = 0; i < batch; i++) {
      // The first launch fills the emptiest stage soonest; any others follow the regular cadence.
      const spec =
        i === 0 ? this.nextSpec(gap1, gap2, due ? 'cadence' : 'gap') : this.nextSpec(false, false, 'cadence');
      if (!(await this.launch(spec))) break;
      log.info('launch-plan', { reason: spec.reason, fate: spec.fate, stage1: occ.stage1, stage2: occ.stage2 });
    }
    if (due) tempo.nextLaunchAt = this.now + Math.round(this.between(s.launchEveryMinutes) * 60);
    else tempo.lastGapFillAt = this.now;
  }

  /**
   * Mock projects per stage, looking ahead: a project leaving a stage within lookaheadMinutes no longer counts
   * there, and a graduating Stage 1 project about to open Stage 2 already counts for Stage 2.
   */
  occupancy(): { stage1: number; stage2: number } {
    const ahead = this.now + this.config.occupancy.lookaheadMinutes * 60;
    let stage1 = 0;
    let stage2 = 0;
    for (const p of Object.values(this.state.projects)) {
      if (p.external || p.done) continue;
      if (!p.raise) {
        stage1++; // launch in flight
        continue;
      }
      const s = this.snaps.get(this.key(p));
      if (!s) continue;
      if (s.phase === 'Stage1') {
        if (s.stage1End > ahead) stage1++;
        else if (p.fate === 'graduate' && s.stage1End + p.stage2Length > ahead) stage2++;
      } else if (s.phase === 'Stage2' && s.stage2End > ahead) stage2++;
    }
    return { stage1, stage2 };
  }

  /** Fate and stage lengths for the next launch: a Stage 2 gap wants a quick Stage 1 and a long Stage 2. */
  private nextSpec(gap1: boolean, gap2: boolean, why: 'cadence' | 'gap'): LaunchSpec {
    const o = this.config.occupancy;
    if (gap2) {
      return {
        fate: 'graduate',
        stage1Minutes: o.gapStage1Minutes,
        stage2Minutes: o.gapStage2Minutes,
        reason: `${why}:stage2-gap`,
      };
    }
    const s = this.config.steady;
    const fate: Fate = this.r.chance(s.dissolveShare)
      ? this.r.chance(0.5)
        ? 'dissolve-builder'
        : 'dissolve-deadline'
      : 'graduate';
    return { fate, stage1: 'long', stage2: 'long', reason: gap1 ? `${why}:stage1-gap` : why };
  }

  /** Take the next catalog project and create its raise. Returns false when the catalog is exhausted. */
  async launch(spec: LaunchSpec): Promise<ProjectState | null> {
    let project: CatalogProject | undefined;
    if (spec.template) {
      project = PROJECTS.find((x) => x.template === spec.template && !this.state.projects[x.ticker]);
    } else {
      while (
        this.state.catalogCursor < PROJECTS.length &&
        this.state.projects[PROJECTS[this.state.catalogCursor].ticker]
      )
        this.state.catalogCursor++;
      project = PROJECTS[this.state.catalogCursor];
      if (project) this.state.catalogCursor++;
    }
    let ticker: string | undefined = project?.ticker;
    let name: string | undefined;
    if (!project) {
      // The catalog has run out: relaunch the project launched longest ago that is not live now, as "<name> v<n>".
      const recycled = this.recycle(spec.template);
      if (!recycled) {
        this.once('catalog', () => log.warn('catalog-exhausted', { projects: PROJECTS.length }));
        return null;
      }
      ({ project, ticker, name } = recycled);
    }
    const builders = ofKind(this.d.personas, 'builder');
    const [stage1Length, stage2Length] = this.lengths(
      project.template,
      spec.fate,
      { stage1: spec.stage1 !== 'long', stage2: spec.stage2 !== 'long' },
      { stage1: spec.stage1Minutes, stage2: spec.stage2Minutes },
    );
    const p: ProjectState = {
      ticker: ticker!,
      ...(name ? { catalogTicker: project.ticker, name } : {}),
      builder: builders[PROJECTS.indexOf(project) % builders.length].index,
      template: project.template,
      fate: spec.fate,
      hold: spec.hold ?? null,
      stage1Length,
      stage2Length,
      scheduledAt: this.now,
      fillBy: this.between(this.config.stage1.fillBy),
      partialFill: this.between(this.config.stage1.partialFill),
      positions: [],
      proposals: [],
      exits: { stage1: 0, stage2: 0 },
      updatesPosted: 0,
      feedbackPosted: 0,
      market: { mood: this.r.range(-0.3, 0.3), burst: 0, trades: 0, swaps: 0 },
    };
    this.state.projects[ticker!] = p;
    this.save();
    await this.attempt('create-raise', p, () => this.create(p));
    return p;
  }

  /** Next relaunch after the catalog is used up: oldest-launched project not live now, versioned name and ticker. */
  private recycle(template?: Template): { project: CatalogProject; ticker: string; name: string } | null {
    const launches = new Map<string, { count: number; last: number; live: boolean }>();
    for (const p of Object.values(this.state.projects)) {
      if (p.external) continue;
      const base = p.catalogTicker ?? p.ticker;
      const e = launches.get(base) ?? { count: 0, last: 0, live: false };
      e.count++;
      e.last = Math.max(e.last, p.scheduledAt);
      e.live ||= !p.done && !['Stage3', 'Dissolved'].includes(p.lastPhase ?? '');
      launches.set(base, e);
    }
    const candidates = PROJECTS.filter(
      (x) => (!template || x.template === template) && !launches.get(x.ticker)?.live,
    ).sort((a, b) => (launches.get(a.ticker)?.last ?? 0) - (launches.get(b.ticker)?.last ?? 0));
    const project = candidates[0];
    if (!project) return null;
    let version = (launches.get(project.ticker)?.count ?? 0) + 1;
    let ticker = `${project.ticker.slice(0, 4)}${version}`;
    while (this.state.projects[ticker]) ticker = `${project.ticker.slice(0, 4)}${++version}`;
    return { project, ticker, name: `${project.name} v${version}` };
  }

  private async findCreated(p: ProjectState): Promise<void> {
    const builder = this.persona(p.builder);
    try {
      const from = BigInt(p.createFromBlock!);
      const created = await this.logs(
        this.d.dep.factory,
        'RaiseCreated',
        { builder: builder.address },
        from,
        from + RECOVER_BLOCKS,
      );
      for (const entry of created) {
        const receipt = await this.d.chain.retry('getTransactionReceipt', () =>
          this.d.chain.client.getTransactionReceipt({ hash: entry.transactionHash as Hex }),
        );
        if (this.adopt(p, receipt)) {
          log.info('recovered-raise', { project: p.ticker, raise: p.raise });
          return;
        }
      }
    } catch (error) {
      log.warn('recover-raise-skipped', { project: p.ticker, error: errorText(error) });
    }
  }

  /** Attach the raise created by `receipt` if it is this project's (matched by symbol). */
  private adopt(p: ProjectState, receipt: TransactionReceipt): boolean {
    const decoded = events(receipt, FactoryAbi);
    const configured = decoded.find((e) => e.eventName === 'RaiseConfigured' && e.args.symbol === p.ticker);
    const created = decoded.find(
      (e) => e.eventName === 'RaiseCreated' && configured && e.args.raise === configured.args.raise,
    );
    if (!configured || !created) return false;
    const m = created.args.modules;
    p.raise = getAddress(created.args.raise);
    p.modules = { token: m.token, vesting: m.vesting, governor: m.governor, claims: m.claims, adapter: m.adapter };
    p.treasury = getAddress(configured.args.config.treasury);
    p.createdBlock = Number(receipt.blockNumber);
    p.createTx = receipt.transactionHash;
    return true;
  }

  private async create(p: ProjectState): Promise<void> {
    if (p.raise) return;
    // A previous attempt may have landed after its receipt wait gave up: never create the same project twice.
    if (p.createFromBlock !== undefined) {
      await this.findCreated(p);
      if (p.raise) return;
    }
    const project = this.catalog(p);
    const builder = this.persona(p.builder);
    const { supply, targetPrice } = sizing(project);
    const templateId = p.template === 'BUDGET_LAUNCH' ? this.d.dep.budgetTemplate : this.d.dep.escrowTemplate;
    const config = {
      quote: this.d.dep.quote,
      treasury: zeroAddress,
      supply,
      targetPrice,
      budgetCeiling: p.template === 'BUDGET_LAUNCH' ? BigInt(project.budgetCeilingBps ?? 2000) * 10n ** 14n : 0n,
      stage1Length: BigInt(p.stage1Length),
      stage2Length: BigInt(p.stage2Length),
      builders: [],
    };
    p.createFromBlock = Number(this.head);
    this.save();
    const receipt = await this.tx(
      builder,
      {
        address: this.d.dep.factory,
        abi: FactoryAbi,
        functionName: 'createRaise',
        args: [templateId, this.params[p.template].version, config, { name: p.name ?? project.name, symbol: p.ticker }],
      },
      'create-raise',
      p,
      {
        name: p.name ?? project.name,
        template: p.template,
        fate: p.fate,
        stage1: fmtDur(p.stage1Length),
        stage2: fmtDur(p.stage2Length),
      },
    );
    if (!receipt) return;
    if (!this.adopt(p, receipt)) throw new Error('create-raise receipt has no RaiseCreated for this project');
    const block = await this.d.chain.retry('getBlock', () =>
      this.d.chain.client.getBlock({ blockNumber: receipt.blockNumber }),
    );
    p.createdAt = Number(block.timestamp);
    log.info('launched', {
      project: p.ticker,
      raise: p.raise,
      fate: p.fate,
      template: p.template,
      hold: p.hold ?? undefined,
    });
    this.save();
  }

  // ------------------------------------------------------------------ per project

  /** State key: the ticker for catalog projects, `ext:<address>` for raises created by others. */
  private key(p: ProjectState): string {
    return p.external ? `ext:${p.raise!.toLowerCase()}` : p.ticker;
  }

  private async step(p: ProjectState): Promise<void> {
    const snap = await raiseSnapshot(this.d.chain, p.raise as Address, this.now);
    this.snaps.set(this.key(p), snap);
    if (snap.phase !== p.lastPhase) {
      log.info('phase', { project: p.ticker, from: p.lastPhase ?? '-', to: snap.phase, raise: p.raise });
      p.lastPhase = snap.phase;
      p.phaseSince = this.now;
    }
    if (p.external) return this.external(p, snap);
    switch (snap.phase) {
      case 'Stage1':
        await this.reviews(p, snap);
        await this.stage1(p, snap);
        break;
      case 'Stage2':
        await this.stage2(p, snap);
        break;
      case 'ListingPending':
        await this.listingPending(p);
        break;
      case 'Stage3':
        await this.stage3(p, snap);
        break;
      case 'Dissolved':
        await this.dissolved(p);
        break;
    }
    await this.attempt('offchain', p, () => this.offchain(p, snap));
  }

  private open(p: ProjectState, kinds?: Persona['kind'][]): PositionRecord[] {
    return p.positions.filter(
      (x) => !x.closed && x.class === 'Backer' && (!kinds || kinds.includes(this.persona(x.owner).kind)),
    );
  }

  // ---- Stage 1

  private async stage1(p: ProjectState, snap: RaiseSnapshot): Promise<void> {
    const prm = this.params[p.template];
    const builder = this.persona(p.builder);
    if (this.now >= snap.stage1End) {
      if (p.hold === 'Stage1') return;
      if (snap.vetoUntil > this.now) {
        this.once(`veto:${p.ticker}:${snap.vetoUntil}`, () =>
          log.info('veto-wait', { project: p.ticker, until: snap.vetoUntil }),
        );
        return;
      }
      await this.keeper(
        p,
        builder,
        { address: p.raise!, abi: RaiseAbi, functionName: 'advanceStage1' },
        'advance-stage1',
      );
      return;
    }
    const L = snap.stage1End - snap.start;
    // Builders give up late in Stage 1 (60-85% of it), once it is clear the raise will not fill.
    const giveUpAt = 0.6 + (hash(`dissolve:${p.ticker}`) % 26) / 100;
    if (
      p.fate === 'dissolve-builder' &&
      this.now >= snap.start + Math.max(prm.stage1Min, Math.floor(giveUpAt * L)) + this.config.tickSeconds
    ) {
      await this.keeper(p, builder, { address: p.raise!, abi: RaiseAbi, functionName: 'dissolve' }, 'builder-dissolve');
      return;
    }
    if (p.fate === 'graduate') {
      await this.fill(p, snap);
      await this.stage1Exit(p, snap);
    } else {
      await this.partial(p, snap);
    }
  }

  /** A persona's latest completed first-round review of this raise, if any. */
  private reviewOf(p: ProjectState, persona: number): ReviewRecord | undefined {
    return p.reviews?.find((r) => r.persona === persona && r.round === 0 && r.status === 'done');
  }

  /** A "back" decision that has not turned into a deposit yet. */
  private pendingBack(p: ProjectState, persona: number): ReviewRecord | undefined {
    const r = this.reviewOf(p, persona);
    return r && r.verdict === 'back' && (r.conviction ?? 0) >= this.ai.backConviction && !r.acted ? r : undefined;
  }

  private backerPool(p: ProjectState, fresh: boolean): Persona[] {
    const holders = new Set(this.open(p).map((x) => x.owner));
    // Personas whose due diligence said "pass" stay out of this raise.
    const pool = ofKind(this.d.personas, 'conservative', 'rollover', 'whale', 'voter').filter(
      (x) => x.index !== p.builder && this.reviewOf(p, x.index)?.verdict !== 'pass',
    );
    const eligible = fresh ? pool.filter((x) => !holders.has(x.index)) : pool;
    if (eligible.length) return eligible;
    return ofKind(this.d.personas, 'stage2', 'stage3').filter((x) => !fresh || !holders.has(x.index));
  }

  private async deposit(
    p: ProjectState,
    persona: Persona,
    amount: bigint,
  ): Promise<{ sold: bigint; debit: bigint } | null> {
    await this.ensureUsdg(persona, amount);
    await this.ensureApproval(persona, this.d.dep.quote, p.raise!, amount, p);
    const receipt = await this.guarded(persona, p, 'deposit', [amount, 0n], 'deposit', { amount: fmtUsd(amount) });
    const ev = events(receipt, RaiseAbi).find(
      (e) => e.eventName === 'Deposited' && getAddress(e.args.owner) === persona.address,
    );
    if (!ev) return null;
    p.positions.push({
      id: String(ev.args.id),
      owner: persona.index,
      class: Number(ev.args.class) === 2 ? 'Builder' : 'Backer',
    });
    return { sold: BigInt(ev.args.sold), debit: BigInt(ev.args.debit) };
  }

  /** Sell out the allocation by `fillBy` of Stage 1 with at least minimumBackers + 1 distinct backers. */
  private async fill(p: ProjectState, snap: RaiseSnapshot): Promise<void> {
    const prm = this.params[p.template];
    const alloc = snap.supply / 5n;
    const distinct = new Set(this.open(p).map((x) => x.owner)).size;
    if (
      snap.sold >= alloc &&
      distinct < prm.minimumBackers &&
      this.now < snap.stage1End - 2 * this.config.tickSeconds
    ) {
      // Sold out too early (outside deposits or rollovers): the largest holder trims at cost to make room for newcomers.
      const states = await Promise.all(
        this.open(p).map(async (x) => ({
          x,
          basis: BigInt((await this.d.chain.read<any>(p.raise!, RaiseAbi, 'positionState', [BigInt(x.id)])).basis),
        })),
      );
      const top = states.sort((a, b) => (b.basis > a.basis ? 1 : b.basis < a.basis ? -1 : 0))[0];
      if (top) {
        log.info('stage1-rebalance', { project: p.ticker, backers: distinct, needed: prm.minimumBackers });
        await this.exitPosition(p, top.x, false, true);
      }
      return;
    }
    const total = remainingFillCost(snap.targetPrice, snap.supply, 0n);
    const minDeposit = maxBig(usd(10), total / 100n);
    const fillAt = snap.start + Math.floor((snap.stage1End - snap.start) * p.fillBy);
    const t = clamp((this.now - snap.start) / Math.max(1, fillAt - snap.start), 0, 1);
    const desired = t >= 1 ? 1 : Math.pow(t, 0.85);
    let sold = snap.sold;
    // Distinct live backers among our personas (the contract's own count is not exposed); outside users only add to it.
    let backers = new Set(this.open(p).map((x) => x.owner)).size;
    for (let n = 0; n < (t >= 1 ? 6 : 2) && sold < alloc; n++) {
      if (t < 1 && Number((sold * 10_000n) / alloc) / 10_000 >= desired) break;
      const needed = Math.max(0, prm.minimumBackers + 1 - backers);
      const remaining = remainingFillCost(snap.targetPrice, snap.supply, sold);
      // Backers whose due diligence said "back" go first, with the amount they chose.
      const persona = this.r.weighted(
        this.backerPool(p, needed > 0),
        (x) => (this.pendingBack(p, x.index) ? 12 : 1) * (x.kind === 'whale' ? 0.5 : x.kind === 'voter' ? 1.3 : 1),
      );
      const decided = this.pendingBack(p, persona.index);
      let amount: bigint;
      if (needed <= 1 && (t >= 1 || remaining <= minDeposit * 2n)) {
        amount = remaining + 1n; // debits only the exact curve cost of the last tokens
      } else {
        // Around an even split of what is left among the backers still needed (plus one), never so large that the
        // later newcomers are squeezed out: each of them keeps at least half an even share.
        const even = Number(remaining) / Math.max(needed + 1, 2);
        const share = even * clamp(this.r.lognormal(1, 0.35) * (persona.kind === 'whale' ? 1.6 : 1), 0.4, 1.8);
        const reserve = BigInt(Math.max(0, needed - 1)) * maxBig(minDeposit, BigInt(Math.floor(even / 2)));
        const ceiling = remaining > reserve + minDeposit ? remaining - reserve : minDeposit;
        amount = clampBig(
          decided?.amountUsdg ? usd(decided.amountUsdg) : BigInt(Math.floor(share)),
          minDeposit,
          ceiling,
        );
        if (needed <= 1 && amount >= remaining) amount = remaining + 1n;
      }
      const isNew = !this.open(p).some((x) => x.owner === persona.index);
      const result = await this.attempt('deposit', p, async () => {
        const r = await this.deposit(p, persona, amount);
        if (r) {
          sold = r.sold;
          if (decided) {
            decided.acted = true;
            decided.deposited = String(r.debit);
            log.info('ai-deposit', {
              project: p.ticker,
              persona: persona.label,
              amount: fmtUsd(r.debit),
              conviction: decided.conviction,
            });
          }
        }
      });
      if (!result || this.d.dryRun) break;
      if (isNew) backers++;
    }
  }

  /** Dissolving projects: a few backers, never enough to pass the gates. */
  private async partial(p: ProjectState, snap: RaiseSnapshot): Promise<void> {
    const prm = this.params[p.template];
    const alloc = snap.supply / 5n;
    const maxBackers = Math.max(2, prm.minimumBackers - 4 - (hash(p.ticker) % 3));
    const ours = new Set(this.open(p).map((x) => x.owner)).size;
    if (ours >= maxBackers) return;
    const t = clamp((this.now - snap.start) / Math.max(1, 0.6 * (snap.stage1End - snap.start)), 0, 1);
    const desired = p.partialFill * t;
    if (Number((snap.sold * 10_000n) / alloc) / 10_000 >= desired) return;
    const total = remainingFillCost(snap.targetPrice, snap.supply, 0n);
    const amount = maxBig(
      usd(10),
      BigInt(Math.floor(((Number(total) * p.partialFill) / maxBackers) * this.r.lognormal(1, 0.35))),
    );
    const room = remainingFillCost(snap.targetPrice, snap.supply, snap.sold);
    // Rollover users like early projects; their dissolution claims later roll into another Stage 1.
    const persona = this.r.weighted(
      this.backerPool(p, true),
      (x) => (this.pendingBack(p, x.index) ? 12 : 1) * (x.kind === 'rollover' ? 3 : 1),
    );
    await this.attempt('deposit', p, async () => {
      const r = await this.deposit(p, persona, minBig(amount, room / 2n));
      const decided = this.pendingBack(p, persona.index);
      if (r && decided) Object.assign(decided, { acted: true, deposited: String(r.debit) });
    });
  }

  private async stage1Exit(p: ProjectState, snap: RaiseSnapshot): Promise<void> {
    const c = this.config.stage1;
    if (
      p.exits.stage1 >= c.maxExits ||
      this.now > snap.start + 0.55 * (snap.stage1End - snap.start) ||
      !this.chance(c.exitChancePerHour)
    )
      return;
    const candidates = this.open(p, ['conservative']);
    if (!candidates.length) return;
    const pos = this.r.pick(candidates);
    await this.exitPosition(p, pos, false, this.r.chance(0.4));
    p.exits.stage1++;
  }

  private async exitPosition(
    p: ProjectState,
    pos: PositionRecord,
    allowProfit: boolean,
    partial = false,
  ): Promise<void> {
    const owner = this.persona(pos.owner);
    const state = await this.d.chain.read<any>(p.raise!, RaiseAbi, 'positionState', [BigInt(pos.id)]);
    const tokens = BigInt(state.tokens);
    const basis = BigInt(state.basis);
    if (tokens === 0n) {
      pos.closed = 'exit';
      return;
    }
    const q = partial ? tokens / 2n : tokens;
    const cost = q === tokens ? basis : (basis * q) / tokens;
    if (allowProfit) {
      const quote = await this.d.chain.read<any>(p.raise!, RaiseAbi, 'protectedExitQuote', [BigInt(pos.id), q]);
      const payout = BigInt(quote.result?.payout ?? 0);
      if (quote.validity.available && payout > cost) {
        const min = maxBig(cost, (payout * 99n) / 100n);
        const ok = await this.attempt('protected-exit', p, () =>
          this.guarded(owner, p, 'protectedExit', [BigInt(pos.id), q, min], 'protected-exit', {
            position: pos.id,
            payout: fmtUsd(payout),
            basis: fmtUsd(cost),
          }),
        );
        if (ok && q === tokens) pos.closed = 'protected';
        return;
      }
    }
    const ok = await this.attempt('exit-at-cost', p, () =>
      this.guarded(owner, p, 'exitAtCost', [BigInt(pos.id), q, cost], 'exit-at-cost', {
        position: pos.id,
        basis: fmtUsd(cost),
        partial,
      }),
    );
    if (ok && q === tokens) pos.closed = 'exit';
  }

  // ---- Stage 2

  /** Cumulative traded USDG per market, and when trading started, to report average daily volume. */
  private addVolume(p: ProjectState, quote: bigint): void {
    p.market.volume = (p.market.volume ?? 0) + Number(quote) / 1e6;
    p.market.volumeSince ??= this.now;
  }

  /** This market's daily volume target in USDG (Stage 2 book, then Stage 3 pool), drawn once per project. */
  private dailyVolume(p: ProjectState): number {
    const v = this.config.volume;
    if (!p.market.dailyVolume) {
      const r = rng(`volume:${this.key(p)}`);
      p.market.dailyVolume = Math.round(clamp(r.lognormal(v.medianDailyUsdg, 0.6), v.dailyUsdg[0], v.dailyUsdg[1]));
    }
    return p.market.dailyVolume;
  }

  /**
   * Median trade size (USDG) that makes expected daily volume meet the target: volume = trades per day x mean trade,
   * where the mean folds in the lognormal spread (e^(sigma^2/2)), the burst share and the whales' larger tickets.
   * Sells recycle what was bought, so buys and sells together land near the target.
   */
  private medianTrade(
    p: ProjectState,
    quiet: number,
    burst: number,
    sigma: number,
    whaleMult: number,
    whaleWeight: number,
    otherWeight: number,
  ): number {
    const b = this.config.stage2;
    const burstShare = Math.min(0.9, (b.burstChancePerHour * (b.burstMinutes[0] + b.burstMinutes[1])) / 2 / 60);
    const perDay = 24 * (quiet * (1 - burstShare) + burst * burstShare) * this.tradeMultiplier();
    const mix = (otherWeight + whaleWeight * whaleMult) / (otherWeight + whaleWeight);
    return (this.dailyVolume(p) / Math.max(1, perDay) / Math.exp((sigma * sigma) / 2) / mix) * this.volumeBoost(p);
  }

  /**
   * Some chosen trades turn out empty (a seller without a balance, per-tick caps, slow chains), so each market
   * steers its own size multiplier toward its daily target once it has three hours of history, at most once an hour.
   */
  private volumeBoost(p: ProjectState): number {
    const m = p.market;
    m.volumeBoost ??= this.config.volume.initialBoost;
    if (m.volume && m.volumeSince && this.now - m.volumeSince >= 3 * 3600 && this.now - (m.boostAt ?? 0) >= 3600) {
      const realized = (m.volume / (this.now - m.volumeSince)) * 86400;
      m.volumeBoost = clamp(
        m.volumeBoost * clamp(Math.sqrt(this.dailyVolume(p) / Math.max(1, realized)), 0.8, 1.25),
        0.5,
        4,
      );
      m.boostAt = this.now;
    }
    return m.volumeBoost;
  }

  private tradeMultiplier() {
    return this.state.tempo.bootstrapDone ? this.config.steady.tradeMultiplier : this.config.bootstrap.tradeMultiplier;
  }

  /**
   * Mean-reverting mood (drift both ways) and occasional bursts of activity. The mood reverts toward the latest AI
   * read of the news flow (decaying over about six hours), so trading reacts to updates and feedback, not noise alone.
   */
  private async weather(p: ProjectState, burstChancePerHour: number): Promise<number> {
    const m = p.market;
    await this.sentiment(p);
    const anchor = (m.sentiment ?? 0) * Math.exp(-(this.now - (m.sentimentAt ?? this.now)) / (6 * 3600));
    m.mood = clamp(
      anchor + (m.mood - anchor) * Math.exp(-this.dt / 1800) + this.r.normal() * 0.35 * Math.sqrt(this.dt / 300),
      -1,
      1,
    );
    if (m.burst > 0) m.burst = Math.max(0, m.burst - this.dt);
    else if (this.chance(burstChancePerHour)) m.burst = Math.round(this.between(this.config.stage2.burstMinutes) * 60);
    return m.burst > 0 ? 1 : 0;
  }

  private async stage2(p: ProjectState, snap: RaiseSnapshot): Promise<void> {
    const c = this.config.stage2;
    const burst = await this.weather(p, c.burstChancePerHour);
    const rate = (burst ? c.burstTradesPerHour : c.quietTradesPerHour) * this.tradeMultiplier();
    const trades = Math.min(3, this.r.poisson((rate * this.dt) / 3600));
    const project = this.catalog(p);
    for (let i = 0; i < trades; i++) {
      const trader = this.r.weighted(
        ofKind(this.d.personas, 'stage2', 'whale', 'voter').filter((x) => x.index !== p.builder),
        (x) => (x.kind === 'stage2' ? 1 : x.kind === 'whale' ? 0.3 : 0.15),
      );
      const held = await this.d.chain.read<bigint>(p.raise!, RaiseAbi, 'buyerTokens', [trader.address]);
      const buy = held === 0n || this.r.chance(0.5 + 0.3 * p.market.mood);
      if (buy) {
        const median = this.medianTrade(
          p,
          c.quietTradesPerHour,
          c.burstTradesPerHour,
          c.sizeSigma,
          c.whaleMultiplier,
          0.3,
          1.15,
        );
        const size = median * this.r.lognormal(1, c.sizeSigma) * (trader.kind === 'whale' ? c.whaleMultiplier : 1);
        const amount = usd(clamp(size, 5, Math.min(project.raise * 0.3, this.dailyVolume(p) / 3)));
        await this.attempt('ledger-buy', p, async () => {
          await this.ensureUsdg(trader, amount);
          await this.ensureApproval(trader, this.d.dep.quote, p.raise!, amount, p);
          const receipt = await this.guarded(trader, p, 'buy', [amount, 0n], 'ledger-buy', {
            amount: fmtUsd(amount),
            mood: p.market.mood.toFixed(2),
          });
          p.market.trades++;
          if (receipt) this.addVolume(p, amount);
        });
      } else {
        // Sells are sized in USDG like buys (converted at the current book price), so volume tracks the target
        // instead of the size of a holder's bag.
        const median = this.medianTrade(
          p,
          c.quietTradesPerHour,
          c.burstTradesPerHour,
          c.sizeSigma,
          c.whaleMultiplier,
          0.3,
          1.15,
        );
        const target = usd(clamp(median * this.r.lognormal(1, c.sizeSigma), 5, this.dailyVolume(p) / 3));
        const probe = await this.d.chain.read<any>(p.raise!, RaiseAbi, 'marketBuyQuote', [usd(100)]).catch(() => null);
        const per100 = probe?.validity?.available ? BigInt(probe.tokens) : 0n;
        const q =
          per100 > 0n
            ? minBig(held, (per100 * target) / usd(100))
            : (held * BigInt(Math.round(clamp(this.r.lognormal(0.35, 0.6), 0.05, 1) * 10_000))) / 10_000n;
        if (q === 0n) continue;
        await this.attempt('ledger-sell', p, async () => {
          const receipt = await this.guarded(trader, p, 'sell', [q, 0n], 'ledger-sell', {
            tokens: formatEther(q),
            mood: p.market.mood.toFixed(2),
          });
          p.market.trades++;
          const sold = events(receipt, RaiseAbi).find((e) => e.eventName === 'MarketSold');
          if (sold) this.addVolume(p, BigInt(sold.args.trade.gross));
        });
      }
    }
    if (
      p.exits.stage2 < c.maxExits &&
      this.now < snap.stage2End - 2 * this.config.tickSeconds &&
      this.chance(c.exitChancePerHour)
    ) {
      const candidates = this.open(p, ['conservative', 'rollover']);
      if (candidates.length) {
        await this.exitPosition(p, this.r.pick(candidates), true);
        p.exits.stage2++;
      }
    }
    if (p.template === 'BUDGET_LAUNCH') await this.budget(p, snap);
  }

  /** Budget Launch: one or two builder draws, voted by backer positions, finalized and executed on schedule. */
  private async budget(p: ProjectState, snap: RaiseSnapshot): Promise<void> {
    const prm = this.params.BUDGET_LAUNCH;
    const gov = p.modules!.governor;
    const builder = this.persona(p.builder);
    const active = p.proposals.find((x) => x.kind === 'draw' && !x.closed);
    if (active) return this.followProposal(p, active);
    if (p.proposals.filter((x) => x.kind === 'draw').length >= this.config.governance.maxDraws) return;
    const [end, , remaining] = await this.d.chain.read<[bigint, bigint, bigint]>(p.raise!, RaiseAbi, 'governanceState');
    const window = prm.voting + prm.dispute + prm.execution;
    const slack = Number(end) - this.now - window;
    if (slack < 2 * this.config.tickSeconds) return;
    if (this.now < snap.stage2Start + Math.min(300, slack / 3)) return;
    const last = Number(await this.d.chain.read<bigint>(gov, GovAbi, 'lastProposalAt'));
    if (last && this.now < last + prm.proposalInterval) return;
    const capital = await this.d.chain.read<bigint>(p.raise!, RaiseAbi, 'eligibleCapital');
    const maxShare = this.config.governance.budgetDrawShareOfCapital;
    let amount = minBig(remaining, (capital * BigInt(Math.round(maxShare * 10_000))) / 10_000n);
    if (amount < usd(1)) return;
    const n = p.proposals.filter((x) => x.kind === 'draw').length + 1;
    const written = await this.writeProposal(p, 'Budget draw', capital, [maxShare / 4, maxShare], n);
    if (written === 'pending') return;
    if (written) amount = minBig(remaining, (capital * BigInt(Math.round(written.amountShare * 1e6))) / 1_000_000n);
    await this.attempt('propose-draw', p, async () => {
      const receipt = await this.tx(
        builder,
        {
          address: gov,
          abi: GovAbi,
          functionName: 'propose',
          args: [amount, `https://${this.catalog(p).slug}.example/milestones/${n}`],
        },
        'propose-draw',
        p,
        { amount: fmtUsd(amount) },
      );
      const ev = events(receipt, GovAbi).find((e) => e.eventName === 'Proposed');
      if (ev) {
        p.proposals.push({
          id: String(ev.args.proposal),
          kind: 'draw',
          voters: [],
          proposedBlock: Number(receipt!.blockNumber),
        });
        if (written) await this.announceProposal(p, 'Budget draw', String(ev.args.proposal), amount, written);
      }
    });
  }

  /**
   * AI-written proposal (title, rationale, size within bounds) for a mock builder. 'pending' means ask again next
   * tick; null means use the template amount without an announcement.
   */
  private async writeProposal(
    p: ProjectState,
    kind: 'Budget draw' | 'Treasury spend',
    pool: bigint,
    share: [number, number],
    n: number,
  ): Promise<{ title: string; rationale: string; amountShare: number } | null | 'pending'> {
    if (!this.d.mind.enabled || this.d.dryRun || p.external) return null;
    const facts = await this.facts(p);
    if (!facts) return null;
    const res = await this.d.mind.proposal(
      `prop:${p.raise}:${kind}:${n}`,
      this.brief(p),
      facts,
      { kind, poolUsdg: Number(pool) / 1e6, share, n },
      this.aiWait,
    );
    if (res.state === 'pending') return 'pending';
    return res.state === 'done' ? res.value : null;
  }

  private async announceProposal(
    p: ProjectState,
    kind: string,
    id: string,
    amount: bigint,
    text: { title: string; rationale: string },
  ): Promise<void> {
    await this.attempt('announce-proposal', p, async () => {
      await this.d.api.postUpdate(this.persona(p.builder).account, p.raise!, {
        title: `${kind} proposal #${id}: ${text.title}`.slice(0, 200),
        body: `${text.rationale}\n\nAmount: ${fmtUsd(amount)}. Backers vote on-chain; the full schedule is on the proposal.`,
        kind: 'update',
      });
      log.info('proposal-announced', { project: p.ticker, kind, id, title: text.title });
    });
  }

  private async followProposal(p: ProjectState, rec: ProposalRecord): Promise<void> {
    const gov = p.modules!.governor;
    const prop = await this.d.chain.read<any>(gov, GovAbi, 'getProposal', [BigInt(rec.id)]);
    const status = STATUSES[Number(prop.status)];
    const keeperCall = (functionName: string): Call => ({
      address: gov,
      abi: GovAbi,
      functionName,
      args: [BigInt(rec.id)],
    });
    const keep = !p.external || this.ai.externalKeeper;
    if (status === 'Active') {
      if (this.now < Number(prop.votingEnds))
        await (rec.kind === 'draw' ? this.capitalVotes(p, rec, prop) : this.tokenVotes(p, rec, prop));
      else if (keep && (await this.keeper(p, this.keeperPersona(), keeperCall('finalize'), `finalize-${rec.kind}`)))
        rec.finalized = true;
    } else if (status === 'Passed') {
      if (keep && this.now >= Number(prop.disputeEnds) && this.now < Number(prop.executeEnds)) {
        if (await this.keeper(p, this.keeperPersona(), keeperCall('execute'), `execute-${rec.kind}`))
          rec.executed = true;
      }
    } else {
      rec.closed = true;
      log.info('proposal-closed', {
        project: p.ticker,
        kind: rec.kind,
        id: rec.id,
        status,
        yes: String(prop.yesWeight),
        no: String(prop.noWeight),
      });
    }
  }

  /**
   * Voting decisions per persona: AI judgment of the proposal (amount, budget, progress, updates) when available,
   * otherwise the template (governance voters and most backers support; NO never exceeds 30% of the weight cast).
   * Returns false while an AI answer is still pending.
   */
  private async decide(
    p: ProjectState,
    rec: ProposalRecord,
    prop: any,
    voters: { persona: Persona; weight: bigint }[],
    pool: bigint,
  ): Promise<boolean> {
    rec.decisions ??= {};
    const missing = voters.filter((v) => !rec.decisions![v.persona.label]);
    if (!missing.length) return true;
    if (this.d.mind.enabled && !this.d.dryRun) {
      const facts = await this.facts(p);
      if (facts) {
        const proposal = await this.proposalFacts(p, rec, prop);
        const res = await this.d.mind.votes(
          `votes:${p.raise}:${rec.id}:${Object.keys(rec.decisions).length}`,
          missing.map((v) => ({
            key: v.persona.label,
            mind: mindFor(v.persona),
            weightPct: pool > 0n ? Math.round(Number((v.weight * 10_000n) / pool) / 100) : 0,
          })),
          facts,
          proposal,
          this.aiWait,
        );
        if (res.state === 'pending') return false;
        if (res.state === 'done' && res.value) {
          for (const v of res.value.votes) {
            rec.decisions[v.voter] = { vote: v.vote, reason: v.reason, source: 'ai' };
            log.info('vote-decision', {
              project: p.ticker,
              proposal: rec.id,
              kind: rec.kind,
              voter: v.voter,
              vote: v.vote,
              reason: v.reason,
            });
          }
          return true;
        }
      }
    }
    const g = this.config.governance;
    let yes = BigInt(prop.yesWeight);
    let no = BigInt(prop.noWeight);
    for (const v of missing) {
      let support = v.persona.kind === 'voter' || this.r.chance(g.yesChance);
      if (!support && (no + v.weight) * 10n > (yes + no + v.weight) * 3n) support = true;
      if (support) yes += v.weight;
      else no += v.weight;
      rec.decisions[v.persona.label] = { vote: support ? 'yes' : 'no', reason: 'template', source: 'template' };
    }
    return true;
  }

  private async proposalFacts(p: ProjectState, rec: ProposalRecord, prop: any): Promise<ProposalFacts> {
    const amount = BigInt(prop.amount ?? 0);
    let pool = BigInt(prop.capitalSnapshot ?? 0);
    let remaining: bigint | null = null;
    if (rec.kind === 'draw') {
      remaining = (await this.d.chain.read<[bigint, bigint, bigint]>(p.raise!, RaiseAbi, 'governanceState'))[2];
    } else {
      const treasury = p.treasury ?? (await this.d.chain.read<any>(p.raise!, RaiseAbi, 'getConfig')).treasury;
      pool = await this.d.chain.read<bigint>(treasury, TreasuryAbi, 'availableQuote');
    }
    return {
      id: rec.id,
      kind: rec.kind === 'draw' ? 'Budget draw' : 'Treasury spend',
      amountUsdg: Number(amount) / 1e6,
      shareOfPoolPct: pool > 0n ? Math.round(Number((amount * 10_000n) / pool) / 100) : 0,
      poolUsdg: Math.round(Number(pool) / 1e6),
      remainingCeilingUsdg: remaining === null ? null : Math.round(Number(remaining) / 1e6),
      votingHoursLeft: Math.max(0, Math.round(((Number(prop.votingEnds) - this.now) / 3600) * 10) / 10),
      uri: String(prop.uri ?? '').slice(0, 120),
    };
  }

  /** Stage 2 capital votes, one per eligible backer position, following each owner's decision. */
  private async capitalVotes(p: ProjectState, rec: ProposalRecord, prop: any): Promise<void> {
    const g = this.config.governance;
    const open = this.open(p).filter((x) => !rec.voters.includes(x.id));
    const weights = await Promise.all(
      open.map(async (pos) => {
        const [, weight, eligible] = await this.d.chain.read<[string, bigint, boolean]>(
          p.raise!,
          RaiseAbi,
          'votingPosition',
          [BigInt(pos.id)],
        );
        return { pos, weight: eligible ? BigInt(weight) : 0n };
      }),
    );
    for (const w of weights) if (w.weight === 0n) rec.voters.push(w.pos.id);
    const eligible = weights.filter((w) => w.weight > 0n);
    const byOwner = new Map<number, bigint>();
    for (const w of eligible) byOwner.set(w.pos.owner, (byOwner.get(w.pos.owner) ?? 0n) + w.weight);
    const voters = [...byOwner].map(([owner, weight]) => ({ persona: this.persona(owner), weight }));
    if (!(await this.decide(p, rec, prop, voters, BigInt(prop.capitalSnapshot ?? 0)))) return;
    const pending = this.r
      .shuffle(eligible)
      .sort(
        (a, b) =>
          Number(this.persona(b.pos.owner).kind === 'voter') - Number(this.persona(a.pos.owner).kind === 'voter'),
      );
    for (const { pos } of pending.slice(0, g.votesPerTick)) {
      const owner = this.persona(pos.owner);
      const decision = rec.decisions![owner.label];
      if (!decision || decision.vote === 'abstain') {
        rec.voters.push(pos.id);
        if (decision)
          log.info('vote-abstain', {
            project: p.ticker,
            proposal: rec.id,
            voter: owner.label,
            reason: decision.reason,
          });
        continue;
      }
      const support = decision.vote === 'yes';
      const ok = await this.attempt('vote', p, () =>
        this.tx(
          owner,
          {
            address: p.modules!.governor,
            abi: GovAbi,
            functionName: 'vote',
            args: [BigInt(rec.id), BigInt(pos.id), support],
          },
          'vote',
          p,
          { proposal: rec.id, position: pos.id, support, source: decision.source },
        ),
      );
      rec.voters.push(pos.id);
      if (!ok) log.debug('vote-not-cast', { project: p.ticker, proposal: rec.id });
    }
  }

  // ---- listing

  private async listingPending(p: ProjectState): Promise<void> {
    if (p.hold === 'ListingPending') return;
    await this.keeper(p, this.keeperPersona(), { address: p.raise!, abi: RaiseAbi, functionName: 'list' }, 'list');
  }

  // ---- Stage 3

  private holders(p: ProjectState): Persona[] {
    const owners = new Set(p.positions.map((x) => x.owner));
    if (p.external) return this.d.personas.filter((x) => owners.has(x.index));
    return this.d.personas.filter(
      (x) =>
        x.index !== p.builder &&
        (owners.has(x.index) || x.kind === 'stage3' || x.kind === 'stage2' || x.kind === 'whale'),
    );
  }

  private async stage3(p: ProjectState, snap: RaiseSnapshot): Promise<void> {
    if (!p.listedSeen) {
      p.listedSeen = true;
      for (const pos of p.positions) if (!pos.closed) pos.closed = 'listed';
      log.info('listed', { project: p.ticker, raise: p.raise, token: p.modules?.token });
    }
    await this.swaps(p);
    if (this.chance(this.config.stage3.rewardClaimChancePerHour)) {
      const owners = [...new Set(p.positions.map((x) => x.owner))].map((i) => this.persona(i));
      if (owners.length) {
        const who = this.r.pick(owners);
        const [tokens, quote] = await this.d.chain.read<[bigint, bigint]>(
          p.modules!.token,
          TokenAbi,
          'pendingRewards',
          [who.address],
        );
        if (tokens + quote > 0n)
          await this.attempt('claim-rewards', p, () =>
            this.tx(
              who,
              { address: p.modules!.token, abi: TokenAbi, functionName: 'claimRewards' },
              'claim-rewards',
              p,
            ),
          );
      }
    }
    await this.treasury(p, snap);
  }

  private async swaps(p: ProjectState): Promise<void> {
    const router = this.d.dep.router;
    if (!router) {
      this.once('norouter', () => log.info('stage3-swaps-skipped', { reason: 'no router in the deployment manifest' }));
      return;
    }
    const c = this.config.stage3;
    const burst = await this.weather(p, this.config.stage2.burstChancePerHour);
    const n = Math.min(
      3,
      this.r.poisson(((burst ? c.burstSwapsPerHour : c.quietSwapsPerHour) * this.tradeMultiplier() * this.dt) / 3600),
    );
    const token = p.modules!.token;
    for (let i = 0; i < n; i++) {
      const trader = this.r.weighted(this.holders(p), (x) =>
        x.kind === 'stage3' ? 1 : x.kind === 'whale' ? 0.3 : 0.4,
      );
      const balance = await this.d.chain.read<bigint>(token, TokenAbi, 'balanceOf', [trader.address]);
      const isTrader = trader.kind === 'stage3' || trader.kind === 'whale';
      const buy = balance === 0n ? isTrader : this.r.chance(isTrader ? 0.5 + 0.3 * p.market.mood : 0.15);
      if (!buy && balance === 0n) continue;
      const median = this.medianTrade(
        p,
        c.quietSwapsPerHour,
        c.burstSwapsPerHour,
        c.sizeSigma,
        c.whaleMultiplier,
        0.3,
        1.4,
      );
      const size = usd(
        clamp(
          median * this.r.lognormal(1, c.sizeSigma) * (trader.kind === 'whale' ? c.whaleMultiplier : 1),
          5,
          this.dailyVolume(p) / 3,
        ),
      );
      let amountIn = size;
      if (!buy) {
        // Sell about `size` USDG worth (converted at the pool price), never more than the holder has.
        const per100 = await this.d.chain
          .simulate<bigint>(trader.address, {
            address: router,
            abi: SwapRouterAbi as Abi,
            functionName: 'quoteExactIn',
            args: [token, true, usd(100)],
          })
          .catch(() => 0n);
        amountIn =
          per100 > 0n
            ? minBig(balance, (per100 * size) / usd(100))
            : (balance * BigInt(Math.round(clamp(this.r.lognormal(0.3, 0.6), 0.05, 1) * 10_000))) / 10_000n;
      }
      if (amountIn === 0n) continue;
      await this.attempt(buy ? 'swap-buy' : 'swap-sell', p, async () => {
        if (buy) await this.ensureUsdg(trader, amountIn);
        await this.ensureApproval(trader, buy ? this.d.dep.quote : token, router, amountIn, p);
        const out = await this.d.chain.simulate<bigint>(trader.address, {
          address: router,
          abi: SwapRouterAbi as Abi,
          functionName: 'quoteExactIn',
          args: [token, buy, amountIn],
        });
        if (out === 0n) return;
        await this.tx(
          trader,
          {
            address: router,
            abi: SwapRouterAbi as Abi,
            functionName: 'swapExactIn',
            args: [token, buy, amountIn, (out * 97n) / 100n, trader.address, this.deadline()],
          },
          buy ? 'swap-buy' : 'swap-sell',
          p,
          buy ? { amount: fmtUsd(amountIn) } : { tokens: formatEther(amountIn) },
        );
        p.market.swaps++;
        this.addVolume(p, buy ? amountIn : out);
      });
    }
  }

  /** Stage 3 treasury: builder proposes a small USDG spend; token holders vote; finalize and execute on schedule. */
  private async treasury(p: ProjectState, snap: RaiseSnapshot): Promise<void> {
    const g = this.config.governance;
    const prm = this.params[p.template];
    const active = p.proposals.find((x) => x.kind === 'spend' && !x.closed);
    if (active) return this.followProposal(p, active);
    if (p.proposals.filter((x) => x.kind === 'spend').length >= g.maxTreasuryProposals) return;
    if (this.now < snap.listedAt + g.treasuryDelayMinutes * 60) return;
    const gov = p.modules!.governor;
    const last = Number(await this.d.chain.read<bigint>(gov, GovAbi, 'lastProposalAt'));
    if (last && this.now < last + prm.proposalInterval) return;
    const treasury = p.treasury ?? (await this.d.chain.read<any>(p.raise!, RaiseAbi, 'getConfig')).treasury;
    let available = await this.d.chain.read<bigint>(treasury, TreasuryAbi, 'availableQuote');
    if (available < usd(2)) {
      const fees = await this.d.chain.read<[bigint, bigint, bigint]>(p.raise!, RaiseAbi, 'feeAccruals');
      if (fees[2] > 0n)
        await this.attempt('claim-treasury-fees', p, () =>
          this.tx(
            this.keeperPersona(),
            { address: p.raise!, abi: RaiseAbi, functionName: 'claimTreasuryFees' },
            'claim-treasury-fees',
            p,
          ),
        );
      available = await this.d.chain.read<bigint>(treasury, TreasuryAbi, 'availableQuote');
    }
    if (available < usd(2)) {
      this.once(`notreasury:${p.ticker}`, () => log.info('treasury-empty', { project: p.ticker }));
      return;
    }
    // Size the spend for the voters who will actually vote (the largest holders, voters first), at 70% YES.
    const balances = await Promise.all(
      this.holders(p).map(async (x) => ({
        x,
        b: await this.d.chain.read<bigint>(p.modules!.token, TokenAbi, 'balanceOf', [x.address]),
      })),
    );
    const held = balances
      .filter((v) => v.b > 0n)
      .sort(
        (a, b) => Number(b.x.kind === 'voter') - Number(a.x.kind === 'voter') || (b.b > a.b ? 1 : b.b < a.b ? -1 : 0),
      )
      .slice(0, g.maxTokenVoters)
      .reduce((sum, v) => sum + v.b, 0n);
    if (held === 0n) return;
    const [value, capBps] = await Promise.all([
      this.d.chain.read<bigint>(gov, GovAbi, 'quoteValue', [(held * 7n) / 10n]),
      this.d.chain.read<number>(gov, GovAbi, 'spendCapBps'),
    ]);
    const cap = (value * BigInt(capBps)) / 10_000n;
    const amount = minBig((available * 4n) / 10n, (cap * BigInt(Math.round(g.treasurySpendShareOfCap * 100))) / 100n);
    if (amount < usd(1)) {
      this.once(`smallspend:${p.ticker}`, () =>
        log.info('treasury-spend-too-small', { project: p.ticker, available: fmtUsd(available), cap: fmtUsd(cap) }),
      );
      return;
    }
    const builder = this.persona(p.builder);
    const n = p.proposals.filter((x) => x.kind === 'spend').length + 1;
    const maxShare = Number((amount * 1_000_000n) / available) / 1e6;
    const written = await this.writeProposal(p, 'Treasury spend', available, [maxShare * 0.3, maxShare], n);
    if (written === 'pending') return;
    const spend = written
      ? minBig(amount, (available * BigInt(Math.round(written.amountShare * 1e6))) / 1_000_000n)
      : amount;
    if (spend < usd(1)) return;
    await this.attempt('propose-spend', p, async () => {
      const receipt = await this.tx(
        builder,
        {
          address: gov,
          abi: GovAbi,
          functionName: 'proposeSpend',
          args: [builder.address, spend, 0n, `https://${this.catalog(p).slug}.example/treasury/${n}`],
        },
        'propose-spend',
        p,
        { amount: fmtUsd(spend) },
      );
      const ev = events(receipt, GovAbi).find((e) => e.eventName === 'Proposed');
      if (ev) {
        p.proposals.push({
          id: String(ev.args.proposal),
          kind: 'spend',
          voters: [],
          proposedBlock: Number(receipt!.blockNumber),
        });
        if (written) await this.announceProposal(p, 'Treasury spend', String(ev.args.proposal), spend, written);
      }
    });
  }

  private async tokenVotes(p: ProjectState, rec: ProposalRecord, prop: any): Promise<void> {
    if (rec.proposedBlock !== undefined && this.head <= BigInt(rec.proposedBlock)) return; // balances count at the end of the proposal block
    const g = this.config.governance;
    const counted = rec.voters.filter((v) => !v.startsWith('-')).length;
    if (counted >= g.maxTokenVoters) return;
    let yes = BigInt(prop.yesWeight);
    let no = BigInt(prop.noWeight);
    const gov = p.modules!.governor;
    const unchecked = this.holders(p).filter(
      (x) => !rec.voters.includes(String(x.index)) && !rec.voters.includes(`-${x.index}`),
    );
    const powers = await Promise.all(
      unchecked.map(async (x) => ({
        x,
        power: await this.d.chain.read<bigint>(gov, GovAbi, 'votingPower', [BigInt(rec.id), x.address]),
      })),
    );
    for (const { x, power } of powers) if (power === 0n) rec.voters.push(`-${x.index}`); // holders without a snapshot balance
    const candidates = powers
      .filter((v) => v.power > 0n)
      .sort(
        (a, b) =>
          Number(b.x.kind === 'voter') - Number(a.x.kind === 'voter') ||
          (b.power > a.power ? 1 : b.power < a.power ? -1 : 0),
      )
      .slice(0, g.maxTokenVoters - counted);
    const pool = candidates.reduce((sum, v) => sum + v.power, 0n);
    if (
      !(await this.decide(
        p,
        rec,
        prop,
        candidates.map((v) => ({ persona: v.x, weight: v.power })),
        pool,
      ))
    )
      return;
    // The largest holders vote first (governance voters ahead of everyone), up to maxTokenVoters in total.
    const ranked = powers
      .filter((v) => v.power > 0n)
      .sort(
        (a, b) =>
          Number(b.x.kind === 'voter') - Number(a.x.kind === 'voter') ||
          (b.power > a.power ? 1 : b.power < a.power ? -1 : 0),
      )
      .slice(0, Math.min(g.votesPerTick, g.maxTokenVoters - counted));
    for (const { x: voter, power } of ranked) {
      const decision = rec.decisions?.[voter.label];
      if (!decision || decision.vote === 'abstain') {
        rec.voters.push(String(voter.index));
        if (decision)
          log.info('vote-abstain', {
            project: p.ticker,
            proposal: rec.id,
            voter: voter.label,
            reason: decision.reason,
          });
        continue;
      }
      const support = decision.vote === 'yes';
      const ok = await this.attempt('vote-tokens', p, () =>
        this.tx(
          voter,
          { address: gov, abi: GovAbi, functionName: 'voteWithTokens', args: [BigInt(rec.id), support] },
          'vote-tokens',
          p,
          { proposal: rec.id, support, source: decision.source },
        ),
      );
      rec.voters.push(String(voter.index));
      if (ok) {
        if (support) yes += power;
        else no += power;
      }
    }
  }

  // ---- AI: facts, due diligence, conviction reviews

  /** Public facts for prompts, fetched at most once per tick per raise (null when the API cannot answer). */
  private async facts(p: ProjectState): Promise<RaiseFacts | null> {
    const hit = this.factsCache.get(p.raise!);
    if (hit && hit.tick === this.state.tick) return hit.facts;
    let facts: RaiseFacts | null = null;
    try {
      facts = await raiseFacts(this.d.api, p.raise!, this.params[p.template].minimumBackers);
    } catch (error) {
      this.once(`facts:${p.raise}:${this.state.tick}`, () =>
        log.warn('facts-unavailable', { project: p.ticker, error: errorText(error) }),
      );
    }
    this.factsCache.set(p.raise!, { tick: this.state.tick, facts });
    return facts;
  }

  private brief(p: ProjectState, seed?: { title: string; body: string }): CatalogBrief {
    const c = this.catalog(p);
    return {
      name: c.name,
      category: c.category,
      pitch: c.pitch,
      description: c.description.join('\n\n'),
      seedTitle: seed?.title ?? '',
      seedBody: seed?.body ?? '',
    };
  }

  /** 2-4 reviewers per raise, staggered over the first 60% of what is left of Stage 1. */
  private scheduleReviews(p: ProjectState, snap: RaiseSnapshot): void {
    if (p.reviews) return;
    const r = rng(`reviews:${p.raise}:${this.state.rngSeed}`);
    const [lo, hi] = this.ai.reviewersPerRaise;
    const n = r.int(lo, hi);
    const pool = r.shuffle(
      ofKind(this.d.personas, 'conservative', 'rollover', 'whale', 'voter').filter((x) => x.index !== p.builder),
    );
    const from = Math.max(this.now, snap.start);
    const span = Math.max(60, snap.stage1End - from);
    p.reviews = pool.slice(0, n).map((persona, i) => ({
      persona: persona.index,
      round: 0,
      status: 'scheduled' as const,
      dueAt: Math.floor(from + span * (0.04 + (0.5 * i) / Math.max(1, n - 1) + r.range(0, 0.05))),
    }));
    log.info('reviews-scheduled', {
      project: p.ticker,
      reviewers: p.reviews.map((x) => this.persona(x.persona).label).join(','),
    });
  }

  /** Stage 1: schedule due diligence for this raise, then run whatever reviews are due. */
  private async reviews(p: ProjectState, snap: RaiseSnapshot): Promise<void> {
    if (!this.d.mind.enabled || this.d.dryRun || this.now >= snap.stage1End) return;
    this.scheduleReviews(p, snap);
    await this.processReviews(p, snap);
  }

  private async processReviews(p: ProjectState, snap: RaiseSnapshot): Promise<void> {
    if (!this.d.mind.enabled || this.d.dryRun || !p.reviews) return;
    const due = p.reviews.filter((r) => r.status === 'scheduled' && this.now >= r.dueAt).slice(0, 2);
    if (!due.length) return;
    const facts = await this.facts(p);
    if (!facts) return;
    for (const rec of due) await this.attempt('review', p, () => this.review(p, snap, rec, facts));
  }

  /** USDG a persona still has in this raise (sum of open position bases). */
  private async heldUsdg(p: ProjectState, persona: Persona): Promise<number> {
    const states = await Promise.all(
      this.open(p)
        .filter((x) => x.owner === persona.index)
        .map((x) => this.d.chain.read<any>(p.raise!, RaiseAbi, 'positionState', [BigInt(x.id)])),
    );
    return states.reduce((sum, s) => sum + Number(s.basis) / 1e6, 0);
  }

  /** What the personas may still put into a user's raise: the cap share of its sell-out cost, minus what they hold. */
  private externalRoom(p: ProjectState, snap: RaiseSnapshot): bigint {
    const sellOut = remainingFillCost(snap.targetPrice, snap.supply, 0n);
    const cap = (sellOut * BigInt(Math.round(this.ai.externalCapShare * 10_000))) / 10_000n;
    const used = BigInt(p.externalDeposited ?? '0');
    const room = remainingFillCost(snap.targetPrice, snap.supply, snap.sold);
    return minBig(cap > used ? cap - used : 0n, room);
  }

  private async review(p: ProjectState, snap: RaiseSnapshot, rec: ReviewRecord, facts: RaiseFacts): Promise<void> {
    const persona = this.persona(rec.persona);
    const mind = mindFor(persona);
    const held = rec.round > 0 ? await this.heldUsdg(p, persona) : undefined;
    if (rec.round > 0 && !held) {
      rec.status = 'done';
      rec.at = this.now;
      return;
    }
    const room = p.external ? Number(this.externalRoom(p, snap)) / 1e6 : mind.ticket[1];
    const res = await this.d.mind.diligence(
      `dd:${p.raise}:${persona.index}:${rec.round}`,
      mind,
      facts,
      room,
      this.aiWait,
      held,
    );
    if (res.state === 'pending') return;
    if (res.state === 'error') {
      rec.dueAt = this.now + 300;
      return;
    }
    rec.status = 'done';
    rec.at = this.now;
    const d = res.value;
    if (d) {
      Object.assign(rec, {
        source: 'ai',
        verdict: d.verdict,
        conviction: d.conviction,
        amountUsdg: d.amountUsdg,
        rating: d.rating,
        feedback: d.feedback,
        question: d.question,
      });
    } else if (!p.external && rec.round === 0) {
      // Catalog projects keep today's template behaviour when there is no AI answer.
      const project = this.catalog(p);
      const texts = FEEDBACK[project.category];
      const back = this.r.chance(0.7);
      Object.assign(rec, {
        source: 'template',
        verdict: back ? 'back' : 'watch',
        conviction: back ? 0.6 : 0.45,
        amountUsdg: back ? Math.round((mind.ticket[0] + mind.ticket[1]) / 2) : 0,
        rating: this.r.int(3, 5),
        feedback: texts[(p.feedbackPosted + rec.persona) % texts.length],
      });
    } else {
      // No canned text on real users' projects: without an AI answer the persona just keeps watching.
      Object.assign(rec, { source: 'template', verdict: 'watch', conviction: 0.5 });
    }
    log.info(rec.round ? 'conviction-review' : 'diligence', {
      project: p.ticker,
      persona: persona.label,
      source: rec.source,
      verdict: rec.verdict,
      conviction: rec.conviction,
      amount: rec.amountUsdg || undefined,
      rating: rec.rating,
      note: rec.feedback ? `${rec.feedback.slice(0, 90)}${rec.feedback.length > 90 ? '…' : ''}` : undefined,
    });
    let exited = false;
    if (rec.round === 0 && p.external && rec.verdict === 'back' && (rec.conviction ?? 0) >= this.ai.backConviction) {
      const amount = minBig(usd(rec.amountUsdg ?? 0), this.externalRoom(p, snap));
      if (amount >= usd(10)) {
        const r = await this.deposit(p, persona, amount);
        if (r) {
          rec.acted = true;
          rec.deposited = String(r.debit);
          p.externalDeposited = String(BigInt(p.externalDeposited ?? '0') + r.debit);
          log.info('ai-deposit', {
            project: p.ticker,
            persona: persona.label,
            amount: fmtUsd(r.debit),
            external: true,
            totalByPersonas: fmtUsd(BigInt(p.externalDeposited)),
          });
        }
      } else {
        log.info('external-cap-reached', {
          project: p.ticker,
          persona: persona.label,
          capShare: this.ai.externalCapShare,
        });
      }
    }
    if (rec.round > 0 && (rec.verdict === 'pass' || (rec.conviction ?? 1) < this.ai.exitConviction)) {
      for (const pos of this.open(p).filter((x) => x.owner === persona.index))
        await this.exitPosition(p, pos, snap.phase === 'Stage2');
      exited = true;
      log.info('conviction-exit', { project: p.ticker, persona: persona.label, conviction: rec.conviction });
    }
    // Feedback: every first review, and a later review only when it ends in an exit.
    if (rec.feedback && (rec.round === 0 || exited)) await this.postReview(p, persona, rec);
  }

  private async postReview(p: ProjectState, persona: Persona, rec: ReviewRecord): Promise<void> {
    if (rec.feedbackPosted || !rec.feedback) return;
    const q = rec.question ? `\n\n${mindFor(persona).language === 'zh' ? '问题：' : 'Question: '}${rec.question}` : '';
    await this.d.api.postFeedback(persona.account, p.raise!, rec.rating ?? 3, `${rec.feedback}${q}`.slice(0, 2000));
    rec.feedbackPosted = true;
    p.feedbackPosted++;
    log.info('feedback', { project: p.ticker, author: persona.label, rating: rec.rating, source: rec.source });
  }

  /** Personas holding a position in a user's raise re-check their conviction every rereviewMinutes. */
  private scheduleRereviews(p: ProjectState): void {
    if (!this.d.mind.enabled || this.d.dryRun) return;
    p.reviews ??= [];
    for (const owner of new Set(this.open(p).map((x) => x.owner))) {
      const mine = p.reviews.filter((r) => r.persona === owner);
      if (mine.some((r) => r.status === 'scheduled')) continue;
      const last = mine.reduce<ReviewRecord | undefined>((a, r) => (!a || r.round > a.round ? r : a), undefined);
      if (this.now - (last?.at ?? 0) < this.ai.rereviewMinutes * 60) continue;
      p.reviews.push({ persona: owner, round: (last?.round ?? 0) + 1, status: 'scheduled', dueAt: this.now });
    }
  }

  // ---- raises created by others (real users on testnet)

  /** Find raises created by anyone other than the mock builders while they are still in Stage 1. */
  async discover(): Promise<void> {
    if (!this.d.mind.enabled) return;
    const factory = this.d.dep.factory;
    const count = Number(await this.d.chain.read<bigint>(factory, FactoryAbi, 'raisesCount'));
    const known = new Set(
      Object.values(this.state.projects)
        .map((p) => p.raise?.toLowerCase())
        .filter(Boolean),
    );
    const ours = new Set(ofKind(this.d.personas, 'builder').map((b) => b.address.toLowerCase()));
    for (let i = this.state.factoryCursor ?? 0; i < count; i++) {
      const raise = getAddress(await this.d.chain.read<string>(factory, FactoryAbi, 'raises', [BigInt(i)]));
      if (known.has(raise.toLowerCase())) continue;
      const snap = await raiseSnapshot(this.d.chain, raise, this.now);
      if (snap.phase !== 'Stage1' || this.now >= snap.stage1End) continue;
      const [modules, cfg, gov, ref] = await Promise.all([
        this.d.chain.read<any>(raise, RaiseAbi, 'modules'),
        this.d.chain.read<any>(raise, RaiseAbi, 'getConfig'),
        this.d.chain.read<any>(raise, RaiseAbi, 'governanceConfig'),
        this.d.chain.read<any>(factory, FactoryAbi, 'templateOf', [raise]),
      ]);
      const builder = getAddress(gov[0]);
      if (ours.has(builder.toLowerCase())) continue;
      const [name, symbol] = await Promise.all([
        this.d.chain.read<string>(modules.token, TokenAbi, 'name'),
        this.d.chain.read<string>(modules.token, TokenAbi, 'symbol'),
      ]);
      const template: Template =
        String(ref.templateId).toLowerCase() === this.d.dep.budgetTemplate.toLowerCase()
          ? 'BUDGET_LAUNCH'
          : 'ESCROW_LAUNCH';
      this.state.projects[`ext:${raise.toLowerCase()}`] = {
        ticker: symbol.slice(0, 12),
        name: name.slice(0, 80),
        external: true,
        builder: -1,
        template,
        fate: 'graduate',
        hold: null,
        stage1Length: Number(cfg.stage1Length),
        stage2Length: Number(cfg.stage2Length),
        scheduledAt: snap.start,
        raise,
        modules: {
          token: modules.token,
          vesting: modules.vesting,
          governor: modules.governor,
          claims: modules.claims,
          adapter: modules.adapter,
        },
        treasury: getAddress(cfg.treasury),
        createdAt: snap.start,
        createdBlock: Number(this.head),
        fillBy: 0,
        partialFill: 0,
        positions: [],
        proposals: [],
        exits: { stage1: 0, stage2: 0 },
        updatesPosted: 0,
        feedbackPosted: 0,
        market: { mood: 0, burst: 0, trades: 0, swaps: 0 },
        profileSet: true,
        externalDeposited: '0',
      };
      log.info('external-raise', {
        raise,
        symbol,
        name,
        builder,
        template,
        stage1Ends: new Date(snap.stage1End * 1000).toISOString(),
      });
    }
    this.state.factoryCursor = count;
  }

  /** A user's raise: due diligence and capped backing in Stage 1, conviction reviews, votes, claims. */
  private async external(p: ProjectState, snap: RaiseSnapshot): Promise<void> {
    const keeper = this.ai.externalKeeper;
    switch (snap.phase) {
      case 'Stage1':
        if (this.now >= snap.stage1End) {
          if (keeper && snap.vetoUntil <= this.now)
            await this.keeper(
              p,
              this.keeperPersona(),
              { address: p.raise!, abi: RaiseAbi, functionName: 'advanceStage1' },
              'advance-stage1',
            );
          return;
        }
        await this.reviews(p, snap);
        this.scheduleRereviews(p);
        await this.processReviews(p, snap);
        return;
      case 'Stage2':
        this.scheduleRereviews(p);
        await this.processReviews(p, snap);
        await this.externalProposals(p);
        return;
      case 'ListingPending':
        if (keeper)
          await this.keeper(
            p,
            this.keeperPersona(),
            { address: p.raise!, abi: RaiseAbi, functionName: 'list' },
            'list',
          );
        return;
      case 'Stage3':
        if (!p.listedSeen) {
          p.listedSeen = true;
          for (const pos of p.positions) if (!pos.closed) pos.closed = 'listed';
          log.info('listed', { project: p.ticker, raise: p.raise, external: true });
        }
        await this.externalProposals(p);
        if (!p.positions.length) p.done = true;
        return;
      case 'Dissolved':
        await this.dissolved(p);
        return;
    }
  }

  /** Follow whatever proposal the user's governor has open, so the personas' positions vote on it. */
  private async externalProposals(p: ProjectState): Promise<void> {
    if (!p.positions.length) return;
    const id = Number(await this.d.chain.read<bigint>(p.modules!.governor, GovAbi, 'activeProposalId'));
    if (id && !p.proposals.some((x) => x.id === String(id))) {
      const prop = await this.d.chain.read<any>(p.modules!.governor, GovAbi, 'getProposal', [BigInt(id)]);
      p.proposals.push({ id: String(id), kind: Number(prop.kind) === 0 ? 'draw' : 'spend', voters: [] });
      log.info('external-proposal', {
        project: p.ticker,
        id,
        kind: Number(prop.kind) === 0 ? 'draw' : 'spend',
        amount: fmtUsd(BigInt(prop.amount)),
      });
    }
    const active = p.proposals.find((x) => !x.closed);
    if (active) await this.followProposal(p, active);
  }

  /** Every sentimentEveryMinutes, a cheap AI read of updates, feedback and price action anchors the market mood. */
  private async sentiment(p: ProjectState): Promise<void> {
    if (!this.d.mind.enabled || this.d.dryRun || p.external) return;
    const m = p.market;
    const every = this.ai.sentimentEveryMinutes * 60;
    if (m.sentimentAt && this.now - m.sentimentAt < every) return;
    const facts = await this.facts(p);
    if (!facts) return;
    const res = await this.d.mind.sentiment(
      `sent:${p.raise}:${m.sentimentAt ?? 0}`,
      facts,
      this.d.warp ? this.aiWait : Math.min(this.aiWait, 5000),
    );
    if (res.state === 'pending') return;
    m.sentimentAt = this.now;
    if (res.state !== 'done' || !res.value) return;
    m.sentiment = res.value.sentiment;
    log.info('sentiment', { project: p.ticker, sentiment: res.value.sentiment, summary: res.value.summary });
  }

  // ---- Dissolved

  private async dissolved(p: ProjectState): Promise<void> {
    if (!p.dissolvedSeen) {
      p.dissolvedSeen = true;
      log.info('dissolved', { project: p.ticker, raise: p.raise, fate: p.fate });
    }
    const open = p.positions.filter((x) => !x.closed);
    if (!open.length) {
      p.done = true;
      return;
    }
    const since = p.phaseSince ?? this.now;
    for (const pos of open.slice(0, 3)) {
      const owner = this.persona(pos.owner);
      // Rollover personas keep their claim for a Stage 1 project for a while; everyone else claims in their own time.
      if (owner.kind === 'rollover' && this.now < since + 3600 && this.rolloverTargets([]).length) continue;
      if (!this.chance(6)) continue;
      const claimable = await this.d.chain.read<bigint>(p.modules!.claims, ClaimsAbi, 'claimable', [BigInt(pos.id)]);
      if (claimable === 0n) {
        pos.closed = 'claim';
        continue;
      }
      if (
        await this.attempt('claim', p, () =>
          this.tx(
            owner,
            { address: p.modules!.claims, abi: ClaimsAbi, functionName: 'claim', args: [BigInt(pos.id)] },
            'claim',
            p,
            { position: pos.id, amount: fmtUsd(claimable) },
          ),
        )
      )
        pos.closed = 'claim';
    }
  }

  // ---- rollovers (across projects)

  /**
   * Stage 1 projects a rollover of `amount` may land in: graduating, open, and not sold out by it before enough
   * distinct backers have joined (the rolling persona counts only if it is new there).
   */
  private rolloverTargets(exclude: string[], persona?: Persona, amount = 0n): ProjectState[] {
    return Object.values(this.state.projects).filter((p) => {
      const s = this.snaps.get(this.key(p));
      // Never roll into a user's raise: the personas' share there stays under the external cap.
      if (
        !p.raise ||
        p.done ||
        p.external ||
        p.fate !== 'graduate' ||
        s?.phase !== 'Stage1' ||
        exclude.includes(p.raise)
      )
        return false;
      if (this.now >= s.stage1End - 3 * this.config.tickSeconds || s.sold >= s.supply / 5n) return false;
      if (!persona) return true;
      const holders = new Set(this.open(p).map((x) => x.owner));
      const needed = Math.max(
        0,
        this.params[p.template].minimumBackers + 1 - holders.size - (holders.has(persona.index) ? 0 : 1),
      );
      const remaining = remainingFillCost(s.targetPrice, s.supply, s.sold);
      const minDeposit = maxBig(usd(10), remainingFillCost(s.targetPrice, s.supply, 0n) / 100n);
      return remaining > amount + BigInt(needed) * minDeposit * 2n;
    });
  }

  async rollovers(): Promise<void> {
    const router = this.d.dep.rolloverRouter;
    if (!router) return;
    // Dissolution claims held by rollover users roll into a Stage 1 project soon after a target exists; moving a live
    // Stage 1 position is rarer.
    const claims = Object.values(this.state.projects).some(
      (p) =>
        this.snaps.get(this.key(p))?.phase === 'Dissolved' &&
        p.positions.some((x) => !x.closed && this.persona(x.owner).kind === 'rollover'),
    );
    if (
      !(claims && this.r.chance(this.config.rollover.claimChancePerTick)) &&
      !this.chance(this.config.rollover.chancePerHour)
    )
      return;
    const people = this.r.shuffle([
      ...ofKind(this.d.personas, 'rollover'),
      ...this.r.shuffle(ofKind(this.d.personas, 'conservative')).slice(0, 2),
    ]);
    for (const persona of people) {
      const sources: { p: ProjectState; pos: PositionRecord; amount: bigint; source: readonly unknown[] }[] = [];
      for (const p of Object.values(this.state.projects)) {
        if (!p.raise || p.done) continue;
        const snap = this.snaps.get(this.key(p));
        for (const pos of p.positions.filter((x) => !x.closed && x.owner === persona.index && x.class === 'Backer')) {
          if (snap?.phase === 'Dissolved') {
            const claimable = await this.d.chain.read<bigint>(p.modules!.claims, ClaimsAbi, 'claimable', [
              BigInt(pos.id),
            ]);
            if (claimable > 0n)
              sources.push({ p, pos, amount: claimable, source: [p.raise, 2, BigInt(pos.id), 0n, 0n, 0n] as const });
          } else if (
            snap?.phase === 'Stage1' &&
            this.now < snap.start + 0.5 * (snap.stage1End - snap.start) &&
            this.r.chance(0.3)
          ) {
            const state = await this.d.chain.read<any>(p.raise, RaiseAbi, 'positionState', [BigInt(pos.id)]);
            if (BigInt(state.tokens) > 0n)
              sources.push({
                p,
                pos,
                amount: BigInt(state.basis),
                source: [
                  p.raise,
                  0,
                  BigInt(pos.id),
                  BigInt(state.tokens),
                  BigInt(state.basis),
                  // Fresh, not the tick-start snapshot: other actions this tick may have moved the nonce.
                  await this.d.chain.read<bigint>(p.raise, RaiseAbi, 'stateNonce'),
                ] as const,
              });
          }
          if (sources.length >= 3) break;
        }
      }
      if (!sources.length) continue;
      const topUp = this.r.chance(0.4) ? usd(this.r.range(100, 2000)) : 0n;
      const targets = this.rolloverTargets(
        sources.map((s) => s.p.raise!),
        persona,
        sources.reduce((sum, s) => sum + s.amount, topUp),
      );
      if (!targets.length) continue;
      const target = this.r.pick(targets);
      await this.attempt('rollover', target, async () => {
        if (topUp > 0n) {
          await this.ensureUsdg(persona, topUp);
          await this.ensureApproval(persona, this.d.dep.quote, router, topUp, target);
        }
        const nonce = await this.d.chain.read<bigint>(target.raise!, RaiseAbi, 'stateNonce');
        const receipt = await this.tx(
          persona,
          {
            address: router,
            abi: RolloverAbi,
            functionName: 'rollover',
            args: [
              sources.map((s) => ({
                raise: s.source[0],
                kind: s.source[1],
                id: s.source[2],
                quantity: s.source[3],
                minPayout: s.source[4],
                nonce: s.source[5],
              })),
              topUp,
              target.raise,
              0n,
              nonce,
              this.deadline(),
            ],
          },
          'rollover',
          target,
          { from: sources.map((s) => `${s.p.ticker}#${s.pos.id}`).join(','), topUp: fmtUsd(topUp) },
        );
        if (!receipt) return;
        for (const s of sources) s.pos.closed = 'rollover';
        const ev = events(receipt, RaiseAbi).find(
          (e) => e.eventName === 'Deposited' && getAddress(e.args.owner) === persona.address,
        );
        if (ev) target.positions.push({ id: String(ev.args.id), owner: persona.index, class: 'Backer' });
      });
      return;
    }
  }

  // ---- off-chain (API)

  private async offchain(p: ProjectState, snap: RaiseSnapshot): Promise<void> {
    if (this.d.dryRun) return;
    const project = this.catalog(p);
    const builder = this.persona(p.builder);
    if (!p.profileSet) {
      if (!(await this.d.api.hasRaise(p.raise!))) return;
      if (!p.image) {
        const uploaded = await this.d.api.upload(builder.account, markPng(project));
        if (!uploaded) return;
        p.image = { uri: uploaded.uri, url: uploaded.url };
        log.info('image', { project: p.ticker, uri: uploaded.uri, url: uploaded.url, pinned: uploaded.cid !== null });
        this.save();
      }
      await this.d.api.putProfile(builder.account, p.raise!, {
        ...profileBody(project, p.image.uri),
        name: p.name ?? project.name,
      });
      p.profileSet = true;
      log.info('profile', { project: p.ticker });
      this.save();
    }
    const s2 = ['Stage2', 'ListingPending', 'Stage3'].includes(snap.phase);
    const due = [
      snap.phase !== 'Stage1' || this.now >= snap.start + 0.35 * (snap.stage1End - snap.start),
      s2 && this.now >= snap.stage2Start + 0.3 * (snap.stage2End - snap.stage2Start),
      snap.phase === 'Stage3',
    ];
    if (
      p.updatesPosted < project.updates.length &&
      due[p.updatesPosted] &&
      !(snap.phase === 'Dissolved' && p.updatesPosted > 0)
    ) {
      const seed = project.updates[p.updatesPosted];
      let update = { title: seed.title, body: seed.body, kind: seed.kind as string };
      let source = 'catalog';
      if (this.d.mind.enabled) {
        // AI-written, grounded in the planned milestone and the project's real metrics; catalog text as fallback.
        const facts = await this.facts(p);
        if (facts) {
          const res = await this.d.mind.update(
            `upd:${p.raise}:${p.updatesPosted}`,
            this.brief(p, seed),
            facts,
            p.updatesPosted + 1,
            this.aiWait,
          );
          if (res.state === 'pending') return;
          if (res.state === 'done' && res.value) {
            update = { ...res.value, kind: seed.kind };
            source = 'ai';
          }
        }
      }
      await this.d.api.postUpdate(builder.account, p.raise!, update);
      p.updatesPosted++;
      log.info('builder-update', { project: p.ticker, title: update.title, source });
    }
    const wanted =
      this.config.offchain.feedbackPerProject[0] +
      (hash(`fb:${p.ticker}`) %
        (this.config.offchain.feedbackPerProject[1] - this.config.offchain.feedbackPerProject[0] + 1));
    // With AI minds, feedback comes from the due-diligence reviews instead of canned lines.
    if (
      !this.d.mind.enabled &&
      p.feedbackPosted < wanted &&
      ['Stage2', 'Stage3', 'Dissolved'].includes(snap.phase) &&
      this.chance(this.config.offchain.feedbackChancePerHour)
    ) {
      const owners = [...new Set(p.positions.map((x) => x.owner))];
      if (!owners.length) return;
      const author = this.persona(this.r.pick(owners));
      const texts = FEEDBACK[project.category];
      const rating = snap.phase === 'Dissolved' ? this.r.int(2, 3) : this.r.int(3, 5);
      await this.d.api.postFeedback(author.account, p.raise!, rating, texts[p.feedbackPosted % texts.length]);
      p.feedbackPosted++;
      log.info('feedback', { project: p.ticker, author: author.label, rating });
    }
  }

  // ------------------------------------------------------------------ reporting

  table(): string {
    const rows = Object.values(this.state.projects).map((p) => {
      const s = this.snaps.get(this.key(p));
      const sold = s ? `${(Number((s.sold * 1000n) / (s.supply / 5n)) / 10).toFixed(1)}%` : '-';
      return [
        p.ticker,
        p.template === 'BUDGET_LAUNCH' ? 'Budget' : 'Escrow',
        p.external ? 'external (user)' : p.fate,
        p.lastPhase ?? (p.raise ? '?' : 'pending'),
        sold,
        String(
          new Set(
            p.positions.filter((x) => x.class === 'Backer' && (!x.closed || x.closed === 'listed')).map((x) => x.owner),
          ).size,
        ),
        String(p.market.trades),
        String(p.market.swaps),
        p.market.volume && p.market.volumeSince
          ? `${Math.round(((p.market.volume / Math.max(3600, this.now - p.market.volumeSince)) * 86400) / 100) / 10}k/${Math.round((p.market.dailyVolume ?? 0) / 1000)}k`
          : '-',
        String(p.proposals.length),
        p.profileSet ? 'yes' : 'no',
        p.raise ?? '-',
      ];
    });
    const head = [
      'TICKER',
      'TEMPLATE',
      'FATE',
      'PHASE',
      'SOLD',
      'BACKERS',
      'TRADES',
      'SWAPS',
      'VOL/DAY (target)',
      'PROPOSALS',
      'PROFILE',
      'RAISE',
    ];
    const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
    return [head, ...rows].map((r) => r.map((c, i) => c.padEnd(widths[i])).join('  ')).join('\n');
  }
}

function clampBig(v: bigint, lo: bigint, hi: bigint): bigint {
  return v < lo ? lo : v > hi ? hi : v;
}

export { USDG };
