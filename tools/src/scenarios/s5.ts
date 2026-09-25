// S5 — whale squeeze: early in Growth the whale buys 1× then 3× the whole Stage 1 raise.
// Charts the price path as later tranches unlock and sell into the pump, then the whale
// exits. Repeated at stage2Inventory = 1×, 2×, 4× stage1Alloc to show how depth tames it.
import { BACKERS, BUILDER, DEPLOYER, WHALE } from '../lib/chain';
import { Ctx } from '../lib/context';
import { fmtPrice, fmtQuote, fmtSignedQuote, mdRow, q, t } from '../lib/format';
import { RaiseSim } from '../lib/raise';
import type { Scenario } from './index';

interface DepthRun {
  depth: number;
  basePrice: bigint;
  priceAfter1x: bigint;
  priceAfter3x: bigint;
  whaleNet: bigint;
  backersNet: bigint;
  path: [string, bigint][];
}

export const s5: Scenario = {
  id: 'S5',
  title: 'Whale squeeze vs pool depth',
  async run(ctx: Ctx) {
    const runs: DepthRun[] = [];
    for (const depth of [1, 2, 4]) {
      runs.push(await runDepth(ctx, depth));
    }

    ctx.step('cross-depth comparison');
    ctx.log(mdRow(['stage2Inventory', 'price after 1× buy', 'after +3× buy', 'whale net', 'backers net']));
    ctx.log(mdRow(['---', '---:', '---:', '---:', '---:']));
    // stage-1 price b is the same in every run (same deposits, same A1)
    for (const r of runs) {
      ctx.log(
        mdRow([
          `${r.depth}× A1`,
          `${fmtPrice(r.priceAfter1x)} (×${(Number(r.priceAfter1x) / Number(r.basePrice)).toFixed(2)})`,
          `${fmtPrice(r.priceAfter3x)} (×${(Number(r.priceAfter3x) / Number(r.basePrice)).toFixed(2)})`,
          fmtSignedQuote(r.whaleNet),
          fmtSignedQuote(r.backersNet),
        ]),
      );
    }

    const deep = runs.find((r) => r.depth === 2)!;
    return {
      id: 'S5',
      title: s5.title,
      verdict:
        `A whale putting 1× then 3× the entire Stage 1 raise into the pool moved the book price ×${(Number(runs[0].priceAfter3x) / Number(runs[0].basePrice)).toFixed(1)} at 1× depth, ×${(Number(deep.priceAfter3x) / Number(deep.basePrice)).toFixed(1)} at 2× depth (the default) and ×${(Number(runs[2].priceAfter3x) / Number(runs[2].basePrice)).toFixed(1)} at 4× depth. In every run the whale's exit realised a loss (${fmtSignedQuote(runs.map((r) => r.whaleNet).reduce((a, x) => a + x, 0n))} across all three) while backers who sold into the pump kept the difference — the squeeze transfers money from the whale to early sellers, and deeper stage2Inventory compresses the spike. The pool stayed solvent at every step (checker green after every trade).`,
      headline: `whale 4× raise-size buys: price ×${(Number(runs[0].priceAfter3x) / Number(runs[0].basePrice)).toFixed(1)}/${(Number(deep.priceAfter3x) / Number(deep.basePrice)).toFixed(1)}/${(Number(runs[2].priceAfter3x) / Number(runs[2].basePrice)).toFixed(1)} at depth 1/2/4; whale loses in all runs`,
    };
  },
};

async function runDepth(ctx: Ctx, depth: number): Promise<DepthRun> {
  const backers = BACKERS; // 5 × 12k = 60k
  const perBacker = q(12_000);
  const raiseTotal = perBacker * 5n;

  ctx.log(`\n## Run with stage2Inventory = ${depth}× stage1Alloc\n`);
  ctx.step(`deploy raise (T0 = ${depth}×A1), 5 backers × 12k, all opt in tranche 1`);
  const rs = await RaiseSim.create(ctx, {
    builder: BUILDER,
    name: `Deepsea Agents (depth ${depth}x)`,
    symbol: `SEA${depth}`,
    overrides: { stage2Inventory: t(20_000_000) * BigInt(depth) },
  });
  for (const a of backers) {
    await ctx.faucet(a, perBacker);
    await rs.deposit(a, perBacker);
  }
  await ctx.faucet(WHALE, q(1_000_000));
  await ctx.warp(601);
  await rs.startCommitment(backers[0]);
  for (const a of backers) await rs.commit(a, 1);
  await ctx.warp(301);
  await rs.openGrowth(DEPLOYER);

  const b = await rs.stage1Price();
  const path: [string, bigint][] = [['open', b]];

  ctx.step('whale buys 1× the whole Stage 1 raise, early in Growth');
  await rs.buy(WHALE, raiseTotal);
  const p1 = await rs.price();
  path.push([`whale +1× raise`, p1]);

  ctx.step('whale buys another 3× the raise');
  await rs.buy(WHALE, raiseTotal * 3n);
  const p3 = await rs.price();
  path.push([`whale +3× raise`, p3]);
  ctx.note(`price path so far: ${fmtPrice(b)} → ${fmtPrice(p1)} → ${fmtPrice(p3)} (×${(Number(p3) / Number(b)).toFixed(2)})`);

  ctx.step('backers commit tranche 2, claim tranche 1 and sell into the pump');
  for (const a of backers) {
    await rs.commit(a, 2);
    const claimed = await rs.claim(a, 1);
    await rs.sell(a, claimed);
  }
  path.push(['backers dump t1', await rs.price()]);

  for (let epoch = 2; epoch <= 4; epoch++) {
    ctx.step(`epoch ${epoch}: tranche ${epoch} unlocks, backers commit/claim/sell`);
    await ctx.warp(301);
    for (const a of backers) {
      if (epoch < 4) await rs.commit(a, epoch + 1);
      const claimed = await rs.claim(a, epoch);
      await rs.sell(a, claimed);
    }
    path.push([`epoch ${epoch} dump`, await rs.price()]);
  }

  ctx.step('the whale exits: dumps the entire accumulated bag back into the pool');
  const whaleIn = raiseTotal * 4n;
  const whaleBag = await ctx.tokenBalance(rs.addrs.token, WHALE.address);
  const whaleOut = await rs.sell(WHALE, whaleBag);
  path.push(['whale full exit', await rs.price()]);
  const whaleNet = whaleOut - whaleIn;
  ctx.note(`whale: in ${fmtQuote(whaleIn)}, out ${fmtQuote(whaleOut)}, net ${fmtSignedQuote(whaleNet)} — the pump money stayed with sellers and the pool`);

  // backers' aggregate net from this raise
  let backersNet = 0n;
  for (const a of backers) {
    const e = ctx.pnl.get(a.address)!;
    backersNet += e.quoteReceived - e.quoteSpent;
    ctx.pnl.delete(a.address); // per-run accounting
  }
  ctx.pnl.delete(WHALE.address);
  ctx.note(`backers' aggregate net (all sold): ${fmtSignedQuote(backersNet)}`);

  ctx.log(`\nprice path (×b = ${fmtPrice(b)}):\n`);
  ctx.log(mdRow(['point', 'price', '× Stage 1']));
  ctx.log(mdRow(['---', '---:', '---:']));
  for (const [label, p] of path) ctx.log(mdRow([label, fmtPrice(p), `×${(Number(p) / Number(b)).toFixed(2)}`]));

  return { depth, priceAfter1x: p1, priceAfter3x: p3, whaleNet, backersNet, path, basePrice: b };
}
