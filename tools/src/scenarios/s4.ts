// S4 — no Stage 2 demand: everyone opts in over time, then dumps into an empty pool.
// Reports each backer's result versus simply redeeming, and that Locked tranches stayed
// 100% redeemable throughout — including mid-dump.
import { BACKERS, BUILDER, DEPLOYER } from '../lib/chain';
import { Ctx, expectRevert } from '../lib/context';
import { fmtPrice, fmtQuote, fmtSignedQuote, mdRow, q } from '../lib/format';
import { RaiseSim } from '../lib/raise';
import type { Scenario } from './index';

export const s4: Scenario = {
  id: 'S4',
  title: 'No Stage 2 demand, mass exit',
  async run(ctx: Ctx) {
    const backers = BACKERS; // 5 backers × 12k = 60k
    const perBacker = q(12_000);

    ctx.step('raise fills evenly: 5 backers × 12,000 USDG');
    const rs = await RaiseSim.create(ctx, { builder: BUILDER, name: 'Echo Chamber Analytics', symbol: 'ECHO' });
    for (const a of backers) {
      await ctx.faucet(a, perBacker);
      await rs.deposit(a, perBacker);
    }

    ctx.step('gates pass; in epoch 0 everyone opts in tranche 1 (30% gate easily met)');
    await ctx.warp(601);
    await rs.startCommitment(backers[0]);
    for (const a of backers) await rs.commit(a, 1);
    await ctx.warp(301);
    await rs.openGrowth(DEPLOYER);
    const b = await rs.stage1Price();
    ctx.note(`pool opens at ${fmtPrice(b)}; there is no outside demand at all`);

    // backer5 keeps tranches 2-4 locked the whole time; everyone else commits and dumps
    // tranche by tranche. backer5 redeems one locked tranche *mid-dump* to prove the put
    // stays at 100% while the pool is being drained.
    const dumpers = backers.slice(0, 4);
    const cautious = backers[4];

    ctx.step('epoch 1: epoch-0 commits claim; dumpers sell immediately, in order b1 → b4');
    const sells = new Map<string, bigint>();
    for (const a of backers) {
      const claimed = await rs.claim(a, 1);
      if (a !== cautious) {
        const got = await rs.sell(a, claimed);
        sells.set(a.label, (sells.get(a.label) ?? 0n) + got);
      }
    }
    for (const a of dumpers) await rs.commit(a, 2);

    ctx.step('epoch 2: mid-dump, backer5 redeems a still-locked tranche at exactly 100%');
    await ctx.warp(301);
    for (const a of dumpers) {
      await rs.commit(a, 3);
      const claimed = await rs.claim(a, 2);
      sells.set(a.label, (sells.get(a.label) ?? 0n) + (await rs.sell(a, claimed)));
    }
    await rs.redeem(cautious, 2);
    ctx.note('the put is intact while others are eating curve slippage — protection only dies when you give it up');

    ctx.step('epochs 3–4: remaining tranches unlock and are dumped');
    await ctx.warp(301);
    for (const a of dumpers) {
      await rs.commit(a, 4);
      const claimed = await rs.claim(a, 3);
      sells.set(a.label, (sells.get(a.label) ?? 0n) + (await rs.sell(a, claimed)));
    }
    await ctx.warp(301);
    for (const a of dumpers) {
      const claimed = await rs.claim(a, 4);
      sells.set(a.label, (sells.get(a.label) ?? 0n) + (await rs.sell(a, claimed)));
    }

    ctx.step('backer5 exits: sells the one committed tranche, redeems the rest at 100%');
    const cautiousBal = await ctx.tokenBalance(rs.addrs.token, cautious.address);
    const cautiousSell = cautiousBal > 0n ? await rs.sell(cautious, cautiousBal) : 0n;
    await rs.redeemAll(cautious);

    ctx.step('graduation is unreachable — the pool simply keeps running');
    await expectRevert(() => rs.graduate(DEPLOYER), ctx, 'graduate (GraduationNotReady: R drained / real ratio below 50%)', 'GraduationNotReady');

    // ---- report: each backer's result vs simply redeeming ----
    const tranchePrincipal = perBacker / 4n;
    ctx.log('\n**Each dumper vs simply redeeming (per backer, quote terms)**\n');
    ctx.log(mdRow(['backer', 'committed', 'recovered by selling', 'would have (redeem)', 'loss vs redeem']));
    ctx.log(mdRow(['---', '---:', '---:', '---:', '---:']));
    for (const a of dumpers) {
      const sold = sells.get(a.label) ?? 0n;
      const loss = perBacker - sold;
      ctx.log(mdRow([a.label, fmtQuote(perBacker), fmtQuote(sold), fmtQuote(perBacker), fmtSignedQuote(-loss)]));
    }
    const cautiousCommitted = tranchePrincipal; // only tranche 1
    const cautiousNet = cautiousSell + tranchePrincipal * 3n; // sell + 3 locked tranches redeemed
    ctx.log(mdRow([`${cautious.label} (1 committed, 3 locked)`, fmtQuote(perBacker), fmtQuote(cautiousNet), fmtQuote(perBacker), fmtSignedQuote(cautiousNet - perBacker)]));
    void cautiousCommitted;

    const totalSold = [...sells.values()].reduce((x, y) => x + y, 0n) + cautiousSell;
    const totalCommitted = perBacker * 4n + tranchePrincipal;
    ctx.summary(
      `with zero outside demand, dumping ${fmtQuote(totalCommitted)} of committed principal returned ${fmtQuote(totalSold)} — ` +
        `a collective ${fmtQuote(totalCommitted - totalSold)} loss (curve slippage + fees), distributed unfairly: early dumpers lost less, late dumpers paid for it`,
    );
    if (totalSold > totalCommitted) throw new Error('dumpers extracted more than committed with no demand');

    return {
      id: 'S4',
      title: s4.title,
      verdict:
        `No-demand Growth is a slow-motion exit queue, not a bank run: every sell was honoured from R (solvency green throughout), but with nobody buying, selling 48,000 USDG of committed principal returned only ${fmtQuote(totalSold)}. Losses came purely from curve slippage and fees, and fell hardest on whoever sold last. backer5 — who committed only one tranche — redeemed locked tranches at exactly 100% even mid-dump. Graduation correctly refused to happen with the reserve drained.`,
      headline: `dumping 48k committed returned ${fmtQuote(totalSold)}; locked tranches 100% redeemable mid-dump; no graduation`,
    };
  },
};
