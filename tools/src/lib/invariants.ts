// Invariant checker for design §6. Runs after every simulated step; any breach throws
// InvariantViolation naming the step that broke it.
//
// Checked per raise:
//  1. quote.balanceOf(raise) == raise.escrowedPrincipal()
//     (exact under Rule 1; Rule 2 governor spends floor the index so holders absorb dust —
//      a small positive slack is allowed only when a governor is wired).
//  2. quote.balanceOf(pool) == pool.R + pool.builderAccrued (vault share has left; V is virtual).
//  3. Pool solvency while Open: simulate a one-shot dump of every token held outside
//     pool/raise/vault (all tracked wallets, largest first, exact on-chain sell math).
//     Every sell must be payable from R, and V <= Q_final at the end. Also run the
//     stricter variant that additionally dumps the vault's staked tokens. V >= 0 always.
//  4. Token conservation: totalSupply == raise + pool + vault + dexAdapter + Σ tracked wallets.
//
// §6.2 ("every withdraw/redeem returned exactly the protected principal") is enforced
// inside the RaiseSim wrappers, which assert the wallet's quote delta around each call.
import type { Address } from 'viem';
import { ABIS } from './abis';
import { Ctx, InvariantViolation } from './context';
import { fmtQuote, fmtToken } from './format';

export interface RaiseAddrs {
  raise: Address;
  token: Address;
  pool: Address;
  vault: Address;
}

const BPS = 10_000n;

async function read<T>(ctx: Ctx, address: Address, abi: unknown, functionName: string, args: unknown[] = []): Promise<T> {
  return ctx.client.readContract({ address, abi: abi as never, functionName, args: args as never }) as Promise<T>;
}

export async function checkInvariants(ctx: Ctx, a: RaiseAddrs, where: string): Promise<void> {
  const fail = (msg: string): never => {
    throw new InvariantViolation(where, msg);
  };

  const [state, governor, escrowed, escrowBal] = await Promise.all([
    read<number>(ctx, a.raise, ABIS.Raise, 'state'),
    read<Address>(ctx, a.raise, ABIS.Raise, 'governor'),
    read<bigint>(ctx, a.raise, ABIS.Raise, 'escrowedPrincipal'),
    read<bigint>(ctx, ctx.quote, ABIS.MockUSDG, 'balanceOf', [a.raise]),
  ]);

  // 1. escrow
  if (escrowBal < escrowed) {
    fail(`escrow shortfall: balance ${fmtQuote(escrowBal)} < escrowedPrincipal ${fmtQuote(escrowed)}`);
  }
  const hasGovernor = governor !== '0x0000000000000000000000000000000000000000';
  const dust = escrowBal - escrowed;
  const dustLimit = hasGovernor ? 10_000n : 0n; // Rule 2 index flooring: holders absorb ≤ dust
  if (dust > dustLimit) {
    fail(`escrow surplus beyond rounding dust: ${fmtQuote(escrowBal)} vs escrowedPrincipal ${fmtQuote(escrowed)} (+${dust} wei)`);
  }

  // 2. pool quote balance == R + builderAccrued
  const [poolState, R, V, T, builderAccrued, poolBal] = await Promise.all([
    read<number>(ctx, a.pool, ABIS.Stage2Pool, 'poolState'),
    read<bigint>(ctx, a.pool, ABIS.Stage2Pool, 'R'),
    read<bigint>(ctx, a.pool, ABIS.Stage2Pool, 'V'),
    read<bigint>(ctx, a.pool, ABIS.Stage2Pool, 'T'),
    read<bigint>(ctx, a.pool, ABIS.Stage2Pool, 'builderAccrued'),
    read<bigint>(ctx, ctx.quote, ABIS.MockUSDG, 'balanceOf', [a.pool]),
  ]);
  if (poolBal !== R + builderAccrued) {
    fail(
      `pool quote balance ${fmtQuote(poolBal)} != R + builderAccrued (${fmtQuote(R)} + ${fmtQuote(builderAccrued)})`,
    );
  }
  if (V < 0n) fail('V < 0');

  // 3. solvency while the pool is Open: dump every outside token, exact sell math
  if (poolState === 1) {
    const [feeBps_, feeVaultBps_, feeBuilderBps_] = await Promise.all([
      read<bigint | number>(ctx, a.pool, ABIS.Stage2Pool, 'swapFeeBps'),
      read<bigint | number>(ctx, a.pool, ABIS.Stage2Pool, 'feeVaultBps'),
      read<bigint | number>(ctx, a.pool, ABIS.Stage2Pool, 'feeBuilderBps'),
    ]);
    // viem decodes uint16 as number — normalise before bigint arithmetic
    const feeBps = BigInt(feeBps_);
    const feeVaultBps = BigInt(feeVaultBps_);
    const feeBuilderBps = BigInt(feeBuilderBps_);
    const outside: bigint[] = [];
    for (const addr of ctx.actors.keys()) {
      const bal = await read<bigint>(ctx, a.token, ABIS.ProjectToken, 'balanceOf', [addr]);
      if (bal > 0n) outside.push(bal);
    }
    const staked = await read<bigint>(ctx, a.vault, ABIS.DiamondVault, 'totalStaked');

    const simulateDump = (bags: bigint[]): { ok: boolean; paid: bigint; culprit?: bigint } => {
      let r = R;
      let v = V;
      let t = T;
      let paid = 0n;
      for (const bag of [...bags].sort((x, y) => (x > y ? -1 : 1))) {
        if (bag === 0n) continue;
        const q = r + v;
        const newT = t + bag;
        const newQ = (q * t + newT - 1n) / newT; // ceil(Q·T/(T+in))
        const gross = q - newQ;
        const fee = (gross * feeBps) / BPS;
        const feeVault = (fee * feeVaultBps) / BPS;
        const feeBuilder = (fee * feeBuilderBps) / BPS;
        const feeReserve = fee - feeVault - feeBuilder;
        const rDelta = gross - feeReserve;
        if (rDelta > r) return { ok: false, paid, culprit: bag };
        r -= rDelta;
        t = newT;
        paid += gross - fee;
      }
      const qFinal = r + v;
      if (v > qFinal) return { ok: false, paid };
      return { ok: true, paid };
    };

    const spec = simulateDump(outside);
    if (!spec.ok) {
      fail(
        `pool insolvent under one-shot dump of ${outside.length} outside bags` +
          (spec.culprit ? ` (sell of ${fmtToken(spec.culprit)} exceeds R)` : ' (V > Q_final)') +
          ` after paying ${fmtQuote(spec.paid)}`,
      );
    }
    const strict = simulateDump([...outside, staked]);
    if (!strict.ok) {
      fail(`pool insolvent once vault-staked tokens (${fmtToken(staked)}) are also dumped`);
    }
  }

  // 4. token conservation: supply == pool + raise + vault + dexAdapter + Σ wallets
  const [supply, balRaise, balPool, balVault, balDex] = await Promise.all([
    read<bigint>(ctx, a.token, ABIS.ProjectToken, 'totalSupply'),
    read<bigint>(ctx, a.token, ABIS.ProjectToken, 'balanceOf', [a.raise]),
    read<bigint>(ctx, a.token, ABIS.ProjectToken, 'balanceOf', [a.pool]),
    read<bigint>(ctx, a.token, ABIS.ProjectToken, 'balanceOf', [a.vault]),
    read<bigint>(ctx, a.token, ABIS.ProjectToken, 'balanceOf', [ctx.deployment.dexAdapter]),
  ]);
  let walletSum = 0n;
  for (const addr of ctx.actors.keys()) {
    walletSum += await read<bigint>(ctx, a.token, ABIS.ProjectToken, 'balanceOf', [addr]);
  }
  const accounted = balRaise + balPool + balVault + balDex + walletSum;
  if (accounted !== supply) {
    fail(
      `token conservation broken: supply ${fmtToken(supply)} != raise ${fmtToken(balRaise)} + pool ${fmtToken(balPool)} + vault ${fmtToken(balVault)} + dex ${fmtToken(balDex)} + wallets ${fmtToken(walletSum)}`,
    );
  }

  void state;
}
