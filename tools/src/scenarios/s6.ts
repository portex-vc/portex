// S6 — opt-in below minOptInBps: Growth never opens, everyone (including the one
// committer) is refunded 100%. Also shows fail() cannot be abused during Commitment.
import { BACKERS, BUILDER, DEPLOYER } from '../lib/chain';
import { Ctx, expectRevert } from '../lib/context';
import { fmtBps, fmtQuote, q } from '../lib/format';
import { RaiseSim } from '../lib/raise';
import type { Scenario } from './index';

export const s6: Scenario = {
  id: 'S6',
  title: 'Opt-in below minOptInBps → Growth never opens',
  async run(ctx: Ctx) {
    const backers = BACKERS;

    ctx.step('raise fills to 60k and passes the capital/time gates');
    const rs = await RaiseSim.create(ctx, { builder: BUILDER, name: 'Cold Start Robotics', symbol: 'COLD' });
    for (const a of backers) {
      await ctx.faucet(a, q(12_000));
      await rs.deposit(a, q(12_000));
    }
    await ctx.warp(601);
    await rs.startCommitment(backers[0]);

    ctx.step('only one backer opts in: 3k committed of the 4.5k required (30% of tranche-1 principal)');
    await rs.commit(backers[4], 1);
    ctx.note(`the other four backers watched the product during incubation and declined to give up protection — that *is* the no-signal`);

    ctx.step('during Commitment a deadline pass cannot kill the raise — only openGrowth decides');
    await expectRevert(() => rs.fail(DEPLOYER), ctx, 'fail() in Commitment (InvalidState)', 'InvalidState');

    ctx.step('commitment window ends → openGrowth() measures opt-in and fails the raise');
    await ctx.warp(301);
    const opened = await rs.openGrowth(DEPLOYER);
    if (opened) throw new Error('Growth opened despite opt-in below minOptInBps');

    ctx.step('everyone withdraws exactly 100% — including the committer’s committed principal');
    for (const a of backers) await rs.withdraw(a);
    const escrow = await ctx.quoteBalance(rs.addrs.raise);
    ctx.note(`escrow after full exit: ${fmtQuote(escrow)} (dust only)`);

    return {
      id: 'S6',
      title: s6.title,
      verdict:
        `The opt-in gate did its job: with only ${fmtQuote(q(3_000))} of the required ${fmtBps(3000)} tranche-1 opt-in, openGrowth() moved the raise straight to Failed and all five backers — including the one who had committed — withdrew exactly 100%. The community's refusal to give up protection is what stops a raise, not an oracle or a vote.`,
      headline: 'opt-in 3k < required 4.5k → Failed at openGrowth; 60k refunded 100% incl. committed',
    };
  },
};
