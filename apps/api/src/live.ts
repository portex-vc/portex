import { getAddress, type Abi, type Address, type PublicClient } from 'viem';
import {
  RaiseAbi, Stage2PoolAbi, DiamondVaultAbi, ProjectTokenAbi, MockUSDGAbi, MockDexAdapterAbi,
} from './generated/abis.ts';
import { batchRead } from './chain.ts';
import type { RaiseRow } from './db.ts';

const TRANCHE_STATES = ['Locked', 'Committed', 'Claimed', 'Redeemed'] as const;

export interface LiveDetail {
  epoch: number;
  gates: {
    commitment: {
      timeMet: boolean; capitalMet: boolean; beforeDeadline: boolean; vetoActive: boolean;
      principalNow: string; softCapRequired: string;
      optInCommitted: string; optInRequired: string; optInMet: boolean;
    };
    graduation: {
      epochNow: number; epochsRequired: number; poolR: string; minLiquidity: string;
      realRatioNow: number; minRealRatio: number;
    };
  };
  pool: { R: string; V: string; T: string; bookPrice: string; realRatioBps: number; builderAccrued: string } | null;
  vault: { totalStaked: string; totalWeight: string } | null;
  dex: { pair: string | null; price: string | null } | null;
}

/** Fresh, cheap state for the detail endpoint (batched via Multicall3 when available).
 *  `quoteDecimals` converts the pool's raw bookPrice (quote atoms per whole token) into
 *  the API convention: human quote-per-token scaled by 1e18. */
export async function readLiveDetail(
  client: PublicClient, row: RaiseRow, dexAdapter: string | null, quoteDecimals = 6,
): Promise<LiveDetail> {
  const raise = row.address as Address;
  const cfg = JSON.parse(row.config) as Record<string, string | number>;

  const calls: { address: Address; abi: Abi; functionName: string; args?: readonly unknown[] }[] = [
    { address: raise, abi: RaiseAbi as Abi, functionName: 'commitmentGates' },
    { address: raise, abi: RaiseAbi as Abi, functionName: 'graduationGates' },
    { address: raise, abi: RaiseAbi as Abi, functionName: 'currentEpoch' },
    { address: row.vault as Address, abi: DiamondVaultAbi as Abi, functionName: 'totalStaked' },
    { address: row.vault as Address, abi: DiamondVaultAbi as Abi, functionName: 'totalWeight' },
  ];
  const poolOpen = !!row.poolOpen;
  if (poolOpen) {
    calls.push(
      { address: row.pool as Address, abi: Stage2PoolAbi as Abi, functionName: 'reserves' },
      { address: row.pool as Address, abi: Stage2PoolAbi as Abi, functionName: 'bookPrice' },
      { address: row.pool as Address, abi: Stage2PoolAbi as Abi, functionName: 'realRatioBps' },
      { address: row.pool as Address, abi: Stage2PoolAbi as Abi, functionName: 'builderAccrued' },
    );
  }
  const migrated = row.state === 'Migrated' && !!dexAdapter;
  if (migrated) {
    calls.push(
      { address: dexAdapter as Address, abi: MockDexAdapterAbi as Abi, functionName: 'pairExists', args: [row.token] },
      { address: dexAdapter as Address, abi: MockDexAdapterAbi as Abi, functionName: 'getReserves', args: [row.token] },
    );
  }

  const r = await batchRead<unknown>(client, calls);
  let i = 0;
  const cg = r[i++] as Record<string, unknown>;
  const gg = r[i++] as Record<string, unknown>;
  const epoch = Number(r[i++]);
  const totalStaked = r[i++] as bigint;
  const totalWeight = r[i++] as bigint;

  let pool: LiveDetail['pool'] = null;
  if (poolOpen) {
    const reserves = r[i++] as [bigint, bigint, bigint] | { R: bigint; V: bigint; T: bigint };
    const [R, V, T] = Array.isArray(reserves) ? reserves : [reserves.R, reserves.V, reserves.T];
    const bookPrice = r[i++] as bigint;
    const realRatioBps = Number(r[i++]);
    const builderAccrued = r[i++] as bigint;
    const apiBookPrice = bookPrice * 10n ** BigInt(18 - quoteDecimals);
    pool = { R: R.toString(), V: V.toString(), T: T.toString(), bookPrice: apiBookPrice.toString(), realRatioBps, builderAccrued: builderAccrued.toString() };
  }

  let dex: LiveDetail['dex'] = null;
  if (migrated) {
    const pairExists = r[i++] as boolean;
    const reserves = r[i++] as [bigint, bigint];
    const scale = 10n ** BigInt(36 - quoteDecimals);
    dex = {
      pair: pairExists ? getAddress(dexAdapter!) : null,
      price: pairExists && reserves[1] > 0n ? (reserves[0] * scale / reserves[1]).toString() : null,
    };
  }

  return {
    epoch,
    gates: {
      commitment: {
        timeMet: !!cg.timeMet,
        capitalMet: !!cg.capitalMet,
        beforeDeadline: !!cg.beforeDeadline,
        vetoActive: !!cg.vetoActive,
        principalNow: String(cg.principalNow),
        softCapRequired: String(cg.softCapRequired),
        optInCommitted: String(cg.optInCommitted),
        optInRequired: String(cg.optInRequired),
        optInMet: !!cg.optInMet,
      },
      graduation: {
        epochNow: Number(gg.epochNow),
        epochsRequired: Number(gg.epochsRequired),
        poolR: String(gg.poolR),
        minLiquidity: String(gg.minLiquidity),
        realRatioNow: Number(gg.realRatioNow),
        minRealRatio: Number(gg.minRealRatio ?? cfg.minRealRatioBps ?? 0),
      },
    },
    pool,
    vault: { totalStaked: totalStaked.toString(), totalWeight: totalWeight.toString() },
    dex,
  };
}

export interface LivePosition {
  user: string;
  principal: string;
  tokenEntitlement: string;
  earlyFactor: string;
  withdrawLockedUntil: number;
  tranches: {
    k: number; state: (typeof TRANCHE_STATES)[number]; principal: string; tokens: string;
    commitTime: number; claimableTime: number;
  }[];
  vault: { staked: string; weight: string; pendingQuote: string; pendingToken: string };
  walletTokenBalance: string;
  walletQuoteBalance: string;
}

export async function readLivePosition(
  client: PublicClient, row: RaiseRow, user: string, quoteAsset: string,
): Promise<LivePosition> {
  const raise = row.address as Address;
  const cfg = JSON.parse(row.config) as Record<string, string | number>;
  const numTranches = Number(cfg.numTranches ?? 0);
  const u = getAddress(user);

  const calls: { address: Address; abi: Abi; functionName: string; args?: readonly unknown[] }[] = [
    { address: raise, abi: RaiseAbi as Abi, functionName: 'positionOf', args: [u] },
    { address: raise, abi: RaiseAbi as Abi, functionName: 'withdrawLockUntil', args: [u] },
    { address: row.vault as Address, abi: DiamondVaultAbi as Abi, functionName: 'stakeOf', args: [u] },
    { address: row.vault as Address, abi: DiamondVaultAbi as Abi, functionName: 'pendingRewards', args: [u] },
    { address: row.token as Address, abi: ProjectTokenAbi as Abi, functionName: 'balanceOf', args: [u] },
    { address: quoteAsset as Address, abi: MockUSDGAbi as Abi, functionName: 'balanceOf', args: [u] },
  ];
  for (let k = 1; k <= numTranches; k++) {
    calls.push({ address: raise, abi: RaiseAbi as Abi, functionName: 'trancheInfo', args: [u, k] });
  }
  const r = await batchRead<unknown>(client, calls);
  let i = 0;
  // positionOf -> (principal, shares, timeWeight, earlyFactor, tokenEntitlement, trancheBitmap)
  const pos = r[i++] as [bigint, bigint, bigint, bigint, bigint, bigint];
  const lockUntil = Number(r[i++]);
  const stake = r[i++] as [bigint, bigint];
  const pending = r[i++] as [bigint, bigint];
  const walletToken = r[i++] as bigint;
  const walletQuote = r[i++] as bigint;

  const tranches: LivePosition['tranches'] = [];
  for (let k = 1; k <= numTranches; k++) {
    const t = r[i++] as [number, bigint, bigint, bigint, bigint];
    tranches.push({
      k,
      state: TRANCHE_STATES[Number(t[0])] ?? 'Locked',
      principal: t[1].toString(),
      tokens: t[2].toString(),
      commitTime: Number(t[3]),
      claimableTime: Number(t[4]),
    });
  }

  return {
    user: u,
    principal: pos[0].toString(),
    tokenEntitlement: pos[4].toString(),
    earlyFactor: pos[3].toString(),
    withdrawLockedUntil: lockUntil,
    tranches,
    vault: {
      staked: stake[0].toString(), weight: stake[1].toString(),
      pendingQuote: pending[0].toString(), pendingToken: pending[1].toString(),
    },
    walletTokenBalance: walletToken.toString(),
    walletQuoteBalance: walletQuote.toString(),
  };
}
