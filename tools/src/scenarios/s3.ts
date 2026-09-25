// S3 — self-funded builder: 20 fresh wallets funded from one source fake organic demand.
// If the backend is reachable at API_URL, POST /v1/raises/:address/analyze produces the
// report and posts the veto on-chain; otherwise the attester posts an equivalent veto
// directly (and we say so). The veto blocks startCommitment; the council clears it;
// afterwards the attacker can only ever touch their own money.
import { keccak256, toBytes } from 'viem';
import { ATTESTER, BACKERS, BUILDER, COUNCIL, DEPLOYER, freshWallet } from '../lib/chain';
import { ABIS } from '../lib/abis';
import { Ctx, expectRevert } from '../lib/context';
import { fmtBps, fmtQuote, fmtSignedQuote, q } from '../lib/format';
import { RaiseSim } from '../lib/raise';
import type { Scenario } from './index';

const API_URL = process.env.API_URL ?? 'http://localhost:8790';

async function backendReachable(): Promise<boolean> {
  try {
    const res = await fetch(`${API_URL}/v1/health`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

export const s3: Scenario = {
  id: 'S3',
  title: 'Self-funded builder behind 20 wallets (analyst veto)',
  async run(ctx: Ctx) {
    const [g1, g2] = BACKERS; // genuine backers

    ctx.step('builder opens a raise; two genuine backers deposit 10k each');
    const rs = await RaiseSim.create(ctx, { builder: BUILDER, name: 'SybilSwap Agents', symbol: 'SYBL' });
    for (const a of [g1, g2]) {
      await ctx.faucet(a, q(10_000));
      await rs.deposit(a, q(10_000));
    }

    ctx.step('the builder funds 20 fresh wallets from one source and deposits 2k from each');
    // On-chain this is visible: one funding source (the builder wallet) → 20 fresh accounts.
    await ctx.faucet(BUILDER, q(40_000));
    const sybils = [];
    for (let i = 0; i < 20; i++) {
      const w = ctx.track(freshWallet(`sybil${i + 1}`));
      sybils.push(w);
      // gas money from the builder's wallet — the clustering signal
      const gasHash = await ctx.wallet(BUILDER).sendTransaction({
        to: w.address,
        value: 10n ** 16n, // 0.01 ETH — enough for deposit/commit/claim/sell + approvals
        chain: undefined,
        account: BUILDER.account,
      });
      await ctx.client.waitForTransactionReceipt({ hash: gasHash });
      // quote funds, also from the builder
      const fundHash = await ctx.wallet(BUILDER).writeContract({
        address: ctx.quote,
        abi: ABIS.MockUSDG,
        functionName: 'transfer',
        args: [w.address, q(2_000)],
        chain: undefined,
        account: BUILDER.account,
      });
      await ctx.client.waitForTransactionReceipt({ hash: fundHash });
      await rs.deposit(w, q(2_000));
    }
    ctx.note('total 60,000 USDG — soft cap met, but 40,000 of it is the builder talking to themselves');

    ctx.step('min incubation elapses — capital and time gates now pass');
    await ctx.warp(601, 'minIncubation elapsed');

    ctx.step('the AI analyst examines the raise');
    const reportHash = keccak256(toBytes('s3-sybil-report'));
    if (await backendReachable()) {
      ctx.note(`backend reachable at ${API_URL} — requesting POST /v1/raises/${rs.addrs.raise}/analyze`);
      const res = await fetch(`${API_URL}/v1/raises/${rs.addrs.raise}/analyze`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      if (!res.ok) throw new Error(`analyze failed: ${res.status} ${await res.text()}`);
      const report = (await res.json()) as {
        riskScoreBps: number;
        veto: boolean;
        findings: { severity: string; title: string; detail: string }[];
        metrics: Record<string, number | string>;
      };
      ctx.note(`report: risk score ${fmtBps(report.riskScoreBps)}, veto = ${report.veto}`);
      for (const f of report.findings) ctx.note(`  [${f.severity}] ${f.title} — ${f.detail}`);
      ctx.note(`metrics: \`${JSON.stringify(report.metrics)}\``);
    } else {
      ctx.note(
        `backend not reachable at ${API_URL} — posting an equivalent veto directly with the attester account ` +
          '(same on-chain effect: postReport(…, veto=true))',
      );
      const hash = await ctx.wallet(ATTESTER).writeContract({
        address: ctx.deployment.attestationBoard,
        abi: ABIS.AttestationBoard,
        functionName: 'postReport',
        args: [rs.addrs.raise, reportHash, 'sim://s3/sybil-cluster', 9200, true],
        chain: undefined,
        account: ATTESTER.account,
      });
      await ctx.client.waitForTransactionReceipt({ hash });
      ctx.note('attester posts report: risk 92%, veto = true — “100% of capital beyond two wallets traces to a single funding source (deposit-time burst, shared funder)”');
    }
    const vetoActive = await ctx.client.readContract({
      address: ctx.deployment.attestationBoard,
      abi: ABIS.AttestationBoard,
      functionName: 'vetoActive',
      args: [rs.addrs.raise],
    });
    ctx.note(`on-chain vetoActive = ${vetoActive}`);

    ctx.step('the veto blocks startCommitment even though time and capital gates pass');
    await expectRevert(() => rs.startCommitment(g1), ctx, 'startCommitment under veto (VetoActive)', 'VetoActive');
    ctx.note('the AI cannot fail the raise or touch funds — it can only delay');

    ctx.step('the human council reviews and clears the veto');
    const clearHash = await ctx.wallet(COUNCIL).writeContract({
      address: ctx.deployment.attestationBoard,
      abi: ABIS.AttestationBoard,
      functionName: 'clearVeto',
      args: [rs.addrs.raise],
      chain: undefined,
      account: COUNCIL.account,
    });
    await ctx.client.waitForTransactionReceipt({ hash: clearHash });
    ctx.note('council clears the veto (starts a veto cooldown — the attester cannot immediately re-veto)');
    await rs.startCommitment(g1);

    ctx.step('commitment: everyone opts in tranche 1; Growth opens');
    for (const a of [g1, ...sybils]) await rs.commit(a, 1);
    await ctx.warp(301);
    await rs.openGrowth(DEPLOYER);

    ctx.step('the attacker goes all-in and dumps everything; there are no outside buyers');
    // All sybil tranches over the epochs; genuine backers hold their protection.
    for (let epoch = 1; epoch <= 4; epoch++) {
      if (epoch > 1) await ctx.warp(301, `epoch ${epoch}`);
      for (const w of sybils) {
        if (epoch < 4) await rs.commit(w, epoch + 1);
        await rs.claim(w, epoch);
      }
      if (epoch === 1) {
        await rs.claim(g1, 1);
        ctx.note('genuine backer1 claimed tranche 1 but does not sell into the attacker’s dump');
      }
      for (const w of sybils) await rs.sellAll(w);
    }

    ctx.step('what the attacker could and could not extract');
    let attackerIn = 0n;
    let attackerOut = 0n;
    for (const w of sybils) {
      const e = ctx.pnl.get(w.address)!;
      attackerIn += e.quoteSpent;
      attackerOut += e.quoteReceived;
    }
    ctx.note(`attacker put in ${fmtQuote(attackerIn)} via 20 wallets, got back ${fmtQuote(attackerOut)} from dumping`);
    ctx.note(`attacker net: ${fmtSignedQuote(attackerOut - attackerIn)} — dumping into a pool with no outside demand returns *less* than principal (slippage + fees)`);
    if (attackerOut >= attackerIn) {
      throw new Error('attacker profited with zero outside demand — the flat-price solvency argument is broken');
    }

    ctx.step('genuine backers are untouched: locked tranches redeem at exactly 100%');
    await rs.redeemAll(g2);
    await rs.redeemAll(g1); // tranches 2-4; tranche 1 was committed+claimed
    const g1Tokens = await ctx.tokenBalance(rs.addrs.token, g1.address);
    if (g1Tokens > 0n) {
      const worth = await rs.quoteSell(g1Tokens);
      ctx.note(`backer1's claimed tranche-1 tokens are sellable for ${fmtQuote(worth)} (committed principal was ${fmtQuote(q(2_500))}) — risk was opt-in`);
    }
    await rs.pnlTable([g1, g2, ...sybils.slice(0, 3), BUILDER]);

    return {
      id: 'S3',
      title: s3.title,
      verdict:
        `The veto path works as designed: the attester's veto blocked startCommitment with gates otherwise met, the council cleared it (starting a cooldown), and Growth opened. With no genuine outside demand the attacker's 20-wallet dump recovered only ${fmtQuote(attackerOut)} of ${fmtQuote(attackerIn)} — the flat Stage 1 price means a self-dealing builder can only ever lose money to slippage and fees, never extract other backers' principal. Genuine backers who stayed protected redeemed exactly 100%.`,
      headline: `veto blocked commitment, council cleared; attacker net ${fmtSignedQuote(attackerOut - attackerIn)} on ${fmtQuote(attackerIn)} of self-dealing`,
    };
  },
};
