import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { A, DAY, V31Context, RaiseV31, usd, check, token } from './lib/v31';
import { BUILDER, DEPLOYER, snapshot, revert } from './lib/chain';
import { verifySeedV31 } from './verify-seed-v31';

/** Mutates only the explicitly selected disposable chain; failures always propagate. */
export async function simulateV31(rpcUrl: string, apiUrl: string) {
  check([rpcUrl, apiUrl].every((url) => !['8545', '8790', '3100'].includes(new URL(url).port)), 'v3.1 simulation refuses the running demo ports');
  const ctx = new V31Context(rpcUrl, apiUrl);
  check(await ctx.client.getChainId() === 31337, 'simulation requires local chain 31337');
  check((await ctx.api('/v2/health')).ok, 'v2 health is not ready');
  const resultRows: { scenario: string; result: string; checks: number }[] = [];
  let failure: unknown;
  const saved = await snapshot(ctx.client);
  const originalHead = Number(await ctx.client.getBlockNumber({ cacheTime: 0 }));
  const originalRows = await ctx.api('/v2/raises');
  const hasSeed = originalRows.some((r: any) => r.symbol === 'PING');
  try {
    if (hasSeed) await verifySeedV31(ctx);
    else check(!process.argv.includes('--require-seed'), 'seed scenarios require the seven demo projects');
    for (const actor of [...ctx.backers, ctx.buyer, BUILDER]) await ctx.fund(actor);
    const escrow = await RaiseV31.create(ctx, 'Simulation Escrow', 'SIMESC', false, 35);
    const budget = await RaiseV31.create(ctx, 'Simulation Budget', 'SIMBUD', true, 35);
    const refund = await RaiseV31.create(ctx, 'Simulation Refund', 'SIMREF', false, 35);
    await escrow.deposit(BUILDER, usd(200));
    const partialId = await escrow.deposit(ctx.backers[0], usd(1200));
    const partial = await escrow.read('positionState', [partialId]);
    await escrow.exit(ctx.backers[0], partialId, false, partial.tokens / 3n);
    await escrow.exit(ctx.backers[0], partialId);
    await escrow.fill(); await budget.fill();
    for (const actor of [BUILDER, ...ctx.backers.slice(0, 3)]) await refund.deposit(actor, usd(200));
    await ctx.rejected(() => ctx.write(ctx.backers[0], escrow.modules.token, A.ProjectTokenV31Abi, 'transfer', [ctx.buyer.address, 1n]), 'No ERC-20 transfer before listing');
    await ctx.write(ctx.backers[0], escrow.modules.token, A.ProjectTokenV31Abi, 'approve', [ctx.buyer.address, 1n]);
    await ctx.rejected(() => ctx.write(ctx.buyer, escrow.modules.token, A.ProjectTokenV31Abi, 'transferFrom', [ctx.backers[0].address, ctx.buyer.address, 1n]), 'No ERC-20 transfer before listing');
    await escrow.open(); await budget.open();
    await refund.action(DEPLOYER, 'advanceStage1');
    await ctx.waitIndexed();
    for (const p of refund.ids) {
      const original = await refund.read('dissolutionRecord', [p.id]);
      const positions = await ctx.api(`/v2/raises/${refund.address}/positions/${p.actor.address}`);
      check(positions.positions.find((x: any) => x.id === String(p.id)).guaranteedClaim.amount === String(original[2]), 'API refund claim differs from chain');
      const before = await ctx.balance(p.actor);
      await ctx.write(p.actor, refund.modules.claims, A.ClaimVaultAbi, 'claim', [p.id]);
      check((await ctx.balance(p.actor)) - before === original[2], 'refund differs from exact basis');
      const after = await ctx.api(`/v2/raises/${refund.address}/positions/${p.actor.address}`);
      check(after.positions.find((x: any) => x.id === String(p.id)).guaranteedClaim.amount === '0', 'paid refund still exposed');
      ctx.passed('Refund pays every backer and builder exactly');
    }
    check(await ctx.read(refund.modules.claims, A.ClaimVaultAbi, 'liability') === 0n, 'unpaid refund liability');
    await escrow.buy(ctx.buyer, usd(60_000));
    const outside = await escrow.read('buyerTokens', [ctx.buyer.address]);
    await escrow.guarded(ctx.buyer, 'sell', [outside / 7n, 0n]);
    await ctx.rejected(() => ctx.write(ctx.buyer, escrow.modules.token, A.ProjectTokenV31Abi, 'transfer', [ctx.backers[0].address, 1n]), 'No ERC-20 transfer before listing');
    await escrow.exit(ctx.backers[1], escrow.ids.find((p) => p.actor.address === ctx.backers[1].address)!.id);
    const beforeClaims = await Promise.all(budget.ids.map((p) => budget.read('positionState', [p.id])));
    await ctx.write(BUILDER, budget.modules.governor, A.GovernanceV31Abi, 'propose', [usd(500), 'simulation://budget']);
    for (const p of budget.ids) await ctx.write(p.actor, budget.modules.governor, A.GovernanceV31Abi, 'vote', [1n, p.id, true]);
    const proposal = await ctx.read(budget.modules.governor, A.GovernanceV31Abi, 'getProposal', [1n]);
    await ctx.warpTo(proposal.votingEnds);
    await ctx.write(DEPLOYER, budget.modules.governor, A.GovernanceV31Abi, 'finalize', [1n]);
    await ctx.warpTo(proposal.disputeEnds);
    await ctx.write(DEPLOYER, budget.modules.governor, A.GovernanceV31Abi, 'execute', [1n]);
    const reserve = await budget.read('reserveState');
    for (let i = 0; i < budget.ids.length; i++) {
      const p = await budget.read('positionState', [budget.ids[i].id]);
      check(p.basis === BigInt(beforeClaims[i].shares) * BigInt(reserve.J) / 10n ** 18n && p.basis < beforeClaims[i].basis, 'haircut is not pro rata at the common share index');
      ctx.passed('Budget haircut reduces every claim pro rata');
    }
    await ctx.waitIndexed();
    const budgetDetail = await ctx.api(`/v2/raises/${budget.address}`);
    check(budgetDetail.reserveState.J === String(reserve.J), 'API common index differs');
    check((await ctx.api(`/v2/raises/${budget.address}/proposals`))[0].state === 'Executed', 'API missed executed proposal');
    await budget.exit(budget.ids[0].actor, budget.ids[0].id);
    const protectedId = escrow.ids.find((p) => p.actor.address === ctx.backers[2].address)!.id;
    const fullApi = await ctx.api(`/v2/raises/${escrow.address}/positions/${ctx.backers[2].address}`);
    const full = fullApi.positions.find((p: any) => p.id === String(protectedId));
    check(full.protectedExitQuote.validity.available && BigInt(full.protectedExitQuote.result.payout) >= BigInt(full.guaranteedClaim.amount), 'API protected quote violates basis');
    const profit = await escrow.exit(ctx.backers[2], protectedId, true);
    check(profit.paid > profit.cost, 'outside demand should fund a positive protected profit');
    ctx.passed('Protected exit realizes profit from outside demand');
    await ctx.warpTo((await escrow.read('stageDeadlines')).stage2End);
    // Deadline alone changes effective phase; no mutating call is made first.
    const pending = await ctx.api(`/v2/raises/${escrow.address}`);
    check(pending.phase === 'ListingPending' && pending.listingPreview.validity.available, 'eventless deadline did not expose ListingPending');
    const pendingPosition = await ctx.api(`/v2/raises/${escrow.address}/positions/${ctx.backers[3].address}`);
    check(pendingPosition.positions[0].redeemQuote.validity.available && pendingPosition.positions[0].protectedExitQuote === null, 'pending quote gates are wrong');
    const pendingBuyer = await ctx.api(`/v2/raises/${escrow.address}/positions/${ctx.buyer.address}`);
    check(pendingBuyer.buyerLedger.marketExitQuote.validity.available, 'buyer cannot sell while pending');
    ctx.passed('API derives ListingPending from chain time');
    // The local venue is the real v4 PoolManager: an outage is its code swapped for a bare revert, storage kept.
    const managerCode = await ctx.client.getCode({ address: ctx.deployment.poolManager });
    await ctx.client.request({ method: 'anvil_setCode', params: [ctx.deployment.poolManager, '0x60006000fd'] } as never);
    const nonce = await escrow.read('stateNonce');
    await ctx.rejected(() => escrow.action(DEPLOYER, 'list'), 'Failed listing is atomic and retryable');
    check(await escrow.read('stateNonce') === nonce, 'failed listing changed nonce');
    await escrow.exit(ctx.backers[3], escrow.ids.find((p) => p.actor.address === ctx.backers[3].address)!.id);
    await escrow.guarded(ctx.buyer, 'sell', [(await escrow.read('buyerTokens', [ctx.buyer.address])) / 9n, 0n]);
    await ctx.client.request({ method: 'anvil_setCode', params: [ctx.deployment.poolManager, managerCode] } as never);
    await escrow.action(DEPLOYER, 'advanceDepth');
    const finalBook = await escrow.read('reserveState');
    const price = (finalBook.E + finalBook.R) * 10n ** 30n / finalBook.T;
    const preview = await escrow.read('listingPreview');
    check(preview.price === price, 'preview differs from final book price');
    await escrow.action(DEPLOYER, 'list');
    await ctx.waitIndexed();
    const listed = await ctx.api(`/v2/raises/${escrow.address}`);
    const history = await ctx.api(`/v2/raises/${escrow.address}/price-history`);
    check(listed.phase === 'Stage3' && listed.listingRecord.sqrtPriceX96 === String(preview.sqrtPriceX96), 'listing receipt differs from preview');
    check(history.find((p: any) => p.event === 'ListingFinalized').price === String(price), 'indexed listing price differs from final book');
    ctx.passed('Listing uses the final canonical book price');
    const tokenAddress = escrow.modules.token;
    const owner = ctx.backers[0];
    const quota = await ctx.read(tokenAddress, A.ProjectTokenV31Abi, 'quotaOf', [owner.address]);
    const frozenNonce = await escrow.read('stateNonce');
    await ctx.warp(DAY);
    await ctx.write(owner, tokenAddress, A.ProjectTokenV31Abi, 'claimRewards');
    const amount = quota / 3n;
    const recipientQuota = await ctx.read(tokenAddress, A.ProjectTokenV31Abi, 'quotaOf', [ctx.buyer.address]);
    await ctx.write(owner, tokenAddress, A.ProjectTokenV31Abi, 'transfer', [ctx.buyer.address, amount]);
    check(await ctx.read(tokenAddress, A.ProjectTokenV31Abi, 'quotaOf', [owner.address]) === quota - amount, 'sender quota not destroyed');
    check(await ctx.read(tokenAddress, A.ProjectTokenV31Abi, 'quotaOf', [ctx.buyer.address]) === recipientQuota, 'recipient acquired quota');
    check(await escrow.read('stateNonce') === frozenNonce, 'raise nonce changed after listing');
    const position = await ctx.api(`/v2/raises/${escrow.address}/positions/${owner.address}`);
    check(position.quota === String(quota - amount) && position.positions.every((p: any) => p.guaranteedClaim.amount === '0'), 'post-list API counted frozen basis/quota');
    ctx.passed('Diamond Hand transfer destroys sender quota');
    await ctx.warp(31 * DAY);
    await ctx.write(BUILDER, escrow.modules.vesting, A.VestingVaultV31Abi, 'claim', [BUILDER.address]);
    await ctx.waitIndexed();
    const activity = await ctx.api(`/v2/raises/${escrow.address}/activity?all=1&limit=500`);
    for (const event of ['Deposited', 'AtCostExited', 'ProtectedSplitExecuted', 'MarketBought', 'MarketSold', 'DepthAdvanced', 'ListingFinalized', 'TokenActivated', 'RewardsClaimed', 'QuotaDestroyed', 'TokensBurned', 'VestedClaimed']) {
      check(activity.some((e: any) => e.kind === event), `missing indexed event ${event}`);
    }
    const trades = await ctx.api(`/v2/raises/${escrow.address}/trades?limit=500`);
    for (const trade of trades) if (trade.data.balances) {
      const b = trade.data.balances;
      check(BigInt(b.R) * BigInt(b.T) >= BigInt(b.V) * BigInt(b.O), 'API event book is insolvent');
    }
    const bookEvents = activity.filter((e: any) => ['Deposited', 'AtCostExited', 'ProtectedSplitExecuted', 'MarketBought', 'MarketSold', 'DepthAdvanced', 'PhaseChanged', 'ListingFinalized'].includes(e.kind));
    const prices = await ctx.api(`/v2/raises/${escrow.address}/price-history`);
    for (const event of bookEvents) check(prices.some((p: any) => p.txHash === event.txHash && p.logIndex === event.logIndex), `missing price point for ${event.kind}`);
    const refunds = await ctx.api(`/v2/raises/${refund.address}/activity?all=1&limit=500`);
    check(refunds.filter((e: any) => e.kind === 'DissolutionClaimed').length === refund.ids.length, 'missing dissolution claim events');
    ctx.passed('API indexes trades, every price change, claims and vesting');
  } catch (error) { failure = error; }
  finally {
    await revert(ctx.client, saved);
    // Wait for exact rollback, not indexedBlock >= head (which can still describe the future).
    const deadline = Date.now() + 30_000;
    let restored = false;
    while (Date.now() < deadline) {
      const health = await ctx.api('/v2/health');
      if (health.ok && health.indexedBlock === originalHead && health.head === originalHead) { restored = true; break; }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    check(restored, 'indexer did not restore the seed snapshot');
    const rows = await ctx.api('/v2/raises');
    check(rows.length === originalRows.length, 'simulation left extra raises behind');
    if (!failure && hasSeed) await verifySeedV31(ctx);
  }
  for (const [scenario, count] of ctx.checks) resultRows.push({ scenario, result: 'PASS', checks: count });
  if (failure) resultRows.push({ scenario: failure instanceof Error ? failure.message.split('\n')[0] : String(failure), result: 'FAIL', checks: 0 });
  const table = ['| v3.1 scenario | result | checks |', '|---|---|---:|', ...resultRows.map((r) => `| ${r.scenario} | ${r.result} | ${r.checks} |`)];
  console.log('\n' + table.join('\n'));
  console.log(`V3.1 simulation: ${failure ? 'FAIL' : 'PASS'}; exit code ${failure ? 1 : 0}`);
  const dir = process.env.PORTEX_RESULTS_DIR || resolve(dirname(fileURLToPath(import.meta.url)), '../artifacts/v31');
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, 'simulation.txt'), table.join('\n') + `\nV3.1 simulation: ${failure ? 'FAIL' : 'PASS'}; exit code ${failure ? 1 : 0}\n`);
  if (failure) throw failure;
}
