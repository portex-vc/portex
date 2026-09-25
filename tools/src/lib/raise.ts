// Typed raise lifecycle driver: creation with the design §4 demo preset, and one
// wrapper per user action (deposit / commit / claim / redeem / buy / sell / …).
// Every wrapper narrates one line, tracks quote-flow P&L, and — for money-moving
// calls — asserts the wallet delta matches the protected amount exactly (§6.2).
// After every successful step the §6 invariant checker runs.
import {
  decodeEventLog,
  type Address,
  type Hex,
} from 'viem';
import { ABIS, type Deployment } from './abis';
import { type Actor, portexLocal } from './chain';
import { Ctx, InvariantViolation } from './context';
import { checkInvariants, type RaiseAddrs } from './invariants';
import { fmtBps, fmtPrice, fmtQuote, fmtSignedQuote, fmtToken, mdRow, q, shortAddr, t } from './format';

export const STATE_NAMES = ['Incubation', 'Commitment', 'Growth', 'Migrated', 'Failed'];
export const TRANCHE_NAMES = ['Locked', 'Committed', 'Claimed', 'Redeemed'];

// ---- design §4 localhost demo preset ----

export interface GovernorConfigInput {
  votingPeriod: bigint;
  disputeWindow: bigint;
  minProposalInterval: bigint;
  quorumBps: number;
  approvalBps: number;
}

export interface RaiseConfigInput {
  quoteAsset: Address;
  softCap: bigint;
  hardCap: bigint;
  minIncubation: bigint;
  deadline: bigint;
  totalSupply: bigint;
  stage1Alloc: bigint;
  stage2Inventory: bigint;
  vaultAlloc: bigint;
  builderAlloc: bigint;
  commitmentWindow: bigint;
  epochLength: bigint;
  numTranches: number;
  minOptInBps: number;
  swapFeeBps: number;
  feeReserveBps: number;
  feeVaultBps: number;
  feeBuilderBps: number;
  minGraduationLiquidity: bigint;
  minRealRatioBps: number;
  builderVesting: bigint;
  vaultDuration: bigint;
  vetoMaxDelay: bigint;
  vetoCooldown: bigint;
  maxCumulativeSpendBps: number;
  governor: GovernorConfigInput;
}

export function demoConfig(quoteAsset: Address, overrides: Partial<RaiseConfigInput> = {}): RaiseConfigInput {
  const cfg: RaiseConfigInput = {
    quoteAsset,
    softCap: q(50_000),
    hardCap: q(200_000),
    minIncubation: 600n, // 10 min
    deadline: 1800n, // 30 min
    totalSupply: t(100_000_000),
    stage1Alloc: t(20_000_000), // A1 = 20%
    stage2Inventory: t(40_000_000), // T0 = 40% (>= A1)
    vaultAlloc: t(10_000_000), // 10%
    builderAlloc: t(30_000_000), // 30%
    commitmentWindow: 300n, // 5 min
    epochLength: 300n, // 5 min
    numTranches: 4,
    minOptInBps: 3000,
    swapFeeBps: 100,
    feeReserveBps: 4000,
    feeVaultBps: 3000,
    feeBuilderBps: 3000,
    minGraduationLiquidity: q(20_000),
    minRealRatioBps: 5000,
    builderVesting: 1200n, // 20 min
    vaultDuration: 1200n, // 20 min
    vetoMaxDelay: 300n,
    vetoCooldown: 600n,
    maxCumulativeSpendBps: 0, // ZERO_EXTRACTION
    governor: {
      // Rule 2 demo timings (§5.7 defaults: quorum 40%, approval 60%, interval 14 days)
      votingPeriod: 300n,
      disputeWindow: 300n,
      minProposalInterval: 600n,
      quorumBps: 4000,
      approvalBps: 6000,
    },
    ...overrides,
  };
  // Allocations must sum to totalSupply; recompute unless the caller pinned it.
  if (!overrides.totalSupply) {
    cfg.totalSupply = cfg.stage1Alloc + cfg.stage2Inventory + cfg.vaultAlloc + cfg.builderAlloc;
  }
  return cfg;
}

export interface CreateRaiseOptions {
  builder: Actor;
  name: string;
  symbol: string;
  overrides?: Partial<RaiseConfigInput>;
  templateId?: Hex;
  templateVersion?: number | bigint;
}

export class RaiseSim {
  /** Optional hook invoked after every pool/DEX trade (used by S8 to sample the price path). */
  onTrade?: () => Promise<void>;

  private constructor(
    readonly ctx: Ctx,
    readonly addrs: RaiseAddrs & { governor: Address },
    readonly name: string,
    readonly symbol: string,
    readonly cfg: RaiseConfigInput,
  ) {}

  static async create(ctx: Ctx, opts: CreateRaiseOptions): Promise<RaiseSim> {
    const d: Deployment = ctx.deployment;
    const cfg = demoConfig(ctx.quote, opts.overrides);
    const templateId = opts.templateId ?? d.templateZeroExtraction;
    const version = opts.templateVersion ?? d.templateZeroExtractionVersion;

    const hash = await ctx.wallet(opts.builder).writeContract({
      address: d.factory,
      abi: ABIS.RaiseFactory,
      functionName: 'createRaise',
      args: [templateId, BigInt(version), cfg, { name: opts.name, symbol: opts.symbol }],
      chain: portexLocal,
      account: opts.builder.account,
    });
    const receipt = await ctx.client.waitForTransactionReceipt({ hash });
    let found: { raise: Address; token: Address; pool: Address; vault: Address; governor: Address } | null = null;
    for (const log of receipt.logs) {
      try {
        const ev = decodeEventLog({ abi: ABIS.RaiseFactory, data: log.data, topics: log.topics });
        if (ev.eventName === 'RaiseCreated') {
          const a = ev.args as unknown as { raise: Address; token: Address; pool: Address; vault: Address; governor: Address };
          found = a;
        }
      } catch {
        /* not a factory log */
      }
    }
    if (!found) throw new Error('RaiseCreated event not found in createRaise receipt');
    ctx.track(opts.builder);
    const rs = new RaiseSim(ctx, { raise: found.raise, token: found.token, pool: found.pool, vault: found.vault, governor: found.governor }, opts.name, opts.symbol, cfg);
    ctx.log(
      `\n### Raise created: **${opts.name} (${opts.symbol})** at \`${shortAddr(found.raise)}\`\n` +
        `- soft cap ${fmtQuote(cfg.softCap)} · hard cap ${fmtQuote(cfg.hardCap)} · ${cfg.numTranches} tranches × epoch ${cfg.epochLength}s · min opt-in ${fmtBps(cfg.minOptInBps)}\n` +
        `- A1 ${fmtToken(cfg.stage1Alloc)} · T0 ${fmtToken(cfg.stage2Inventory)} (depth ×${(Number(cfg.stage2Inventory) / Number(cfg.stage1Alloc)).toFixed(1)}) · vault ${fmtToken(cfg.vaultAlloc)} · builder ${fmtToken(cfg.builderAlloc)}`,
    );
    return rs;
  }

  // ---- low-level helpers ----

  private async check(where: string): Promise<void> {
    if (this.ctx.checksEnabled) await checkInvariants(this.ctx, this.addrs, where);
  }

  /** Force an invariant check regardless of ctx.checksEnabled (for coarse-grained steps). */
  async checkNow(where: string): Promise<void> {
    await checkInvariants(this.ctx, this.addrs, where);
  }

  private async write(actor: Actor, address: Address, abi: unknown, functionName: string, args: unknown[]): Promise<Hex> {
    const hash = await this.ctx.wallet(actor).writeContract({
      address,
      abi: abi as never,
      functionName,
      args: args as never,
      chain: portexLocal,
      account: actor.account,
    });
    await this.ctx.client.waitForTransactionReceipt({ hash });
    return hash;
  }

  private async read<T>(address: Address, abi: unknown, functionName: string, args: unknown[] = []): Promise<T> {
    return this.ctx.client.readContract({ address, abi: abi as never, functionName, args: args as never }) as Promise<T>;
  }

  private async approveQuote(actor: Actor, spender: Address, amount: bigint): Promise<void> {
    await this.write(actor, this.ctx.quote, ABIS.MockUSDG, 'approve', [spender, amount]);
  }

  private async approveToken(actor: Actor, spender: Address, amount: bigint): Promise<void> {
    await this.write(actor, this.addrs.token, ABIS.ProjectToken, 'approve', [spender, amount]);
  }

  /** Runs fn, asserts the actor's quote delta equals `expected` (§6.2), records P&L. */
  private async exactQuoteOut(actor: Actor, expected: bigint, what: string, fn: () => Promise<unknown>): Promise<bigint> {
    const before = await this.ctx.quoteBalance(actor.address);
    await fn();
    const after = await this.ctx.quoteBalance(actor.address);
    const delta = after - before;
    if (delta !== expected) {
      throw new InvariantViolation(
        what,
        `${actor.label} received ${fmtQuote(delta)} but the protected principal was ${fmtQuote(expected)}`,
      );
    }
    this.ctx.received(actor, delta);
    return delta;
  }

  // ---- views ----

  state(): Promise<number> {
    return this.read<number>(this.addrs.raise, ABIS.Raise, 'state');
  }

  async reserves(): Promise<{ R: bigint; V: bigint; T: bigint }> {
    const [R, V, T] = (await this.read<[bigint, bigint, bigint]>(this.addrs.pool, ABIS.Stage2Pool, 'reserves')) as [bigint, bigint, bigint];
    return { R, V, T };
  }

  async price(): Promise<bigint> {
    const st = await this.read<number>(this.addrs.pool, ABIS.Stage2Pool, 'poolState');
    if (st === 1) return this.read<bigint>(this.addrs.pool, ABIS.Stage2Pool, 'bookPrice');
    if (st === 2) {
      const [qr, tr] = (await this.read<[bigint, bigint]>(
        this.ctx.deployment.dexAdapter,
        ABIS.MockDexAdapter,
        'getReserves',
        [this.addrs.token],
      )) as [bigint, bigint];
      return tr === 0n ? 0n : (qr * 10n ** 18n) / tr;
    }
    return 0n;
  }

  /** The flat Stage 1 price b (quote base units per whole token), from the frozen totals. */
  async stage1Price(): Promise<bigint> {
    const p = await this.read<bigint>(this.addrs.raise, ABIS.Raise, 'commitPrincipalTotal');
    if (p === 0n) return 0n;
    return (p * 10n ** 18n) / this.cfg.stage1Alloc;
  }

  async poolLine(): Promise<string> {
    const st = await this.state();
    if (st < 2) return '';
    const { R, V, T } = await this.reserves();
    const p = await this.price();
    const ratio = st === 2 ? await this.read<number>(this.addrs.pool, ABIS.Stage2Pool, 'realRatioBps') : 0;
    const epoch = await this.read<bigint>(this.addrs.raise, ABIS.Raise, 'currentEpoch');
    return `pool: price ${fmtPrice(p)} · R ${fmtQuote(R)} · V ${fmtQuote(V)} · T ${fmtToken(T)} · real ${fmtBps(ratio)} · epoch ${epoch}`;
  }

  async logPool(): Promise<void> {
    const line = await this.poolLine();
    if (line) this.ctx.note(line);
  }

  async positionOf(actor: Actor): Promise<{ principal: bigint; entitlement: bigint; bitmap: bigint }> {
    const [, , , , entitlement, bitmap] = (await this.read<[bigint, bigint, bigint, bigint, bigint, bigint]>(
      this.addrs.raise,
      ABIS.Raise,
      'positionOf',
      [actor.address],
    )) as [bigint, bigint, bigint, bigint, bigint, bigint];
    const principal = await this.read<bigint>(this.addrs.raise, ABIS.Raise, 'principalOf', [actor.address]);
    return { principal, entitlement, bitmap };
  }

  async trancheStates(actor: Actor): Promise<number[]> {
    const { bitmap } = await this.positionOf(actor);
    const out: number[] = [];
    for (let k = 0; k < this.cfg.numTranches; k++) out.push(Number((bitmap >> BigInt(2 * k)) & 3n));
    return out;
  }

  // ---- Stage 1 ----

  async deposit(actor: Actor, amount: bigint): Promise<void> {
    this.ctx.track(actor);
    await this.approveQuote(actor, this.addrs.raise, amount);
    await this.write(actor, this.addrs.raise, ABIS.Raise, 'deposit', [amount]);
    this.ctx.spent(actor, amount);
    const total = await this.read<bigint>(this.addrs.raise, ABIS.Raise, 'totalPrincipal');
    this.ctx.note(`${actor.label} deposits ${fmtQuote(amount)} → total ${fmtQuote(total)} / soft cap ${fmtQuote(this.cfg.softCap)}`);
    await this.check(`deposit(${actor.label})`);
  }

  /** Withdraw (Incubation/Failed). amount omitted = full principal. */
  async withdraw(actor: Actor, amount?: bigint): Promise<bigint> {
    const principal = await this.read<bigint>(this.addrs.raise, ABIS.Raise, 'principalOf', [actor.address]);
    const amt = amount ?? principal;
    if (amt === 0n) return 0n;
    const delta = await this.exactQuoteOut(actor, amt, `withdraw(${actor.label})`, () =>
      this.write(actor, this.addrs.raise, ABIS.Raise, 'withdraw', [amt]),
    );
    this.ctx.note(`${actor.label} withdraws ${fmtQuote(delta)} (${fmtQuote(principal)} principal) — 1:1 in kind`);
    await this.check(`withdraw(${actor.label})`);
    return delta;
  }

  async startCommitment(by: Actor): Promise<void> {
    await this.write(by, this.addrs.raise, ABIS.Raise, 'startCommitment', []);
    const p = await this.read<bigint>(this.addrs.raise, ABIS.Raise, 'commitPrincipalTotal');
    const b = await this.stage1Price();
    this.ctx.note(`${by.label} opens the commitment window — P_tot ${fmtQuote(p)}, flat price b = ${fmtPrice(b)} per token`);
    await this.check('startCommitment');
  }

  async fail(by: Actor): Promise<void> {
    await this.write(by, this.addrs.raise, ABIS.Raise, 'fail', []);
    this.ctx.note(`${by.label} calls fail() → State.Failed, every principal withdrawable 1:1`);
    await this.check('fail');
  }

  async cancel(by: Actor): Promise<void> {
    await this.write(by, this.addrs.raise, ABIS.Raise, 'cancel', []);
    this.ctx.note(`${by.label} cancels the raise → State.Failed`);
    await this.check('cancel');
  }

  // ---- tranches ----

  async commit(actor: Actor, k: number): Promise<void> {
    await this.write(actor, this.addrs.raise, ABIS.Raise, 'commit', [k]);
    const info = (await this.read<[number, bigint, bigint, bigint, bigint]>(this.addrs.raise, ABIS.Raise, 'trancheInfo', [actor.address, k])) as [number, bigint, bigint, bigint, bigint];
    this.ctx.note(`${actor.label} commits tranche ${k} (${fmtQuote(info[1])} principal gives up its put)`);
    await this.check(`commit(${actor.label}, ${k})`);
  }

  async commitMany(actor: Actor, ks: number[]): Promise<void> {
    const mask = ks.reduce((m, k) => m | (1n << BigInt(k - 1)), 0n);
    await this.write(actor, this.addrs.raise, ABIS.Raise, 'commitMany', [mask]);
    this.ctx.note(`${actor.label} commits tranches ${ks.join(', ')}`);
    await this.check(`commitMany(${actor.label})`);
  }

  async claim(actor: Actor, k: number, stake = false): Promise<bigint> {
    const info = (await this.read<[number, bigint, bigint, bigint, bigint]>(this.addrs.raise, ABIS.Raise, 'trancheInfo', [actor.address, k])) as [number, bigint, bigint, bigint, bigint];
    const expected = info[2];
    const before = await this.read<bigint>(this.addrs.token, ABIS.ProjectToken, 'balanceOf', [actor.address]);
    await this.write(actor, this.addrs.raise, ABIS.Raise, 'claim', [k, stake]);
    const after = await this.read<bigint>(this.addrs.token, ABIS.ProjectToken, 'balanceOf', [actor.address]);
    const got = stake ? expected : after - before;
    if (got !== expected) {
      throw new InvariantViolation(`claim(${actor.label}, ${k})`, `claimed ${fmtToken(got)} but tranche entitled ${fmtToken(expected)}`);
    }
    this.ctx.note(`${actor.label} claims tranche ${k}: ${fmtToken(got)} ${this.symbol}${stake ? ' → staked in Diamond Vault' : ' → wallet'}`);
    await this.check(`claim(${actor.label}, ${k})`);
    return got;
  }

  async redeem(actor: Actor, k: number): Promise<bigint> {
    const info = (await this.read<[number, bigint, bigint, bigint, bigint]>(this.addrs.raise, ABIS.Raise, 'trancheInfo', [actor.address, k])) as [number, bigint, bigint, bigint, bigint];
    const expected = info[1];
    if (expected === 0n) return 0n;
    const delta = await this.exactQuoteOut(actor, expected, `redeem(${actor.label}, ${k})`, () =>
      this.write(actor, this.addrs.raise, ABIS.Raise, 'redeem', [k]),
    );
    this.ctx.note(`${actor.label} redeems tranche ${k} → exactly ${fmtQuote(delta)} back, ${fmtToken(info[2])} tokens burned`);
    await this.check(`redeem(${actor.label}, ${k})`);
    return delta;
  }

  /** Redeem every still-Locked tranche. Returns total quote recovered. */
  async redeemAll(actor: Actor): Promise<bigint> {
    const states = await this.trancheStates(actor);
    let total = 0n;
    for (let k = 1; k <= states.length; k++) {
      if (states[k - 1] === 0) total += await this.redeem(actor, k);
    }
    return total;
  }

  async openGrowth(by: Actor): Promise<boolean> {
    await this.write(by, this.addrs.raise, ABIS.Raise, 'openGrowth', []);
    const st = await this.state();
    if (st === 4) {
      this.ctx.note(`${by.label} calls openGrowth() — opt-in below ${fmtBps(this.cfg.minOptInBps)} → **State.Failed**, full refunds`);
    } else {
      const committed = await this.read<bigint>(this.addrs.raise, ABIS.Raise, 'committedPrincipal');
      this.ctx.note(`${by.label} opens Growth — ${fmtQuote(committed)} of committed principal converted to real reserve`);
      this.ctx.note(await this.poolLine());
    }
    await this.check('openGrowth');
    return st === 2;
  }

  // ---- Stage 2 pool ----

  async buy(actor: Actor, quoteIn: bigint): Promise<bigint> {
    this.ctx.track(actor);
    const [quoted] = (await this.read<[bigint, bigint]>(this.addrs.pool, ABIS.Stage2Pool, 'quoteBuy', [quoteIn])) as [bigint, bigint];
    await this.approveQuote(actor, this.addrs.pool, quoteIn);
    const before = await this.ctx.tokenBalance(this.addrs.token, actor.address);
    await this.write(actor, this.addrs.pool, ABIS.Stage2Pool, 'buy', [quoteIn, 0n]);
    const after = await this.ctx.tokenBalance(this.addrs.token, actor.address);
    const got = after - before;
    this.ctx.spent(actor, quoteIn);
    this.ctx.note(`${actor.label} buys ${fmtToken(got)} ${this.symbol} for ${fmtQuote(quoteIn)} from the pool`);
    await this.logPool();
    await this.check(`buy(${actor.label})`);
    if (this.onTrade) await this.onTrade();
    void quoted;
    return got;
  }

  async sell(actor: Actor, tokensIn: bigint): Promise<bigint> {
    await this.approveToken(actor, this.addrs.pool, tokensIn);
    const before = await this.ctx.quoteBalance(actor.address);
    await this.write(actor, this.addrs.pool, ABIS.Stage2Pool, 'sell', [tokensIn, 0n]);
    const after = await this.ctx.quoteBalance(actor.address);
    const got = after - before;
    this.ctx.received(actor, got);
    this.ctx.note(`${actor.label} sells ${fmtToken(tokensIn)} ${this.symbol} → ${fmtQuote(got)}`);
    await this.logPool();
    await this.check(`sell(${actor.label})`);
    if (this.onTrade) await this.onTrade();
    return got;
  }

  async sellAll(actor: Actor): Promise<bigint> {
    const bal = await this.ctx.tokenBalance(this.addrs.token, actor.address);
    if (bal === 0n) return 0n;
    return this.sell(actor, bal);
  }

  /** Quote a sell without executing (used for mark-to-market). */
  async quoteSell(tokensIn: bigint): Promise<bigint> {
    const [out] = (await this.read<[bigint, bigint]>(this.addrs.pool, ABIS.Stage2Pool, 'quoteSell', [tokensIn])) as [bigint, bigint];
    return out;
  }

  // ---- Stage 3 ----

  /** Warp until the "all N epochs elapsed" graduation time gate passes (chain time also
   *  advances with wall-clock drift, so a fixed warp can undershoot). */
  async ensureGraduationTime(): Promise<void> {
    for (let i = 0; i < 50; i++) {
      const g = (await this.read<{ epochNow: bigint; epochsRequired: bigint }>(this.addrs.raise, ABIS.Raise, 'graduationGates')) as { epochNow: bigint; epochsRequired: bigint };
      if (g.epochNow >= g.epochsRequired && (await this.epochsElapsed())) return;
      await this.ctx.warp(120, 'waiting out the graduation time gate');
    }
    throw new Error('graduation time gate never reached');
  }

  private async epochsElapsed(): Promise<boolean> {
    const start = await this.read<bigint>(this.addrs.raise, ABIS.Raise, 'growthStart');
    const now = await this.ctx.now();
    return now >= start + BigInt(this.cfg.numTranches) * this.cfg.epochLength;
  }

  async graduate(by: Actor): Promise<void> {
    await this.write(by, this.addrs.raise, ABIS.Raise, 'graduate', []);
    const [qr, tr] = (await this.read<[bigint, bigint]>(this.ctx.deployment.dexAdapter, ABIS.MockDexAdapter, 'getReserves', [this.addrs.token])) as [bigint, bigint];
    this.ctx.note(`${by.label} migrates to Stage 3 — DEX seeded with ${fmtQuote(qr)} + ${fmtToken(tr)} ${this.symbol} (LP locked forever), leftover inventory burned`);
    await this.check('graduate');
  }

  async dexBuy(actor: Actor, quoteIn: bigint): Promise<bigint> {
    this.ctx.track(actor);
    await this.approveQuote(actor, this.ctx.deployment.dexAdapter, quoteIn);
    const before = await this.ctx.tokenBalance(this.addrs.token, actor.address);
    await this.write(actor, this.ctx.deployment.dexAdapter, ABIS.MockDexAdapter, 'swapExactQuoteForTokens', [this.addrs.token, quoteIn, 0n, actor.address]);
    const got = (await this.ctx.tokenBalance(this.addrs.token, actor.address)) - before;
    this.ctx.spent(actor, quoteIn);
    this.ctx.note(`${actor.label} buys ${fmtToken(got)} ${this.symbol} for ${fmtQuote(quoteIn)} on the DEX`);
    await this.check(`dexBuy(${actor.label})`);
    if (this.onTrade) await this.onTrade();
    return got;
  }

  async dexSell(actor: Actor, tokensIn: bigint): Promise<bigint> {
    await this.approveToken(actor, this.ctx.deployment.dexAdapter, tokensIn);
    const before = await this.ctx.quoteBalance(actor.address);
    await this.write(actor, this.ctx.deployment.dexAdapter, ABIS.MockDexAdapter, 'swapExactTokensForQuote', [this.addrs.token, tokensIn, 0n, actor.address]);
    const got = (await this.ctx.quoteBalance(actor.address)) - before;
    this.ctx.received(actor, got);
    this.ctx.note(`${actor.label} sells ${fmtToken(tokensIn)} ${this.symbol} on the DEX → ${fmtQuote(got)}`);
    await this.check(`dexSell(${actor.label})`);
    if (this.onTrade) await this.onTrade();
    return got;
  }

  // ---- vault & builder ----

  async vaultClaim(actor: Actor): Promise<{ quote: bigint; token: bigint }> {
    const [pq, pt] = (await this.read<[bigint, bigint]>(this.addrs.vault, ABIS.DiamondVault, 'pendingRewards', [actor.address])) as [bigint, bigint];
    if (pq === 0n && pt === 0n) return { quote: 0n, token: 0n };
    await this.write(actor, this.addrs.vault, ABIS.DiamondVault, 'claimRewards', []);
    this.ctx.received(actor, pq);
    this.ctx.note(`${actor.label} claims vault rewards: ${fmtQuote(pq)} quote + ${fmtToken(pt)} ${this.symbol}`);
    await this.check(`vaultClaim(${actor.label})`);
    return { quote: pq, token: pt };
  }

  async unstake(actor: Actor, amount: bigint): Promise<void> {
    await this.write(actor, this.addrs.vault, ABIS.DiamondVault, 'unstake', [amount]);
    this.ctx.note(`${actor.label} unstakes ${fmtToken(amount)} ${this.symbol} (weight permanently removed)`);
    await this.check(`unstake(${actor.label})`);
  }

  async claimBuilderFees(by: Actor): Promise<bigint> {
    const accrued = await this.read<bigint>(this.addrs.pool, ABIS.Stage2Pool, 'builderAccrued');
    if (accrued === 0n) return 0n;
    const builder = await this.read<Address>(this.addrs.raise, ABIS.Raise, 'builder');
    const bActor = this.ctx.actors.get(builder);
    await this.write(by, this.addrs.pool, ABIS.Stage2Pool, 'claimBuilderFees', []);
    if (bActor) this.ctx.received(bActor, accrued);
    this.ctx.note(`builder claims ${fmtQuote(accrued)} of accrued swap-fee share`);
    await this.check('claimBuilderFees');
    return accrued;
  }

  async claimBuilderVested(by: Actor): Promise<bigint> {
    const vested = await this.read<bigint>(this.addrs.raise, ABIS.Raise, 'builderVested');
    const claimed = await this.read<bigint>(this.addrs.raise, ABIS.Raise, 'builderClaimed');
    const amount = vested - claimed;
    if (amount === 0n) return 0n;
    await this.write(by, this.addrs.raise, ABIS.Raise, 'claimBuilderVested', []);
    this.ctx.note(`builder claims ${fmtToken(amount)} vested ${this.symbol}`);
    await this.check('claimBuilderVested');
    return amount;
  }

  // ---- reporting ----

  /** Mark price for unrealised P&L: book/DEX price; 0 once Failed before Growth. */
  async markPrice(): Promise<bigint> {
    return this.price();
  }

  async pnlTable(actors: Actor[], title = 'Per-actor P&L (quote terms)'): Promise<string> {
    const price = await this.markPrice();
    const st = await this.state();
    const rows: string[] = [];
    rows.push(`\n**${title}** (mark price ${fmtPrice(price)})\n`);
    rows.push(mdRow(['actor', 'quote in', 'quote out', 'tokens held', 'token value', 'net']));
    rows.push(mdRow(['---', '---:', '---:', '---:', '---:', '---:']));
    for (const actor of actors) {
      const e = this.ctx.pnl.get(actor.address) ?? { quoteSpent: 0n, quoteReceived: 0n };
      const bal = await this.ctx.tokenBalance(this.addrs.token, actor.address);
      // Locked tranche principal is still redeemable 1:1 — count it as quote value.
      const pos = await this.positionOf(actor);
      const committed = await this.read<bigint>(this.addrs.raise, ABIS.Raise, 'committedPrincipal');
      void committed;
      let lockedValue = 0n;
      if (st !== 4) {
        const states = await this.trancheStates(actor);
        for (let k = 1; k <= states.length; k++) {
          if (states[k - 1] === 0) {
            const info = (await this.read<[number, bigint, bigint, bigint, bigint]>(this.addrs.raise, ABIS.Raise, 'trancheInfo', [actor.address, k])) as [number, bigint, bigint, bigint, bigint];
            lockedValue += info[1];
          }
        }
      }
      const tokenValue = (bal * price) / 10n ** 18n;
      const net = e.quoteReceived - e.quoteSpent + tokenValue + lockedValue;
      void pos;
      rows.push(
        mdRow([actor.label, fmtQuote(e.quoteSpent), fmtQuote(e.quoteReceived), fmtToken(bal), fmtQuote(tokenValue + lockedValue), fmtSignedQuote(net)]),
      );
    }
    const table = rows.join('\n');
    this.ctx.log(table);
    return table;
  }
}

export { q, t };
