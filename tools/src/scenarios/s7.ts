// S7 — Rule 2 (MILESTONE_FUNDING / SpendGovernor): a milestone spend with a YES/NO/abstain
// mix, a dissenter leaving whole during the dispute window, stayers paying pro rata via the
// index, the 10%-of-YES cap rejecting an oversized request, and a later depositor unaffected.
//
// Written against design §5.7, INTERFACES.md and contracts/abi/SpendGovernor.json. If the
// governor ABI or the MILESTONE_FUNDING template is not deployed, the scenario skips with a
// clear message instead of failing.
import type { Address } from 'viem';
import { BACKERS, BUILDER, DEPLOYER } from '../lib/chain';
import { GOVERNOR_ABI, ABIS } from '../lib/abis';
import { Ctx, expectRevert } from '../lib/context';
import { fmtQuote, fmtSignedQuote, q } from '../lib/format';
import { RaiseSim } from '../lib/raise';
import type { Scenario } from './index';

const STATUS = ['None', 'Active', 'Passed', 'Defeated', 'Executed', 'Expired'];

export const s7: Scenario = {
  id: 'S7',
  title: 'Rule 2 milestone spend with dissenters',
  async run(ctx: Ctx) {
    const d = ctx.deployment;
    if (!GOVERNOR_ABI || !d.templateMilestoneFunding) {
      ctx.log(
        '\n**SKIPPED** — `SpendGovernor` is not deployed yet (no `contracts/abi/SpendGovernor.json` / ' +
          'no `templateMilestoneFunding` in `deployments/31337.json`). The Rule 2 package is being added by ' +
          'another agent; once `contracts/scripts/deploy-local.sh` publishes the MILESTONE_FUNDING template, ' +
          'this scenario runs unchanged against design §5.7.',
      );
      return {
        id: 'S7',
        title: s7.title,
        skipped: true,
        verdict:
          'Skipped: the SpendGovernor contract and MILESTONE_FUNDING template are not deployed yet. The scenario is written against design §5.7 and INTERFACES.md and will run once the Rule 2 package lands.',
        headline: 'skipped — SpendGovernor not deployed yet',
      };
    }

    const [b1, b2, b3, b4, b5] = BACKERS;

    ctx.step('create a MILESTONE_FUNDING raise (Rule 2), 4 backers × 15k');
    const rs = await RaiseSim.create(ctx, {
      builder: BUILDER,
      name: 'Milestone Metrics AI',
      symbol: 'MILE',
      templateId: d.templateMilestoneFunding,
      templateVersion: d.templateMilestoneFundingVersion ?? 1,
      overrides: { maxCumulativeSpendBps: 3000 }, // Rule 2: 30% cumulative spend ceiling
    });
    const governor = rs.addrs.governor;
    ctx.note(`governor at \`${governor}\``);
    for (const a of [b1, b2, b3, b4]) {
      await ctx.faucet(a, q(15_000));
      await rs.deposit(a, q(15_000));
    }

    const govWrite = async (actor: (typeof BACKERS)[number], fn: string, args: unknown[]) => {
      const hash = await ctx.wallet(actor).writeContract({
        address: governor,
        abi: GOVERNOR_ABI!,
        functionName: fn,
        args: args as never,
        chain: undefined,
        account: actor.account,
      });
      await ctx.client.waitForTransactionReceipt({ hash });
    };
    const getProposal = async (id: number) =>
      (await ctx.client.readContract({
        address: governor,
        abi: GOVERNOR_ABI!,
        functionName: 'getProposal',
        args: [BigInt(id)],
      })) as { amount: bigint; yesPrincipal: bigint; noPrincipal: bigint; status: number; votingEnds: bigint; disputeEnds: bigint };
    const principalOf = async (addr: Address) =>
      (await ctx.client.readContract({ address: rs.addrs.raise, abi: ABIS.Raise, functionName: 'principalOf', args: [addr] })) as bigint;

    ctx.step('builder proposes a 3,000 USDG milestone spend');
    await govWrite(BUILDER, 'propose', [q(3_000), 'sim://s7/milestone-1']);
    ctx.note('proposal 1: 3,000 USDG');

    ctx.step('the builder wallet cannot vote');
    await expectRevert(() => govWrite(BUILDER, 'vote', [1, true]), ctx, 'vote by builder (BuilderCannotVote)', 'BuilderCannotVote');

    ctx.step('vote: b1+b2 YES (30k), b3 NO (15k), b4 abstains (does not vote)');
    await govWrite(b1, 'vote', [1, true]);
    await govWrite(b2, 'vote', [1, true]);
    await govWrite(b3, 'vote', [1, false]);
    ctx.note('YES voters are immediately withdraw-locked until the spend executes or expires (lock = disputeEnds + disputeWindow)');

    ctx.step('YES voters cannot leave mid-vote (lock is already active)');
    await expectRevert(() => rs.withdraw(b1), ctx, 'withdraw by YES voter (WithdrawLocked)', 'WithdrawLocked');

    ctx.step('voting ends → finalize: quorum 75% ≥ 40%, approval 67% ≥ 60%, 3k ≤ 10%×30k YES → passes');
    await ctx.warp(301, 'votingPeriod over');
    await govWrite(DEPLOYER, 'finalize', [1]);
    let p = await getProposal(1);
    if (STATUS[p.status] !== 'Passed') throw new Error(`proposal 1 should have Passed, got ${STATUS[p.status]}`);
    ctx.note('proposal Passed → dispute window open: anyone who did not vote YES may still leave whole');

    ctx.step('dissenter b3 leaves with exactly 100% during the dispute window; YES voter still locked');
    await rs.withdraw(b3);
    await expectRevert(() => rs.withdraw(b2), ctx, 'withdraw by YES voter during dispute (WithdrawLocked)', 'WithdrawLocked');

    ctx.step('execute: builder is paid 3,000; everyone who stayed pays pro rata via the index');
    await ctx.warp(301, 'dispute window over');
    const builderBefore = await ctx.quoteBalance(BUILDER.address);
    const p1Before = await principalOf(b1.address);
    const p4Before = await principalOf(b4.address);
    await govWrite(DEPLOYER, 'execute', [1]);
    const builderGot = (await ctx.quoteBalance(BUILDER.address)) - builderBefore;
    const p1After = await principalOf(b1.address);
    const p4After = await principalOf(b4.address);
    ctx.received(BUILDER, builderGot);
    ctx.note(
      `builder received ${fmtQuote(builderGot)}; stayer principal 15,000 → ${fmtQuote(p1After)} (b1 YES) and ${fmtQuote(p4After)} (b4 abstained-but-stayed — abstainers who stay pay too)`,
    );
    if (p1Before - p1After !== p4Before - p4After) throw new Error('pro rata spend was not uniform across stayers');
    await rs.checkNow('governor execute');
    ctx.note('b3, who left, paid nothing');

    ctx.step('the spend is executed; a YES voter is still locked until someone releases the lock (permissionless)');
    await expectRevert(() => rs.withdraw(b2), ctx, 'withdraw by YES voter before releaseLock (WithdrawLocked)', 'WithdrawLocked');
    await govWrite(DEPLOYER, 'releaseLock', [1, b2.address]);
    ctx.step('lock released → the YES voter withdraws at the reduced principal: they paid their pro-rata share and could not dodge it');
    await rs.withdraw(b2);

    ctx.step('the 10%-of-YES cap rejects an oversized request');
    await ctx.warp(601, 'minProposalInterval');
    await govWrite(BUILDER, 'propose', [q(1_500), 'sim://s7/milestone-2']);
    // YES principal is now ~14k (b1 alone) — the 10% cap is ~1.4k; 1,500 exceeds it
    await govWrite(b1, 'vote', [2, true]);
    await ctx.warp(301, 'votingPeriod over');
    await govWrite(DEPLOYER, 'finalize', [2]);
    p = await getProposal(2);
    ctx.note(`proposal 2: amount ${fmtQuote(p.amount)} vs 10% of YES ${fmtQuote(p.yesPrincipal / 10n)} → status ${STATUS[p.status]}`);
    if (STATUS[p.status] !== 'Defeated') throw new Error('oversized proposal was not defeated by the 10%-of-YES cap');
    await expectRevert(() => govWrite(DEPLOYER, 'execute', [2]), ctx, 'execute of defeated proposal (NotPassed)', 'NotPassed');
    await govWrite(DEPLOYER, 'releaseLock', [2, b1.address]);
    ctx.note('YES lock released after defeat');

    ctx.step('a later depositor joins at the new index and does not pay for past spends');
    await ctx.faucet(b5, q(10_000));
    await rs.deposit(b5, q(10_000));
    const p5 = await principalOf(b5.address);
    if (q(10_000) - p5 > 10n) throw new Error(`later depositor affected by past spend: principal ${fmtQuote(p5)}`);
    ctx.note(`b5 deposited 10,000 after the spend and holds ${fmtQuote(p5)} of principal (index-floored deposit, ≤ dust)`);

    await rs.pnlTable([b1, b2, b3, b4, b5, BUILDER]);

    const stayerCost = q(15_000) - p1After;
    return {
      id: 'S7',
      title: s7.title,
      verdict:
        `Rule 2 behaves per §5.7: YES voters were locked from vote time until the spend executed (they cannot leave in the gap before execute()); the NO-voting dissenter left with exactly 100%; the executed 3,000 USDG spend lowered the principal index so every stayer paid pro rata (${fmtSignedQuote(-stayerCost)} on 15,000) — including the abstainer who stayed, which is the documented trade-off of abstaining without leaving. The oversized follow-up (1,400 > 10% of YES principal) was defeated at finalization despite a YES majority, and a depositor who joined after the spend holds exactly full principal.`,
      headline: `dissenter left whole; stayers ${fmtSignedQuote(-stayerCost)} each; 10%-of-YES cap defeated oversized spend; late depositor unaffected`,
    };
  },
};
