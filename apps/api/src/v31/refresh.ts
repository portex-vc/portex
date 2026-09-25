/**
 * Batched state refresh. After each indexed page the indexer calls `refresh(block)`: every raise marked dirty by the
 * page's logs (its core, token, governor, vesting, claims, treasury or its pool) is re-read once at that block, in
 * one Multicall3 `aggregate3` for all of them (viem's deployless multicall where Multicall3 is not deployed, e.g.
 * anvil; parallel reads as the last resort). The results land in `v31_state`; the API reads nothing else from chain.
 */
import { concat, getAddress, keccak256, pad, parseAbi, stringToHex, toHex, type Abi, type Address, type Hex, type PublicClient } from 'viem';
import * as A from '../generated/v31-abis.ts';
import type { DB } from '../db.ts';
import type { Config } from '../config.ts';
import { getDeploymentV31 } from './deployment.ts';
import { getRaiseV31, listRaisesV31, type RaiseV31Row } from './db.ts';
import { managerOf } from './market.ts';
import { dirtyRaises, setAllowance, stringify } from './state-db.ts';
import { background } from '../lib/rpc-metrics.ts';

export const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11' as const;
const EXTSLOAD = parseAbi(['function extsload(bytes32[] slots) view returns (bytes32[])']);
const POOLS_SLOT = pad(toHex(6), { size: 32 });
const REFRESH_LOG_EVERY_MS = 60_000;

export interface Call { address: Address; abi: Abi; functionName: string; args?: readonly unknown[] }
export type Read = { ok: true; value: any } | { ok: false; error: string };

/** Current rewards "day" (ProjectTokenV31 daily release index) of a listed token at `time`. */
export function rewardDay(listedAt: number, time: number): number {
  return listedAt ? Math.min(Math.floor(Math.max(0, time - listedAt) / 86400), 1095) : -1;
}

/** PoolManager storage slots of a pool's slot0 and active liquidity (StateLibrary layout). */
export function poolSlots(poolId: Hex): [Hex, Hex] {
  const base = keccak256(concat([poolId, POOLS_SLOT]));
  return [base, pad(toHex(BigInt(base) + 3n), { size: 32 })];
}
/** Decodes packed slot0 (sqrtPriceX96 | tick | protocolFee | lpFee) and liquidity words. */
export function decodePoolWords(slot0: Hex, liquidityWord: Hex) {
  const s = BigInt(slot0);
  const rawTick = Number((s >> 160n) & 0xffffffn);
  return {
    sqrtPriceX96: s & ((1n << 160n) - 1n), tick: rawTick >= 0x800000 ? rawTick - 0x1000000 : rawTick,
    protocolFee: Number((s >> 184n) & 0xffffffn), lpFee: Number((s >> 208n) & 0xffffffn),
    liquidity: BigInt(liquidityWord) & ((1n << 128n) - 1n),
  };
}

export class StateRefresherV31 {
  private mode: 'multicall3' | 'deployless' | 'parallel' | null = null;
  private lastLog = 0;
  /** Calls per refresh, for the RPC audit (background work). */
  readonly stats = { refreshes: 0, raises: 0, viewCalls: 0, rpcCalls: 0, lastBlock: 0, lastRaises: 0, lastViewCalls: 0, lastRpcCalls: 0, mode: '' };
  constructor(private db: DB, private client: PublicClient, private config: Config) {}

  /** Reads many views at one block; one failed view never fails the others. */
  async readMany(calls: Call[], blockNumber: bigint): Promise<Read[]> {
    if (!calls.length) return [];
    // Code presence is static: detect once (a failed read aborts this refresh and is retried, never cached).
    if (!this.mode) { const code = await this.client.getCode({ address: MULTICALL3 }); this.mode = code && code !== '0x' ? 'multicall3' : 'deployless'; }
    this.stats.mode = this.mode;
    if (this.mode !== 'parallel') {
      // Deployless results come back as constructor return data, capped at 24 KiB (EIP-170): chunk by call count.
      const size = this.mode === 'multicall3' ? calls.length : 16;
      const chunks: Call[][] = [];
      for (let i = 0; i < calls.length; i += size) chunks.push(calls.slice(i, i + size));
      const results: { status: 'success' | 'failure'; result?: unknown; error?: unknown }[] = [];
      for (let i = 0; i < chunks.length; i += 8) {
        const parts = await Promise.all(chunks.slice(i, i + 8).map((chunk) => this.client.multicall({
          contracts: chunk as never, allowFailure: true, blockNumber,
          ...(this.mode === 'multicall3' ? { multicallAddress: MULTICALL3, batchSize: 16_384 } : { deployless: true, batchSize: 0 }),
        } as never) as Promise<{ status: 'success' | 'failure'; result?: unknown; error?: unknown }[]>));
        results.push(...parts.flat());
      }
      const reads: Read[] = results.map((r) => (r.status === 'success' ? { ok: true as const, value: r.result } : { ok: false as const, error: String((r.error as any)?.shortMessage ?? r.error) }));
      // A node that cannot run the deployless program fails every call: fall back to plain reads for good.
      if (this.mode === 'deployless' && reads.length > 1 && reads.every((r) => !r.ok)) { this.mode = 'parallel'; return this.readMany(calls, blockNumber); }
      // A whole batch can fail without any view reverting (gas cap, response size, a lagging node): retry the failed
      // calls one by one once, so one oversized batch can never keep a raise from materializing.
      const failed = reads.map((r, i) => (r.ok ? -1 : i)).filter((i) => i >= 0);
      if (failed.length && failed.length <= 400) {
        const retried = await this.plainReads(failed.map((i) => calls[i]), blockNumber);
        failed.forEach((i, n) => { reads[i] = retried[n]; });
      }
      return reads;
    }
    return this.plainReads(calls, blockNumber);
  }
  private async plainReads(calls: Call[], blockNumber: bigint): Promise<Read[]> {
    const out: Read[] = [];
    for (let i = 0; i < calls.length; i += 8) {
      out.push(...await Promise.all(calls.slice(i, i + 8).map((c) => this.client.readContract({ ...c, args: c.args ?? [], blockNumber } as never)
        .then((value) => ({ ok: true as const, value }), (e) => ({ ok: false as const, error: String(e?.shortMessage ?? e) })))));
    }
    return out;
  }

  private positionIds(raise: string): string[] {
    return (this.db.query('SELECT id FROM v31_positions WHERE raiseAddr=? ORDER BY CAST(id AS INTEGER)').all(raise) as { id: string }[]).map((r) => r.id);
  }
  private proposalIds(raise: string): string[] {
    return (this.db.query('SELECT id FROM v31_proposals WHERE raiseAddr=? ORDER BY CAST(id AS INTEGER)').all(raise) as { id: string }[]).map((r) => r.id);
  }
  /** Diamond Hand quota holders: owners of backer positions frozen at listing. */
  private quotaHolders(raise: string): string[] {
    return (this.db.query("SELECT DISTINCT owner FROM v31_positions WHERE raiseAddr=? AND class=0 AND tokens!='0'").all(raise) as { owner: string }[]).map((r) => getAddress(r.owner));
  }

  /** The views one raise's materialized state consists of, tagged. */
  private plan(row: RaiseV31Row): { tag: string; call: Call }[] {
    const cfg = JSON.parse(row.config || '{}');
    const phase = Number(JSON.parse(row.state || '{}').phase ?? 0);
    const raise = row.address as Address;
    const out: { tag: string; call: Call }[] = [];
    const add = (tag: string, address: string, abi: Abi, functionName: string, args: readonly unknown[] = []) => out.push({ tag, call: { address: address as Address, abi, functionName, args } });
    for (const fn of ['stageDeadlines', 'reserveState', 'accounting', 'getConfig', 'feeAccruals', 'modules', 'governanceConfig', 'governanceState', 'listingRecord', 'eligibleCapital', 'listingPreview']) {
      add(fn, raise, A.RaiseCoreAbi, fn);
    }
    for (const fn of ['rewardState', 'totalQuota', 'rewardNonce', 'listedAt', 'totalSupply', 'disposedQuote', 'snapshotId', 'snapshotBlock', 'pendingDelivery']) {
      add(`token.${fn}`, row.token, A.ProjectTokenV31Abi, fn);
    }
    for (const fn of ['proposalsCount', 'activeProposalId', 'lastProposalAt', 'spendCapBps']) add(`governor.${fn}`, row.governor, A.GovernanceV31Abi, fn);
    if (phase === 3) add('governor.referencePrice', row.governor, A.GovernanceV31Abi, 'referencePrice');
    if (cfg.treasury) for (const fn of ['allocation', 'vestingDuration', 'spentQuote', 'spentTokens']) add(`treasury.${fn}`, cfg.treasury, A.TreasuryV31Abi, fn);
    add('claims.liability', row.claims, A.ClaimVaultAbi, 'liability');
    for (const id of this.positionIds(row.address)) {
      const n = BigInt(id);
      add(`pos.${id}.positionState`, raise, A.RaiseCoreAbi, 'positionState', [n]);
      add(`pos.${id}.guaranteedClaim`, raise, A.RaiseCoreAbi, 'guaranteedClaim', [n]);
      add(`pos.${id}.listingStatus`, raise, A.RaiseCoreAbi, 'listingStatus', [n]);
      add(`pos.${id}.atRiskBasis`, raise, A.RaiseCoreAbi, 'atRiskBasis', [n]);
      add(`pos.${id}.bounds`, raise, A.RaiseCoreAbi, 'futureClaimBounds', [n, 1]);
      if (phase === 4) add(`pos.${id}.claimable`, row.claims, A.ClaimVaultAbi, 'claimable', [n]);
    }
    for (const id of this.proposalIds(row.address)) {
      add(`prop.${id}.proposal`, row.governor, A.GovernanceV31Abi, 'getProposal', [BigInt(id)]);
      add(`prop.${id}.spendCapacity`, row.governor, A.GovernanceV31Abi, 'spendCapacity', [BigInt(id)]);
    }
    if (phase === 3) {
      for (const holder of this.quotaHolders(row.address)) add(`rew.${holder}`, row.token, A.ProjectTokenV31Abi, 'pendingRewards', [holder]);
      const pool = this.db.query('SELECT poolId FROM v31_pools WHERE raiseAddr=?').get(row.address) as { poolId: Hex } | null;
      const manager = managerOf(getDeploymentV31(this.config.chainId));
      if (pool && manager) add('pool', manager, EXTSLOAD as Abi, 'extsload', [poolSlots(pool.poolId)]);
    }
    return out;
  }

  /** Refreshes every dirty raise at `blockNumber` (the last indexed block). Raises whose core reads fail stay dirty. */
  async refresh(blockNumber: number, chainTime: number): Promise<number> {
    const rows = dirtyRaises(this.db).map((a) => getRaiseV31(this.db, a)).filter((r): r is RaiseV31Row => !!r);
    // A dirty mark for an unknown (rolled back) raise is dropped.
    for (const a of dirtyRaises(this.db)) if (!getRaiseV31(this.db, a)) this.db.query('DELETE FROM v31_dirty WHERE raiseAddr=?').run(a);
    if (!rows.length) return 0;
    const plans = rows.map((row) => ({ row, plan: this.plan(row) }));
    const calls = plans.flatMap((p) => p.plan.map((x) => x.call));
    const before = background.total;
    const reads = await this.readMany(calls, BigInt(blockNumber));
    let offset = 0;
    let refreshed = 0;
    const required = ['stageDeadlines', 'reserveState', 'accounting', 'getConfig', 'modules', 'governanceConfig', 'governanceState'];
    const writes: (() => void)[] = [];
    for (const { row, plan } of plans) {
      const got = new Map<string, Read>();
      for (const item of plan) got.set(item.tag, reads[offset++]);
      const failed = [...got].filter(([tag, r]) => !r.ok && (required.includes(tag) || tag.endsWith('.positionState')));
      if (failed.length) {
        if (Date.now() - this.lastLog > REFRESH_LOG_EVERY_MS) { this.lastLog = Date.now(); console.warn(`[v31 state] ${row.symbol || row.address}: ${failed[0][0]} failed (${(failed[0][1] as { error: string }).error.slice(0, 160)}); will retry`); }
        continue;
      }
      const v = (tag: string) => { const r = got.get(tag); return r?.ok ? r.value : null; };
      const group = (prefix: string) => Object.fromEntries([...got].filter(([t]) => t.startsWith(`${prefix}.`) && t.split('.').length === 2).map(([t, r]) => [t.slice(prefix.length + 1), r.ok ? r.value : null]));
      const pool = v('pool') as Hex[] | null;
      const token = group('token');
      const data = {
        deadlines: v('stageDeadlines'), reserve: v('reserveState'), accounting: v('accounting'), config: v('getConfig'), fees: v('feeAccruals'),
        modules: v('modules'), governanceConfig: v('governanceConfig'), governanceState: v('governanceState'), listingRecord: v('listingRecord'),
        eligibleCapital: v('eligibleCapital'), listingPreview: v('listingPreview'), token, governor: group('governor'), treasury: group('treasury'),
        claims: group('claims'), pool: pool ? decodePoolWords(pool[0], pool[1]) : null,
        rewardDay: rewardDay(Number(token.listedAt ?? 0), chainTime),
      };
      const positions = new Map<string, Record<string, unknown>>();
      const proposals = new Map<string, Record<string, unknown>>();
      const rewards: [string, unknown][] = [];
      for (const [tag, r] of got) {
        const parts = tag.split('.');
        if (parts[0] === 'pos') positions.set(parts[1], { ...(positions.get(parts[1]) ?? {}), [parts[2]]: r.ok ? r.value : null });
        if (parts[0] === 'prop') proposals.set(parts[1], { ...(proposals.get(parts[1]) ?? {}), [parts[2]]: r.ok ? r.value : null });
        if (parts[0] === 'rew' && r.ok) rewards.push([parts[1], r.value]);
      }
      writes.push(() => {
        const put = this.db.query('INSERT OR REPLACE INTO v31_state VALUES (?,?,?,?,?,?)');
        put.run('raise', row.address, '', blockNumber, chainTime, stringify(data));
        this.db.query("DELETE FROM v31_state WHERE raiseAddr=? AND kind IN ('position','proposal','rewards')").run(row.address);
        for (const [id, value] of positions) put.run('position', row.address, id, blockNumber, chainTime, stringify(value));
        for (const [id, value] of proposals) put.run('proposal', row.address, id, blockNumber, chainTime, stringify(value));
        for (const [holder, value] of rewards) put.run('rewards', row.address, holder.toLowerCase(), blockNumber, chainTime, stringify(value));
        this.db.query('DELETE FROM v31_dirty WHERE raiseAddr=?').run(row.address);
      });
      refreshed++;
    }
    this.db.transaction(() => { for (const w of writes) w(); })();
    Object.assign(this.stats, {
      refreshes: this.stats.refreshes + 1, raises: this.stats.raises + refreshed, viewCalls: this.stats.viewCalls + calls.length,
      lastBlock: blockNumber, lastRaises: refreshed, lastViewCalls: calls.length, lastRpcCalls: background.total - before, rpcCalls: this.stats.rpcCalls + background.total - before,
    });
    return refreshed;
  }

  /** Registry-backed `/config`: templates, versions, pinned spend caps and the quote freeze, re-read on registry events. */
  async refreshConfig(blockNumber: number, chainTime: number): Promise<void> {
    const dirty = (this.db.query("SELECT value FROM v31_meta WHERE key='configDirty'").get() as { value: string } | null)?.value;
    const stored = this.db.query("SELECT 1 FROM v31_state WHERE kind='config'").get();
    if (stored && dirty !== '1') return;
    const dep = getDeploymentV31(this.config.chainId);
    if (!dep?.registry) return;
    const registry = String(dep.registry) as Address;
    const quote = String(dep.quote ?? dep.mockUSDG) as Address;
    const block = BigInt(blockNumber);
    const names = ['ESCROW_LAUNCH', 'BUDGET_LAUNCH'];
    const ids = names.map((n) => keccak256(stringToHex(n)));
    const must = (r: Read) => { if (!r.ok) throw new Error(`config refresh: ${r.error}`); return r.value; };
    const reg = (functionName: string, args: readonly unknown[] = []) => ({ address: registry, abi: A.PortexRegistryV31Abi as Abi, functionName, args });
    const first = await this.readMany([...ids.map((id) => reg('versionCount', [id])), reg('curator'), reg('protocolParameters')], block);
    const slots = ids.flatMap((id, i) => Array.from({ length: Number(must(first[i])) }, (_, n) => ({ name: names[i], id, index: n })));
    const versions = (await this.readMany(slots.map((s) => reg('versionAt', [s.id, BigInt(s.index)])), block)).map(must);
    const values = (await this.readMany(slots.map((s, i) => reg('getVersion', [s.id, versions[i]])), block)).map(must);
    // Spend caps are pinned in each governor implementation; every quote any version names gets its freeze and code hash.
    const quotes = [...new Set([quote, ...values.map((v) => String(v.implementations.quote))].map((q) => getAddress(q)))];
    const last = await this.readMany([...values.map((v) => ({ address: v.implementations.governor, abi: A.GovernanceV31Abi as Abi, functionName: 'spendCapBps' })),
      ...quotes.flatMap((q) => [reg('quoteFrozen', [q]), reg('quoteCodeHash', [q])])], block);
    const caps = last.slice(0, values.length).map(must);
    const quoteInfo = Object.fromEntries(quotes.map((q, i) => [q, { frozen: must(last[values.length + 2 * i]), codeHash: must(last[values.length + 2 * i + 1]) }]));
    const data = { quote, quoteFrozen: quoteInfo[getAddress(quote)].frozen, curator: must(first[ids.length]), protocolParameters: must(first[ids.length + 1]),
      quotes: quoteInfo, templates: slots.map((s, i) => ({ name: s.name, id: s.id, version: versions[i], value: values[i], spendCapBps: caps[i] })) };
    this.db.transaction(() => {
      this.db.query('INSERT OR REPLACE INTO v31_state VALUES (?,?,?,?,?,?)').run('config', '', '', blockNumber, chainTime, stringify(data));
      this.db.query("INSERT OR REPLACE INTO v31_meta VALUES ('configDirty','0')").run();
    })();
  }

  /** Exact re-reads of finite allowances whose owners spent through `transferFrom` (no Approval event in OZ 5). */
  async refreshAllowances(blockNumber: number): Promise<void> {
    const dirty = this.db.query('SELECT token, owner FROM v31_allowance_dirty').all() as { token: string; owner: string }[];
    if (!dirty.length) return;
    const pairs = dirty.flatMap((d) => (this.db.query('SELECT spender FROM v31_allowances WHERE token=? AND owner=?').all(d.token, d.owner) as { spender: string }[])
      .map((s) => ({ token: d.token, owner: d.owner, spender: s.spender })));
    const reads = await this.readMany(pairs.map((p) => ({ address: p.token as Address, abi: A.MockUSDGV31Abi as Abi, functionName: 'allowance', args: [p.owner, p.spender] })), BigInt(blockNumber));
    this.db.transaction(() => {
      pairs.forEach((p, i) => { const r = reads[i]; if (r.ok) setAllowance(this.db, p.token, p.owner, p.spender, BigInt(r.value), blockNumber, 1e9); });
      if (reads.every((r) => r.ok)) for (const d of dirty) this.db.query('DELETE FROM v31_allowance_dirty WHERE token=? AND owner=?').run(d.token, d.owner);
    })();
  }

  /** Stage 3 raises whose daily reward release advanced since their last refresh (pendingRewards is time-dependent). */
  markRewardDays(chainTime: number): void {
    for (const row of listRaisesV31(this.db)) {
      if (Number(JSON.parse(row.state || '{}').phase) !== 3) continue;
      const s = this.db.query("SELECT data FROM v31_state WHERE kind='raise' AND raiseAddr=?").get(row.address) as { data: string } | null;
      if (!s) continue;
      const data = JSON.parse(s.data);
      if (rewardDay(Number(data.token?.listedAt ?? 0), chainTime) !== data.rewardDay) this.db.query('INSERT OR IGNORE INTO v31_dirty VALUES (?)').run(row.address);
    }
  }
}
