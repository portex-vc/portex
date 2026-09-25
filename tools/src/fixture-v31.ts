/** Stable six-raise fixture consumed by the existing backend tests, never by the demo CLI. */
import { A, DAY, V31Context, RaiseV31, usd, check, backer } from './lib/v31';
import { BUILDER, DEPLOYER } from './lib/chain';

export async function seedV31(rpcUrl: string, apiUrl: string) {
  const ctx = new V31Context(rpcUrl, apiUrl);
  for (const actor of [...ctx.backers, ctx.buyer, BUILDER]) await ctx.fund(actor);
  const listed = await RaiseV31.create(ctx, 'Atlas Archive', 'ATLAS', false, 35);
  await listed.deposit(BUILDER, usd(200));
  await listed.fill(); await listed.open(); await listed.buy(ctx.buyer, usd(30000));
  await ctx.warpTo((await listed.read('stageDeadlines')).stage2End);
  await listed.action(DEPLOYER, 'list'); await ctx.warp(DAY);
  await ctx.write(ctx.backers[0], listed.modules.token, A.ProjectTokenV31Abi, 'claimRewards');
  const escrow = await RaiseV31.create(ctx, 'Signal Garden', 'SIGNAL');
  const budget = await RaiseV31.create(ctx, 'Open Bench', 'BENCH', true);
  const refunded = await RaiseV31.create(ctx, 'Retired Pilot', 'PILOT');
  await escrow.fill(); await budget.fill();
  for (const actor of ctx.backers.slice(0, 3)) await refunded.deposit(actor, usd(300));
  await escrow.open(); await budget.open();
  await ctx.warpTo((await refunded.read('stageDeadlines')).stage1End);
  await refunded.action(DEPLOYER, 'advanceStage1');
  await escrow.buy(ctx.buyer, usd(60000)); await escrow.exit(ctx.backers[1], escrow.ids[1].id);
  await ctx.write(BUILDER, budget.modules.governor, A.GovernanceV31Abi, 'propose', [usd(500), 'fixture://budget/milestone-1']);
  for (const p of budget.ids) await ctx.write(p.actor, budget.modules.governor, A.GovernanceV31Abi, 'vote', [1n, p.id, true]);
  const proposal = await ctx.read(budget.modules.governor, A.GovernanceV31Abi, 'getProposal', [1n]);
  await ctx.warpTo(proposal.votingEnds);
  await ctx.write(DEPLOYER, budget.modules.governor, A.GovernanceV31Abi, 'finalize', [1n]);
  await ctx.warpTo(proposal.disputeEnds);
  await ctx.write(DEPLOYER, budget.modules.governor, A.GovernanceV31Abi, 'execute', [1n]);
  const profit = await escrow.exit(ctx.backers[2], escrow.ids[2].id, true);
  check(profit.paid > profit.cost, 'fixture protected exit must realize profit');
  await escrow.guarded(ctx.buyer, 'sell', [(await escrow.read('buyerTokens', [ctx.buyer.address])) / 10n, 0n]);
  const fresh = await RaiseV31.create(ctx, 'Fresh Harbor', 'HARBOR');
  const veto = await RaiseV31.create(ctx, 'Cluster Watch', 'WATCH');
  const cluster = [backer(20), backer(21), backer(22)];
  for (const actor of cluster) {
    await ctx.fund(actor, 1n);
    await ctx.write(BUILDER, ctx.quote, A.MockUSDGV31Abi, 'transfer', [actor.address, usd(1000)]);
    await veto.deposit(actor, usd(500));
  }
  const manifest = [];
  for (const raise of [fresh, veto, escrow, budget, listed, refunded]) {
    await ctx.waitIndexed();
    const path = `/v2/raises/${raise.address}`;
    await ctx.signed(BUILDER, 'PUT', `${path}/profile`, { name: raise.name, tagline: 'Backend integration fixture', description: 'Fixed lifecycle fixture for API regression assertions.', website: '', twitter: '', github: '', docs: '' });
    await ctx.signed(BUILDER, 'POST', `${path}/updates`, { title: 'Fixture created', body: 'Lifecycle fixture ready for API assertions.', kind: 'milestone' });
    const author = raise === veto ? cluster[0] : ctx.backers[0];
    const text = `Reviewed ${raise.name} API fixture.`;
    const signature = await author.account.signMessage({ message: `Portex feedback\nraise: ${raise.address.toLowerCase()}\nrating: 4\ntext: ${text}` });
    await ctx.api(`${path}/feedback`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ author: author.address, rating: 4, text, signature }) });
    const analysis = await ctx.signed(BUILDER, 'POST', `${path}/analyze`, {});
    if (raise === veto) check(analysis.veto && analysis.postedTx, 'fixture analyst veto missing');
    await ctx.waitIndexed();
    const d = await ctx.api(path);
    manifest.push({ address: raise.address, name: raise.name, symbol: raise.symbol, phase: d.phase, vetoActive: d.vetoActive });
  }
  return manifest;
}
