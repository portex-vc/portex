import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeEventLog, getAddress, toHex, type Abi, type Address, type Hex } from 'viem';
import { mnemonicToAccount, privateKeyToAccount } from 'viem/accounts';
import * as A from '@portex/api/generated/v31-abis';
import { makePublicClient, makeWalletClient, setBalance, warp, now, BUILDER, DEPLOYER, COUNCIL, type Actor } from './chain';
import { signRequest } from '@portex/api/lib/signed-request';
export { A };
export const DAY = 86400;
export const usd = (amount: number) => BigInt(amount) * 10n ** 6n;
export const token = (amount: number) => BigInt(amount) * 10n ** 18n;
export function check(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
export function backer(index: number): Actor {
  const hd = mnemonicToAccount('test test test test test test test test test test test junk', { addressIndex: index });
  const privateKey = toHex(hd.getHdKey().privateKey!);
  const account = privateKeyToAccount(privateKey);
  return { index, label: `v31-backer-${index}`, privateKey, account, address: account.address };
}
export class V31Context {
  readonly client;
  readonly deployment: Record<string, any>;
  readonly quote: Address;
  readonly backers = Array.from({ length: 10 }, (_, i) => backer(i + 4));
  readonly buyer = backer(14);
  readonly checks = new Map<string, number>();
  constructor(readonly rpcUrl: string, readonly apiUrl: string) {
    this.client = makePublicClient(rpcUrl);
    const dir = process.env.PORTEX_DEPLOYMENTS_DIR || resolve(dirname(fileURLToPath(import.meta.url)), '../../../packages/contracts/deployments');
    this.deployment = JSON.parse(readFileSync(resolve(dir, '31337-v31.json'), 'utf8'));
    check(!this.deployment.simulated, 'v3.1 manifest is a dry run');
    this.quote = this.deployment.mockUSDG;
  }
  wallet(actor: Actor) { return makeWalletClient(actor, this.rpcUrl); }
  async read<T = any>(address: string, abi: Abi, functionName: string, args: readonly unknown[] = []): Promise<T> {
    return this.client.readContract({ address: address as Address, abi, functionName, args } as never) as Promise<T>;
  }
  async write(actor: Actor, address: string, abi: Abi, functionName: string, args: readonly unknown[] = []) {
    const wallet = this.wallet(actor);
    const simulation = await this.client.simulateContract({ address: address as Address, abi, functionName, args, account: actor.account } as never);
    const hash = await wallet.writeContract({ ...simulation.request, account: actor.account, chain: wallet.chain } as never);
    const receipt = await this.client.waitForTransactionReceipt({ hash });
    check(receipt.status === 'success', `${functionName} reverted: ${hash}`);
    return receipt;
  }
  async fund(actor: Actor, amount = usd(1_000_000)) {
    await setBalance(this.client, actor.address, 100n * 10n ** 18n);
    await this.write(DEPLOYER, this.quote, A.MockUSDGV31Abi, 'mint', [actor.address, amount]);
  }
  async balance(actor: Actor): Promise<bigint> { return this.read(this.quote, A.MockUSDGV31Abi, 'balanceOf', [actor.address]); }
  async warpTo(timestamp: bigint | number) { const current = await now(this.client); if (BigInt(timestamp) > current) await warp(this.client, BigInt(timestamp) - current); }
  async warp(seconds: number) { return warp(this.client, seconds); }
  passed(label: string) { this.checks.set(label, (this.checks.get(label) ?? 0) + 1); }
  async api(path: string, init?: RequestInit): Promise<any> {
    const response = await fetch(`${this.apiUrl}${path}`, init);
    const body = await response.json();
    check(response.ok, `${path}: HTTP ${response.status} ${JSON.stringify(body)}`);
    return body;
  }
  async signed(actor: Actor, method: string, path: string, value: unknown): Promise<any> {
    const body = JSON.stringify(value);
    const headers = await signRequest(actor.account, method, path, body);
    return this.api(path, { method, headers: { 'content-type': 'application/json', ...headers }, body });
  }
  async waitIndexed() {
    const head = Number(await this.client.getBlockNumber({ cacheTime: 0 }));
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      const health = await this.api('/v2/health');
      if (health.ok && health.indexedBlock >= head) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('v3.1 indexer did not catch up');
  }
  async rejected(fn: () => Promise<unknown>, label: string) {
    let failed = false;
    try { await fn(); } catch (error) {
      // Transport failures are not evidence of an on-chain rejection.
      check(/revert|InvalidPhase|VenueFailure|InvalidAmount|Unauthorized/i.test(String(error)), `unexpected failure for ${label}: ${error}`);
      failed = true;
    }
    check(failed, `${label} unexpectedly succeeded`);
    this.passed(label);
  }
}
export class RaiseV31 {
  readonly ids: { id: bigint; actor: Actor }[] = [];
  constructor(readonly ctx: V31Context, readonly address: Address, readonly modules: Record<string, Address>, readonly name: string, readonly symbol: string) {}
  static async create(ctx: V31Context, name: string, symbol: string, budget = false, stage2Days = 70, valuation = 100_000, stage1Days = 15): Promise<RaiseV31> {
    const config = { quote: ctx.quote, treasury: COUNCIL.address, supply: token(1_000_000), targetPrice: BigInt(valuation) * 10n ** 12n,
      budgetCeiling: budget ? 3n * 10n ** 17n : 0n, stage1Length: BigInt(stage1Days * DAY), stage2Length: BigInt(stage2Days * DAY), builders: [] };
    const receipt = await ctx.write(BUILDER, ctx.deployment.factory, A.RaiseFactoryV31Abi, 'createRaise', [
      budget ? ctx.deployment.budgetTemplate : ctx.deployment.escrowTemplate, 1n, config, { name, symbol }]);
    for (const log of receipt.logs) {
      try {
        const e = decodeEventLog({ abi: A.RaiseFactoryV31Abi, topics: log.topics, data: log.data });
        if (e.eventName === 'RaiseCreated') return new RaiseV31(ctx, getAddress(e.args.raise), e.args.modules, name, symbol);
      } catch { /* Other module logs. */ }
    }
    throw new Error('missing RaiseCreated');
  }
  read<T = any>(functionName: string, args: readonly unknown[] = []): Promise<T> { return this.ctx.read(this.address, A.RaiseCoreAbi, functionName, args); }
  async action(actor: Actor, functionName: string, args: readonly unknown[] = []) {
    const receipt = await this.ctx.write(actor, this.address, A.RaiseCoreAbi, functionName, args);
    await this.solvent();
    return receipt;
  }
  async guarded(actor: Actor, fn: string, args: readonly unknown[]) {
    return this.action(actor, fn, [...args, await this.read('stateNonce'), (await now(this.ctx.client)) + 300n]);
  }
  async solvent() {
    const b = await this.read('reserveState');
    check(b.R * b.T >= b.V * b.O, `R*T < V*O at ${this.address}`);
    this.ctx.passed('Reserve R*T >= V*O after every action');
  }
  async deposit(actor: Actor, amount: bigint): Promise<bigint> {
    await this.ctx.write(actor, this.ctx.quote, A.MockUSDGV31Abi, 'approve', [this.address, amount]);
    const receipt = await this.guarded(actor, 'deposit', [amount, 0n]);
    for (const log of receipt.logs) {
      try {
        const event = decodeEventLog({ abi: A.RaiseCoreAbi, topics: log.topics, data: log.data });
        if (event.eventName === 'Deposited') { this.ids.push({ id: event.args.id, actor }); return event.args.id; }
      } catch { /* Other logs. */ }
    }
    throw new Error('deposit did not emit its position');
  }
  async fill() {
    for (const actor of this.ctx.backers) await this.deposit(actor, usd(1000));
    await this.deposit(this.ctx.backers[0], usd(100_000));
  }
  async open() { const d = await this.read('stageDeadlines'); await this.ctx.warpTo(d.stage1End); await this.action(DEPLOYER, 'advanceStage1'); check(await this.read('phase') === 1, 'Stage 2 did not open'); }
  async buy(actor: Actor, amount: bigint) {
    await this.ctx.write(actor, this.ctx.quote, A.MockUSDGV31Abi, 'approve', [this.address, amount]);
    return this.guarded(actor, 'buy', [amount, 1n]);
  }
  async exit(actor: Actor, id: bigint, protectedExit = false, quantity?: bigint) {
    const p = await this.read('positionState', [id]);
    const q = quantity ?? p.tokens;
    const cost = q === p.tokens ? p.basis : p.basis * q / p.tokens;
    const before = await this.ctx.balance(actor);
    await this.guarded(actor, protectedExit ? 'protectedExit' : 'exitAtCost', [id, q, cost]);
    const paid = (await this.ctx.balance(actor)) - before;
    check(protectedExit ? paid >= cost : paid === cost, `exit paid ${paid}; expected basis ${cost}`);
    this.ctx.passed(protectedExit ? 'Protected exits pay at least cost' : 'Cost exits pay exact basis');
    return { cost, paid };
  }
}
