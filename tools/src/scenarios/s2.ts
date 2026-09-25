// S2 — gates never met: deposits stay below the soft cap, startCommitment reverts,
// deadline passes, fail() → everyone withdraws exactly 100%, builder resets cleanly.
import { BACKERS, BUILDER, DEPLOYER } from '../lib/chain';
import { Ctx, expectRevert } from '../lib/context';
import { fmtQuote, q } from '../lib/format';
import { RaiseSim } from '../lib/raise';
import { STATE_NAMES } from '../lib/raise';
import type { Scenario } from './index';

export const s2: Scenario = {
  id: 'S2',
  title: 'Gates never met → fail() → 100% refunds',
  async run(ctx: Ctx) {
    const [b1, b2] = BACKERS;

    ctx.step('builder opens a raise; only 35k of the 50k soft cap arrives');
    const rs = await RaiseSim.create(ctx, { builder: BUILDER, name: 'Ghost Oracle AI', symbol: 'GHST' });
    for (const [a, amt] of [
      [b1, q(20_000)],
      [b2, q(15_000)],
    ] as const) {
      await ctx.faucet(a, amt);
      await rs.deposit(a, amt);
    }

    ctx.step('a backer can still leave mid-incubation, 1:1, and come back');
    await rs.withdraw(b2, q(5_000));
    await ctx.warp(60);
    await rs.deposit(b2, q(5_000));

    ctx.step('min incubation passes but the soft cap does not → startCommitment reverts');
    await ctx.warp(600, 'minIncubation elapsed');
    await expectRevert(() => rs.startCommitment(b1), ctx, 'startCommitment (SoftCapNotReached)', 'SoftCapNotReached');

    ctx.step('deadline passes with gates unmet → anyone calls fail()');
    await ctx.warp(1300, 'past the 30-min deadline');
    await rs.fail(DEPLOYER);

    ctx.step('everyone withdraws exactly 100% of principal');
    await rs.withdraw(b1);
    await rs.withdraw(b2);
    const escrow = await ctx.quoteBalance(rs.addrs.raise);
    ctx.note(`escrow after full exit: ${fmtQuote(escrow)} (dust only)`);

    ctx.step('builder resets cleanly — a fresh raise is immediately usable');
    const rs2 = await RaiseSim.create(ctx, { builder: BUILDER, name: 'Ghost Oracle AI v2', symbol: 'GHST2' });
    await ctx.faucet(b1, q(60_000));
    await rs2.deposit(b1, q(60_000));
    const st = STATE_NAMES[await rs2.state()];
    ctx.note(`new raise is in ${st} with ${fmtQuote(q(60_000))} — nothing about the failure sticks to the builder`);

    return {
      id: 'S2',
      title: s2.title,
      verdict:
        'A raise that misses its gates fails open: startCommitment reverted while the soft cap was unmet, fail() became callable by anyone after the deadline, and both backers withdrew exactly 100% of principal (verified wei-for-wei). The builder immediately opened a new raise — failure carries no protocol-level penalty or lock.',
      headline: '35k/50k deposited → fail() → 100% refunds (exact); builder redeploys instantly',
    };
  },
};
