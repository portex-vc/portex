import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { A, DAY, V31Context, RaiseV31, usd, check, backer } from './lib/v31';
import { BUILDER, DEPLOYER, now, type Actor } from './lib/chain';
import { PROJECTS, type DemoSymbol } from './demo-projects';

export async function seedDemoV31(rpcUrl: string, apiUrl: string) {
  const ctx = new V31Context(rpcUrl, apiUrl);
  check((await ctx.api('/v2/health')).ok, 'v2 backend must be healthy before seeding');
  check((await ctx.api('/v2/raises')).length === 0, 'seed requires a fresh v3.1 deployment; refusing duplicate projects');
  for (const actor of [...ctx.backers, ctx.buyer, BUILDER]) await ctx.fund(actor);
  const create = (symbol: DemoSymbol, budget = false, days = 70, incubation = 15) =>
    RaiseV31.create(ctx, PROJECTS[symbol].name, symbol, budget, days, PROJECTS[symbol].valuation, incubation);
  // Stage 3 · Open market: once CART lists, every seed day also carries real pool trades through the Portex router.
  // `day` and `until` only split time the seed already spends, so the timeline is unchanged.
  let market: (() => Promise<void>) | null = null;
  const day = async () => { if (market) await market(); else await ctx.warp(DAY); };
  const until = async (t: bigint | number) => {
    while (market && (await now(ctx.client)) + BigInt(DAY) <= BigInt(t)) await market();
    await ctx.warpTo(t);
  };
  // Ten real owners are required by the pinned Stage 1 gate. Varied deposits fill 20% of supply.
  const weights = [5, 6, 7, 8, 9, 10, 11, 12, 14, 18];
  async function fill(raises: RaiseV31[]) {
    for (let i = 0; i < weights.length; i++) {
      for (const raise of raises) await raise.deposit(ctx.backers[i], usd(PROJECTS[raise.symbol as DemoSymbol].valuation / 6 * weights[i] / 100 + (i === 9 ? 1 : 0)));
      await day();
    }
  }
  // Eight market trades per mature raise, plus ten Stage 1 deposits (and two QORM exits).
  async function trade(raises: RaiseV31[]) {
    for (let i = 0; i < 8; i++) {
      for (const raise of raises) {
        if (i === 3 || i === 6) await raise.guarded(ctx.buyer, 'sell', [(await raise.read('buyerTokens', [ctx.buyer.address])) / 20n, 0n]);
        else await raise.buy(ctx.buyer, usd([8000, 11000, 7000, 0, 13000, 9000, 0, 12000][i]));
      }
      await day();
    }
  }
  console.log('V3.1 seed: building the listed cohort');
  const listed = await create('CART', false, 35);
  await fill([listed]); await listed.open(); await trade([listed]);
  await ctx.warpTo((await listed.read('stageDeadlines')).stage2End);
  await listed.action(DEPLOYER, 'list');
  await ctx.warp(DAY);
  await ctx.write(ctx.backers[0], listed.modules.token, A.ProjectTokenV31Abi, 'claimRewards');
  const pool = await poolMarket(ctx, listed);
  market = pool?.day ?? null;

  console.log('V3.1 seed: building trading, Budget, pending-listing and dissolved cohorts');
  const escrow = await create('QORM');
  const budget = await create('FORGE', true, 60);
  const pending = await create('DOCK', false, 35);
  const refunded = await create('VAPR');
  for (let i = 0; i < 4; i++) { await refunded.deposit(ctx.backers[i], usd([2400, 3600, 5200, 6800][i])); await ctx.warp(DAY / 2); }
  await fill([escrow, budget, pending]);
  await escrow.open(); await budget.open(); await pending.open();
  await until((await refunded.read('stageDeadlines')).stage1End);
  await refunded.action(DEPLOYER, 'advanceStage1');
  await trade([escrow, budget, pending]);
  await escrow.exit(ctx.backers[1], escrow.ids[1].id);
  await ctx.write(BUILDER, budget.modules.governor, A.GovernanceV31Abi, 'propose', [usd(3000), 'https://benchmarkforge.example.dev/milestones/evaluation-dataset']);
  for (const p of budget.ids) await ctx.write(p.actor, budget.modules.governor, A.GovernanceV31Abi, 'vote', [1n, p.id, p.actor !== ctx.backers[0]]);
  const proposal = await ctx.read(budget.modules.governor, A.GovernanceV31Abi, 'getProposal', [1n]);
  await until(proposal.votingEnds);
  await ctx.write(DEPLOYER, budget.modules.governor, A.GovernanceV31Abi, 'finalize', [1n]);
  await until(proposal.disputeEnds);
  await ctx.write(DEPLOYER, budget.modules.governor, A.GovernanceV31Abi, 'execute', [1n]);
  const profit = await escrow.exit(ctx.backers[2], escrow.ids[2].id, true);
  check(profit.paid > profit.cost, 'seed protected exit must realize positive profit');
  console.log(`QORM protected exit: cost=${profit.cost} payout=${profit.paid} profit=${profit.paid - profit.cost} (USDG micro-units)`);
  await until((await pending.read('stageDeadlines')).stage2End);

  const fresh = await create('PING', false, 70, 30);
  const veto = await create('REYE', false, 70, 20);
  const cluster = [backer(20), backer(21), backer(22)];
  for (let i = 0; i < 4; i++) {
    await fresh.deposit(ctx.backers[i], usd([3500, 5000, 6500, 8000][i]));
    if (i < cluster.length) {
      await ctx.fund(cluster[i], 1n);
      await ctx.write(BUILDER, ctx.quote, A.MockUSDGV31Abi, 'transfer', [cluster[i].address, usd([7000, 9000, 11000][i])]);
      await veto.deposit(cluster[i], usd([7000, 9000, 11000][i]));
    }
    await ctx.warp(DAY / 2);
  }
  // A Stage 3 treasury proposal on the listed project, voted by token holders (base-layer treasury governance).
  const treasury = (await listed.read('getConfig')).treasury;
  // A last session of pool trades a few minutes apart, so the market has a live 24-hour window, then sweep the
  // trading fees of the protocol-owned position to the pinned treasury.
  market = null;
  if (pool) { await pool.session(); await listed.action(DEPLOYER, 'collectLPFees'); }
  await listed.action(DEPLOYER, 'claimTreasuryFees');
  const available = await ctx.read<bigint>(treasury, A.TreasuryV31Abi, 'availableQuote');
  await ctx.write(BUILDER, listed.modules.governor, A.GovernanceV31Abi, 'proposeSpend', [BUILDER.address, available / 2n, 0n, 'https://cartographer.example.dev/proposals/security-review']);
  await ctx.warp(1); // votes count balances at the end of the proposal block; mine the next one
  for (const voter of ctx.backers.slice(1, 4)) await ctx.write(voter, listed.modules.governor, A.GovernanceV31Abi, 'voteWithTokens', [1n, true]);
  const all = [fresh, veto, escrow, budget, pending, listed, refunded];
  const manifest = [];
  await ctx.waitIndexed();
  for (const raise of all) {
    const p = PROJECTS[raise.symbol as DemoSymbol];
    const path = `/v2/raises/${raise.address}`;
    const assetsUrl = process.env.PORTEX_ASSETS_URL ?? 'http://localhost:8793';
    await ctx.signed(BUILDER, 'PUT', `${path}/profile`, { name: p.name, tagline: p.tagline, description: p.description,
      website: p.website, twitter: p.twitter, logoUrl: `${assetsUrl}/logos/${raise.symbol}.svg`, github: '', docs: '' });
    for (const [i, [title, body]] of p.updates.entries()) await ctx.signed(BUILDER, 'POST', `${path}/updates`, { title, body, kind: i === 0 ? 'milestone' : 'update' });
    for (const [i, text] of p.feedback.entries()) {
      const author = raise === veto ? cluster[i] : ctx.backers[i === 0 ? 0 : 3];
      const rating = raise === refunded ? 2 : i === 0 ? 4 : 3;
      const signature = await author.account.signMessage({ message: `Portex feedback\nraise: ${raise.address.toLowerCase()}\nrating: ${rating}\ntext: ${text}` });
      await ctx.api(`${path}/feedback`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ author: author.address, rating, text, signature }) });
    }
    const analysis = await ctx.signed(BUILDER, 'POST', `${path}/analyze`, {});
    if (raise === veto) check(analysis.veto && analysis.postedTx, 'heuristic must post the Stage 1 veto');
    await ctx.waitIndexed();
    const d = await ctx.api(path);
    check(d.riskScoreBps !== null && d.profile.description && (await ctx.api(`${path}/updates`)).length === 2 && (await ctx.api(`${path}/feedback`)).length === 2, `missing signed seed content: ${raise.symbol}`);
    const logo = await fetch(d.profile.logoUrl);
    check(logo.ok && (await logo.text()).includes(`>${p.monogram}</text>`), `missing logo monogram: ${raise.symbol}`);
    manifest.push({ address: raise.address, name: raise.name, symbol: raise.symbol, template: d.template, phase: d.phase,
      vetoActive: d.vetoActive, valuation: p.valuation, escrow: d.E, backers: d.backers, originalBackers: raise.ids.length,
      riskScoreBps: d.riskScoreBps, deadlines: d.deadlines });
  }
  const dir = process.env.PORTEX_RESULTS_DIR || resolve(dirname(fileURLToPath(import.meta.url)), '../artifacts/v31');
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, 'seed.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log('\nNAME | SYMBOL | TEMPLATE | PHASE | ESCROW USDG | BACKERS');
  for (const r of manifest) console.log(`${r.name} | ${r.symbol} | ${r.template} | ${r.phase}${r.vetoActive ? ' (AI veto)' : ''} | ${Number(r.escrow) / 1e6} | ${r.backers} (${r.originalBackers} original)`);
  console.log('V3.1 seed: PASS; 7 raises, 7 analyses, 14 updates, 14 signed feedback entries, 7 monograms');
  return manifest;
}

/**
 * Real Uniswap v4 trades for a listed project, through the Portex swap router with a 1% slippage bound. `day` is one
 * seed day (three trades at 5 h, 12 h and 24 h); `session` adds eight trades 15–30 minutes apart. Sizes and sides are
 * deterministic, with a mild buy bias; one original backer sells part of their tokens now and then, destroying
 * Diamond Hand quota as the token rules require.
 */
async function poolMarket(ctx: V31Context, raise: RaiseV31): Promise<{ day: () => Promise<void>; session: () => Promise<void> } | null> {
  const router = ctx.deployment.router as `0x${string}` | undefined;
  if (!router || BigInt(router) === 0n) return null;
  const token = raise.modules.token;
  const traders = [backer(30), backer(31), backer(32), ctx.buyer];
  const holder = ctx.backers[6];
  for (const actor of traders.slice(0, 3)) await ctx.fund(actor, usd(250_000));
  for (const actor of [...traders, holder]) {
    await ctx.write(actor, ctx.quote, A.MockUSDGV31Abi, 'approve', [router, 2n ** 255n]);
    await ctx.write(actor, token, A.ProjectTokenV31Abi, 'approve', [router, 2n ** 255n]);
  }
  const swap = async (actor: Actor, buy: boolean, amount: bigint) => {
    if (amount <= 0n) return;
    const quoted = await ctx.client.simulateContract({ address: router, abi: A.PortexSwapRouterV31Abi, functionName: 'quoteExactIn', args: [token, buy, amount], account: actor.account });
    const min = quoted.result * 99n / 100n;
    await ctx.write(actor, router, A.PortexSwapRouterV31Abi, 'swapExactIn', [token, buy, amount, min, actor.address, (await now(ctx.client)) + 600n]);
  };
  let step = 0;
  const trade = async (buyBias = false) => {
    const actor = traders[step % traders.length];
    const held = await ctx.read<bigint>(token, A.ProjectTokenV31Abi, 'balanceOf', [actor.address]);
    const sell = held > 0n && (buyBias ? step % 4 === 3 : step % 5 === 2 || step % 7 === 4);
    if (step % 9 === 7 && !buyBias) await swap(holder, false, (await ctx.read<bigint>(token, A.ProjectTokenV31Abi, 'balanceOf', [holder.address])) / 25n);
    else if (sell) await swap(actor, false, held * BigInt(10 + (step * 31) % 20) / 100n);
    else await swap(actor, true, usd(600 + (step * 7919) % 4400));
    step++;
  };
  return {
    day: async () => { for (const hours of [5, 7, 12]) { await ctx.warp(hours * 3600); await trade(); } },
    session: async () => { for (let i = 0; i < 8; i++) { await ctx.warp(900 + (i * 577) % 900); await trade(true); } },
  };
}

// Compatibility export for backend/test/v31.test.ts, whose fixed fixture is not the demo.
export { seedV31 } from './fixture-v31';
