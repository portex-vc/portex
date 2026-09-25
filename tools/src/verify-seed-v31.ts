import { A, DAY, V31Context, check, usd } from './lib/v31';
import { PROJECTS, type DemoSymbol } from './demo-projects';

/** Verify live API/contract evidence, not the seed's self-reported manifest. */
export async function verifySeedV31(ctx: V31Context) {
  await ctx.waitIndexed();
  const rows = await ctx.api('/v2/raises');
  const phases: Record<DemoSymbol, string> = { PING: 'Stage1', REYE: 'Stage1', QORM: 'Stage2', FORGE: 'Stage2', DOCK: 'ListingPending', CART: 'Stage3', VAPR: 'Dissolved' };
  for (const symbol of Object.keys(PROJECTS) as DemoSymbol[]) {
    const row = rows.find((r: any) => r.symbol === symbol);
    check(row && rows.filter((r: any) => r.symbol === symbol).length === 1, `seed missing/duplicated: ${symbol}`);
    const path = `/v2/raises/${row.address}`;
    const [d, trades, updates, feedback, activity] = await Promise.all([
      ctx.api(path), ctx.api(`${path}/trades?limit=500`), ctx.api(`${path}/updates`), ctx.api(`${path}/feedback`), ctx.api(`${path}/activity?all=1&limit=500`),
    ]);
    check(d.phase === phases[symbol], `${symbol}: expected ${phases[symbol]}, got ${d.phase}`);
    check(d.template === (symbol === 'FORGE' ? 'BUDGET_LAUNCH' : 'ESCROW_LAUNCH'), `${symbol}: wrong template`);
    check(d.name === PROJECTS[symbol].name && d.riskScoreBps !== null && d.latestReport, `${symbol}: missing profile/analysis`);
    check(d.profile.tagline === PROJECTS[symbol].tagline && d.profile.description === PROJECTS[symbol].description && d.profile.website && d.profile.twitter && d.profile.logoUrl, `${symbol}: incomplete content`);
    check(updates.length === 2 && updates.some((u: any) => u.kind === 'milestone') && updates.some((u: any) => u.kind === 'update'), `${symbol}: updates missing`);
    check(feedback.length >= 1 && feedback.length <= 2 && feedback.every((f: any) => f.isBacker), `${symbol}: signed backer feedback missing`);
    const valuation = BigInt(d.config.supply) * BigInt(d.targetPrice) / 10n ** 36n;
    check(valuation >= 100000n && valuation <= 2000000n, `${symbol}: valuation out of range`);
    const deposits = trades.filter((t: any) => t.type === 'deposit');
    const originalOwners = new Set(deposits.map((t: any) => t.trader));
    check(originalOwners.size >= 3 && originalOwners.size <= 12 && new Set(deposits.map((t: any) => t.quote)).size >= 3, `${symbol}: backer count/deposit variety`);
    check(Math.max(...trades.map((t: any) => t.timestamp)) - Math.min(...trades.map((t: any) => t.timestamp)) >= DAY, `${symbol}: history is not spread over days`);
    if (['QORM', 'FORGE', 'DOCK', 'CART'].includes(symbol)) {
      const market = trades.filter((t: any) => t.type === 'buy' || t.type === 'sell');
      check(market.length >= 8 && market.length <= 20 && trades.length <= 20, `${symbol}: insufficient trade history`);
    }
    if (['PING', 'REYE', 'QORM', 'FORGE', 'DOCK'].includes(symbol)) check(BigInt(d.E) >= usd(10000) && BigInt(d.E) < usd(100000), `${symbol}: escrow should be tens of thousands`);
    if (symbol === 'PING') {
      check(d.backers === 4 && !d.vetoActive && d.deadlines.stage1End - d.chainTime > 20 * DAY, 'fresh Stage 1 gates/deadline');
      ctx.passed('Seed Pinger: fresh Escrow, four backers, future deadline');
    } else if (symbol === 'REYE') {
      check(d.backers === 3 && d.vetoActive && d.latestReport.veto && d.latestReport.postedTx && d.deadlines.vetoUntil > d.chainTime, 'active analyst veto missing');
      ctx.passed('Seed RelayEye: Stage 1 with an active analyst veto');
    } else if (symbol === 'QORM') {
      check(d.backers === 8 && trades.some((t: any) => t.type === 'costExit'), 'Escrow cost exit/count missing');
      const profit = trades.find((t: any) => t.type === 'protectedExit');
      check(profit && BigInt(profit.data.result.profit) > 0n && BigInt(profit.data.result.payout) > BigInt(profit.data.result.cost), 'positive realized protected profit missing');
      check(BigInt(d.bookPrice) > BigInt(d.targetPrice) * 11n / 10n, 'book price must visibly exceed the final Stage 1 price');
      check(d.deadlines.stage2End - d.chainTime > 20 * DAY, 'Escrow deadline should remain in the future');
      ctx.passed('Seed Quorum: outside buys, cost exit, profitable protected exit, higher book price');
    } else if (symbol === 'FORGE') {
      const proposals = await ctx.api(`${path}/proposals`);
      check(d.backers === 10 && proposals.length === 1 && proposals[0].state === 'Executed' && BigInt(proposals[0].yesWeight) > 0n && BigInt(proposals[0].noWeight) > 0n, 'Budget vote/execution missing');
      check(BigInt(d.E) === deposits.reduce((sum: bigint, t: any) => sum + BigInt(t.quote), 0n) - usd(3000) && BigInt(d.reserveState.J) < 10n ** 18n, 'Budget haircut missing');
      for (const actor of ctx.backers) {
        const p = await ctx.api(`${path}/positions/${actor.address}`);
        const deposit = deposits.find((t: any) => t.trader.toLowerCase() === actor.address.toLowerCase());
        check(BigInt(p.positions[0].guaranteedClaim.amount) < BigInt(deposit.quote), 'Budget backer basis did not decrease');
      }
      ctx.passed('Seed BenchmarkForge: voted and executed Budget, every claim reduced');
    } else if (symbol === 'DOCK') {
      check(d.backers === 10 && d.deadlines.stage2End <= d.chainTime && d.deadlines.listedAt === 0 && d.listingPreview.validity.available && d.listingRecord === null, 'listing is not actionable and pending');
      await ctx.client.simulateContract({ address: d.address, abi: A.RaiseCoreAbi, functionName: 'list', account: ctx.backers[0].account });
      ctx.passed('Seed Dockminder: listing pending, list() executable without broadcasting');
    } else if (symbol === 'CART') {
      check(d.backers === 10 && d.listingRecord && activity.some((e: any) => e.kind === 'RewardsClaimed' && BigInt(e.data.tokenAmount) > 0n), 'listed Diamond Hand claim missing');
      check(d.treasury && BigInt(d.treasury.allocation) > 0n, 'listed treasury state missing');
      const proposals = await ctx.api(`${path}/proposals`);
      check(proposals.some((p: any) => p.mode === 'Token' && p.kind === 'Spend' && p.state === 'Voting' && BigInt(p.yesWeight) > 0n), 'Stage 3 treasury vote missing');
      ctx.passed('Seed Cartographer: Stage 3 with a paid Diamond Hand claim and an open treasury vote');
    } else {
      check(d.backers === 0 && d.E === '0' && originalOwners.size === 4, 'dissolution summary must follow terminal API semantics');
      check(await ctx.read(d.modules.claims, A.ClaimVaultAbi, 'liability') === usd(18000), 'unclaimed dissolution liability missing');
      for (const actor of ctx.backers.slice(0, 4)) {
        const p = await ctx.api(`${path}/positions/${actor.address}`);
        check(BigInt(p.positions[0].guaranteedClaim.amount) > 0n, 'seed dissolution claim already taken');
      }
      check(!activity.some((e: any) => e.kind === 'DissolutionClaimed'), 'dissolution claims should be left live');
      ctx.passed('Seed VaporMind: dissolved, four unclaimed positions totaling 18000 USDG');
    }
  }
}
