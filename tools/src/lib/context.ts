// Simulation context: one per scenario. Holds the chain connection, the deployment,
// the actor registry (every wallet the invariant checker must account for), per-actor
// quote-flow P&L, and the narrative log that becomes research/sim-results/<scenario>.md.
import type { Address, PublicClient, WalletClient } from 'viem';
import {
  type Actor,
  makePublicClient,
  makeWalletClient,
  warp as rpcWarp,
  now as rpcNow,
} from './chain';
import { ABIS, type Deployment } from './abis';
import { fmtDuration, fmtQuote, fmtToken, shortAddr } from './format';

export interface PnlEntry {
  label: string;
  quoteSpent: bigint; // deposits + buys (quote that left the wallet into the protocol)
  quoteReceived: bigint; // withdraws + redeems + sells + rewards + fee claims
}

export class InvariantViolation extends Error {
  constructor(
    public readonly stepLabel: string,
    message: string,
  ) {
    super(`INVARIANT VIOLATION at step "${stepLabel}": ${message}`);
    this.name = 'InvariantViolation';
  }
}

export class Ctx {
  readonly client: PublicClient;
  readonly deployment: Deployment;
  readonly quote: Address;

  private wallets = new Map<Address, WalletClient>();
  readonly actors = new Map<Address, Actor>(); // tracked wallets (invariants + P&L)
  readonly pnl = new Map<Address, PnlEntry>();
  readonly lines: string[] = [];
  stepNo = 0;
  /** Set false to skip the invariant check (e.g. while deliberately probing reverts). */
  checksEnabled = true;

  constructor(
    readonly rpcUrl: string,
    deployment: Deployment,
    readonly scenarioId: string,
  ) {
    this.client = makePublicClient(rpcUrl);
    this.deployment = deployment;
    this.quote = deployment.mockUSDG;
  }

  wallet(actor: Actor): WalletClient {
    let w = this.wallets.get(actor.address);
    if (!w) {
      w = makeWalletClient(actor, this.rpcUrl);
      this.wallets.set(actor.address, w);
    }
    return w;
  }

  track(actor: Actor): Actor {
    this.actors.set(actor.address, actor);
    return actor;
  }

  labelOf(addr: Address): string {
    const a = this.actors.get(addr);
    return a ? a.label : shortAddr(addr);
  }

  // ---- narrative ----

  log(msg = ''): void {
    this.lines.push(msg);
    console.log(msg);
  }

  step(msg: string): void {
    this.stepNo += 1;
    this.log(`\n**Step ${this.stepNo} — ${msg}**`);
  }

  note(msg: string): void {
    this.log(`- ${msg}`);
  }

  // ---- P&L ----

  private pnlOf(addr: Address): PnlEntry {
    let e = this.pnl.get(addr);
    if (!e) {
      e = { label: this.labelOf(addr), quoteSpent: 0n, quoteReceived: 0n };
      this.pnl.set(addr, e);
    }
    return e;
  }

  spent(actor: Actor, amount: bigint): void {
    this.pnlOf(actor.address).quoteSpent += amount;
  }

  received(actor: Actor, amount: bigint): void {
    this.pnlOf(actor.address).quoteReceived += amount;
  }

  // ---- time ----

  async warp(seconds: number | bigint, note?: string): Promise<bigint> {
    const ts = await rpcWarp(this.client, seconds);
    const when = new Date(Number(ts) * 1000).toISOString().slice(11, 19);
    this.note(
      `⏱ time +${fmtDuration(seconds)} → chain time ${when}${note ? ` (${note})` : ''}`,
    );
    return ts;
  }

  async now(): Promise<bigint> {
    return rpcNow(this.client);
  }

  // ---- faucet (MockUSDG has an open mint) ----

  async faucet(actor: Actor, amount: bigint): Promise<void> {
    const hash = await this.wallet(actor).writeContract({
      address: this.quote,
      abi: ABIS.MockUSDG,
      functionName: 'mint',
      args: [actor.address, amount],
      chain: undefined,
      account: actor.account,
    });
    await this.client.waitForTransactionReceipt({ hash });
  }

  async quoteBalance(addr: Address): Promise<bigint> {
    return this.client.readContract({
      address: this.quote,
      abi: ABIS.MockUSDG,
      functionName: 'balanceOf',
      args: [addr],
    }) as Promise<bigint>;
  }

  async tokenBalance(token: Address, addr: Address): Promise<bigint> {
    return this.client.readContract({
      address: token,
      abi: ABIS.ProjectToken,
      functionName: 'balanceOf',
      args: [addr],
    }) as Promise<bigint>;
  }

  summary(line: string): void {
    this.log(`\n> ${line}`);
  }
}

/** Assert helper for expected reverts. With `match`, also verifies the error names the expected reason. */
export async function expectRevert(
  fn: () => Promise<unknown>,
  ctx: Ctx,
  what: string,
  match?: string,
): Promise<string> {
  try {
    await fn();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const short = msg.split('\n')[0].slice(0, 160);
    ctx.note(`expected revert on ${what}: \`${short}\``);
    if (match && !msg.includes(match)) {
      throw new Error(`Expected ${what} to revert with ${match}, got: ${short}`);
    }
    return msg;
  }
  throw new Error(`Expected ${what} to revert, but it succeeded`);
}

export { fmtQuote, fmtToken, shortAddr };
