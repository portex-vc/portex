// `bun run seed` — populates the running local stack (anvil :8545, deployed via dev.sh)
// with seven AI-agent raises at different lifecycle stages so the UI is fully populated:
//   1. Incubation, mid-raise          5. Migrated (Stage 3, DEX live)
//   2. Incubation, about to pass      6. Failed (gates missed)
//   3. Commitment window open         7. MILESTONE_FUNDING in Incubation with an active
//   4. Growth with trade history         spend proposal that has YES and NO votes
// Posts signed feedback, builder profiles and builder updates through the backend when it
// is reachable, and runs the analyst via signed `POST /analyze` for every raise (deployer
// key, which dev.sh puts in ADMIN_ADDRESSES). Ends by verifying via the API that every
// raise has a risk score and a description, and prints a summary table.
import { ATTESTER, BACKERS, BUILDER, DEPLOYER, WHALE, type Actor } from './lib/chain';
import { ABIS, GOVERNOR_ABI, loadDeployment } from './lib/abis';
import { Ctx } from './lib/context';
import { fmtQuote, q } from './lib/format';
import { RaiseSim } from './lib/raise';
import { keccak256, sha256, stringToBytes, toBytes, type Address } from 'viem';

const RPC_URL = process.env.RPC_URL ?? 'http://127.0.0.1:8545';
const API_URL = process.env.API_URL ?? 'http://localhost:8790';

const [b1, b2, b3, b4, b5] = BACKERS;

interface Project {
  name: string;
  symbol: string;
  description: string;
  tagline: string;
  website: string;
  twitter: string;
  updates: { title: string; body: string; kind: 'milestone' | 'update' | 'incident' }[];
}

const PROJECTS: Record<string, Project> = {
  incubating: {
    name: 'Pinger',
    symbol: 'PING',
    description:
      'Autonomous uptime agents for on-chain services. Pinger agents watch your contracts, oracles and APIs from five regions and open an incident (with a suggested fix) before your users notice.',
    tagline: 'Uptime agents that page you before your users do',
    website: 'https://pinger.example.dev',
    twitter: '@pingeragents',
    updates: [
      { title: 'Five-region watcher network is live', body: 'Pinger agents now probe from five regions and cross-check results before opening an incident. False-positive rate on the demo corpus dropped to zero.', kind: 'milestone' },
      { title: 'Suggested-fix engine shipped to testers', body: 'Incidents now come with a suggested remediation (rollback target, config diff or runbook link). Try it against the demo deployment and leave feedback.', kind: 'update' },
    ],
  },
  almostGates: {
    name: 'RelayEye',
    symbol: 'REYE',
    description:
      'A cross-chain MEV watchdog. RelayEye agents trace bundles across bridges and sequencers, and alert LPs and routers when their flow is being sandwiched — with cryptographic receipts.',
    tagline: 'Cross-chain MEV watchdog with cryptographic receipts',
    website: 'https://relayeye.example.dev',
    twitter: '@relayeye',
    updates: [
      { title: 'Bridge bundle tracing shipped', body: 'RelayEye now follows bundles across the two test bridges and attributes sandwich flow to the originating builder.', kind: 'milestone' },
      { title: 'Receipt format stabilized', body: 'Alert receipts are now deterministic and verifiable offline; the schema is frozen for the incubation cohort.', kind: 'update' },
    ],
  },
  commitment: {
    name: 'Dockminder',
    symbol: 'DOCK',
    description:
      'Agentic incident response for container fleets. Dockminder correlates logs, metrics and deploy diffs, then executes runbooks (rollback, scale, quarantine) under a human-approved policy.',
    tagline: 'Runbook-driven incident response for container fleets',
    website: 'https://dockminder.example.dev',
    twitter: '@dockminder',
    updates: [
      { title: 'Chaos-week drills passed', body: 'Dockminder executed 41 rollback/scale/quarantine runbooks in staging chaos week with zero unauthorized actions.', kind: 'milestone' },
      { title: 'Policy approval UX reworked', body: 'Human-approval steps now show the exact blast radius of a runbook before you sign off.', kind: 'update' },
    ],
  },
  growth: {
    name: 'Quorum',
    symbol: 'QORM',
    description:
      'A swarm of code-review agents that argue with each other before they argue with you. Quorum runs five specialist reviewers per PR and only surfaces findings with multi-agent consensus.',
    tagline: 'Five reviewers argue so you only read what matters',
    website: 'https://quorum.example.dev',
    twitter: '@quorumreviews',
    updates: [
      { title: 'Multi-agent consensus reviewer shipped', body: 'Findings are now only surfaced when at least three of five specialist reviewers agree. Precision on our internal benchmark: 0.93.', kind: 'milestone' },
      { title: 'Monorepo performance improvements', body: 'Review latency on 10k-file monorepos dropped from 9 minutes to under 3.', kind: 'update' },
    ],
  },
  migrated: {
    name: 'Cartographer',
    symbol: 'CART',
    description:
      'Agents that map smart-contract risk. Cartographer continuously builds a dependency graph of every protocol you integrate with and simulates contagion paths when any of them wobbles.',
    tagline: 'A living dependency map of your protocol risk',
    website: 'https://cartographer.example.dev',
    twitter: '@cartographerai',
    updates: [
      { title: 'Contagion simulator graduated', body: 'Cartographer correctly flagged oracle-exposure contagion two days before the testnet depeg drill. The migration to the open market is complete.', kind: 'milestone' },
      { title: 'Graph now covers 212 protocols', body: 'Dependency coverage doubled this epoch; simulation runs hourly instead of daily.', kind: 'update' },
    ],
  },
  failed: {
    name: 'VaporMind',
    symbol: 'VAPR',
    description: 'LLM trading signals, allegedly. The community tested it for two weeks and politely declined to give up principal protection.',
    tagline: 'Trading signals, allegedly',
    website: 'https://vapormind.example.dev',
    twitter: '@vapormind',
    updates: [
      { title: 'Live signal trial concluded', body: 'Two weeks of live signals tracked the backtest poorly. We are winding the raise down; all principal remains withdrawable 1:1.', kind: 'incident' },
      { title: 'Refund path verified', body: 'Withdrawals return exactly the deposited amount. Thank you to everyone who tested.', kind: 'update' },
    ],
  },
  milestone: {
    name: 'BenchmarkForge',
    symbol: 'FORGE',
    description:
      'Milestone-funded eval infrastructure. BenchmarkForge agents generate adversarial benchmarks for your agent stack and gate each funding milestone on a public vote of the incubation cohort.',
    tagline: 'Adversarial benchmarks, funded milestone by milestone',
    website: 'https://benchmarkforge.example.dev',
    twitter: '@benchforge',
    updates: [
      { title: 'First milestone proposed', body: 'We asked the cohort to release 2,000 USDG for the adversarial benchmark suite — vote is open, YES and NO votes are already in.', kind: 'milestone' },
      { title: 'Benchmark generator demo', body: 'The generator now produces 40 adversarial tasks per hour against a target agent. Try it from the docs.', kind: 'update' },
    ],
  },
};

async function apiReachable(): Promise<boolean> {
  try {
    return (await fetch(`${API_URL}/v1/health`, { signal: AbortSignal.timeout(1200) })).ok;
  } catch {
    return false;
  }
}

/**
 * One signed API call under the Portex signed-request scheme (docs/API_CONTRACT.md):
 * EIP-191 over `Portex request\n<METHOD> <path>\nts: <unix>\nbody: <sha256(body)>`,
 * sent as X-Portex-Address / X-Portex-Signature / X-Portex-Ts headers.
 */
async function signedApi(ctx: Ctx, actor: Actor, method: string, path: string, bodyObj: unknown): Promise<Response> {
  const body = JSON.stringify(bodyObj ?? {});
  const ts = Math.floor(Date.now() / 1000);
  const message = `Portex request\n${method} ${path}\nts: ${ts}\nbody: ${sha256(stringToBytes(body))}`;
  const signature = await ctx.wallet(actor).signMessage({ message, account: actor.account });
  return fetch(`${API_URL}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      'X-Portex-Address': actor.address,
      'X-Portex-Signature': signature,
      'X-Portex-Ts': String(ts),
    },
    body,
  });
}

/** Wait until the backend indexer knows a raise (so /analyze and writes can find it). */
async function waitForIndexed(ctx: Ctx, raise: Address): Promise<boolean> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${API_URL}/v1/raises/${raise}`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return true;
    } catch { /* backend restarting */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  ctx.note(`raise ${raise} was not indexed within 30s`);
  return false;
}

async function postFeedback(ctx: Ctx, raise: Address, author: (typeof BACKERS)[number], rating: number, text: string): Promise<void> {
  const message = `Portex feedback\nraise: ${raise.toLowerCase()}\nrating: ${rating}\ntext: ${text}`;
  const signature = await ctx.wallet(author).signMessage({ message, account: author.account });
  const res = await fetch(`${API_URL}/v1/raises/${raise}/feedback`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ author: author.address, rating, text, signature }),
  });
  if (!res.ok) ctx.note(`feedback POST failed (${res.status}): ${(await res.text()).slice(0, 120)}`);
}

/** Builder-signed profile (new signed-request scheme). Also sets description/website. */
async function postProfile(ctx: Ctx, raise: Address, p: Project): Promise<void> {
  const res = await signedApi(ctx, BUILDER, 'PUT', `/v1/raises/${raise}/profile`, {
    name: p.name,
    tagline: p.tagline,
    description: p.description,
    website: p.website,
    twitter: p.twitter,
    github: '',
    docs: '',
  });
  if (!res.ok) ctx.note(`profile PUT failed for ${p.symbol} (${res.status}): ${(await res.text()).slice(0, 120)}`);
}

async function postUpdate(ctx: Ctx, raise: Address, p: Project, u: Project['updates'][number]): Promise<void> {
  const res = await signedApi(ctx, BUILDER, 'POST', `/v1/raises/${raise}/updates`, { title: u.title, body: u.body, kind: u.kind });
  if (!res.ok) ctx.note(`update POST failed for ${p.symbol} (${res.status}): ${(await res.text()).slice(0, 120)}`);
}

/** Run the analyst through the backend. Signed by the deployer (an ADMIN_ADDRESSES entry). */
async function analyze(ctx: Ctx, raise: Address, label: string): Promise<boolean> {
  const res = await signedApi(ctx, DEPLOYER, 'POST', `/v1/raises/${raise}/analyze`, {});
  if (!res.ok) {
    ctx.note(`analyze ${label} failed (${res.status}): ${(await res.text()).slice(0, 160)}`);
    return false;
  }
  const report = (await res.json()) as { riskScoreBps: number; veto: boolean };
  ctx.note(`analyze ${label}: risk ${report.riskScoreBps / 100}%${report.veto ? ' · VETO' : ''}`);
  return true;
}

async function postReport(ctx: Ctx, raise: Address, riskScoreBps: number, uri: string): Promise<void> {
  const hash = await ctx.wallet(ATTESTER).writeContract({
    address: ctx.deployment.attestationBoard,
    abi: ABIS.AttestationBoard,
    functionName: 'postReport',
    args: [raise, keccak256(toBytes(uri)), uri, riskScoreBps, false],
    chain: undefined,
    account: ATTESTER.account,
  });
  await ctx.client.waitForTransactionReceipt({ hash });
}

async function main(): Promise<void> {
  const deployment = loadDeployment();
  const ctx = new Ctx(RPC_URL, deployment, 'SEED');

  const code = await ctx.client.getCode({ address: deployment.factory });
  if (!code) {
    console.error('No factory at the deployed address on this chain. Start the stack first: `bun run dev` (deploys to :8545).');
    process.exit(1);
  }
  const useApi = await apiReachable();
  console.log(`seeding against ${RPC_URL}; backend at ${API_URL} ${useApi ? 'reachable — feedback will be signed and posted' : 'NOT reachable — skipping API posts'}`);

  // ============ t0: the three "advanced" raises + the failed one ============
  console.log('\n— creating Commitment / Growth / Migrated / Failed raises —');
  const rCommit = await RaiseSim.create(ctx, { builder: BUILDER, ...PROJECTS.commitment });
  const rGrowth = await RaiseSim.create(ctx, { builder: BUILDER, ...PROJECTS.growth });
  const rMigrated = await RaiseSim.create(ctx, { builder: BUILDER, ...PROJECTS.migrated });
  const rFailed = await RaiseSim.create(ctx, { builder: BUILDER, ...PROJECTS.failed });

  for (const a of [b1, b2, b3, b4, b5]) await ctx.faucet(a, q(200_000));
  await ctx.faucet(WHALE, q(500_000));

  // Failed raise: two backers, never reaches the soft cap
  await rFailed.deposit(b4, q(10_000));
  await rFailed.deposit(b5, q(10_000));

  // Commitment raise: 60k from three backers
  await rCommit.deposit(b1, q(25_000));
  await rCommit.deposit(b2, q(20_000));
  await rCommit.deposit(b3, q(15_000));

  // Growth + Migrated raises: 60k from four backers each
  for (const [rs] of [[rGrowth], [rMigrated]] as const) {
    await rs.deposit(b1, q(18_000));
    await rs.deposit(b2, q(16_000));
    await rs.deposit(b3, q(14_000));
    await rs.deposit(b4, q(12_000));
  }

  // ============ min incubation elapses ============
  await ctx.warp(601, 'minIncubation for the t0 cohort');
  await rCommit.startCommitment(b1);
  await rGrowth.startCommitment(b1);
  await rMigrated.startCommitment(b1);

  // Commitment raise: partial opt-in, window still open at the end of the seed
  await rCommit.commit(b1, 1);
  await rCommit.commit(b3, 1);

  // Growth + Migrated: everyone commits tranche 1 in epoch 0
  for (const rs of [rGrowth, rMigrated]) for (const a of [b1, b2, b3, b4]) await rs.commit(a, 1);

  await ctx.warp(301, 'commitment window ends for the Growth/Migrated raises');
  await rGrowth.openGrowth(DEPLOYER);
  await rMigrated.openGrowth(DEPLOYER);

  // ============ Growth epochs: trade history on both, harder push on the Migrated one ============
  for (let epoch = 1; epoch <= 4; epoch++) {
    if (epoch > 1) await ctx.warp(301, `epoch ${epoch}`);
    for (const a of [b1, b2, b3, b4]) {
      if (epoch < 4) {
        await rGrowth.commit(a, epoch + 1);
        await rMigrated.commit(a, epoch + 1);
      }
      await rGrowth.claim(a, epoch, a === b1 && epoch <= 2); // b1 stakes early tranches
      await rMigrated.claim(a, epoch, a === b1);
    }
    // trade history: whale buys, a couple of backers trim
    await rGrowth.buy(WHALE, q(4_000 + epoch * 1_500));
    await rMigrated.buy(WHALE, q(6_000));
    if (epoch >= 2) {
      const bal = await ctx.tokenBalance(rGrowth.addrs.token, b3.address);
      if (bal > 0n) await rGrowth.sell(b3, bal / 3n);
      const balM = await ctx.tokenBalance(rMigrated.addrs.token, b4.address);
      if (balM > 0n) await rMigrated.sell(b4, balM / 2n);
    }
  }

  // ============ graduate the Migrated raise, trade on the DEX ============
  await rMigrated.ensureGraduationTime();
  await rMigrated.graduate(DEPLOYER);
  await rMigrated.dexBuy(WHALE, q(8_000));
  const b2M = await ctx.tokenBalance(rMigrated.addrs.token, b2.address);
  if (b2M > 0n) await rMigrated.dexSell(b2, b2M / 4n);
  await ctx.warp(601, 'vault stream + builder vesting underway');
  await rMigrated.vaultClaim(b1);
  await rMigrated.claimBuilderVested(DEPLOYER);
  await rGrowth.claimBuilderFees(DEPLOYER);

  // ============ the failed raise times out ============
  await rFailed.fail(DEPLOYER);
  await rFailed.withdraw(b4);
  ctx.note('b5 has not withdrawn yet — Failed raises keep escrow claimable forever');

  // ============ late-created raises land mid-incubation ============
  console.log('\n— creating the two Incubation-stage raises —');
  const rIncubating = await RaiseSim.create(ctx, { builder: BUILDER, ...PROJECTS.incubating });
  await rIncubating.deposit(b1, q(12_000));
  await ctx.warp(300, 'Pinger is mid-incubation');
  await rIncubating.deposit(b2, q(8_000));

  const rAlmost = await RaiseSim.create(ctx, { builder: BUILDER, ...PROJECTS.almostGates });
  await rAlmost.deposit(b1, q(22_000));
  await rAlmost.deposit(b2, q(18_000));
  await rAlmost.deposit(b3, q(12_000));
  await ctx.warp(540, 'RelayEye: capital gate met (52k ≥ 50k), ~60s short of minIncubation');

  // ============ the MILESTONE_FUNDING raise with an active proposal ============
  // Created last so the vote is still open when the seed finishes.
  let rMilestone: RaiseSim | null = null;
  if (GOVERNOR_ABI && deployment.templateMilestoneFunding) {
    const govAbi = GOVERNOR_ABI;
    console.log('\n— creating the MILESTONE_FUNDING raise with an active spend proposal —');
    rMilestone = await RaiseSim.create(ctx, {
      builder: BUILDER,
      ...PROJECTS.milestone,
      templateId: deployment.templateMilestoneFunding,
      templateVersion: deployment.templateMilestoneFundingVersion ?? 1,
      overrides: { maxCumulativeSpendBps: 3000 }, // Rule 2: 30% cumulative spend ceiling
    });
    await rMilestone.deposit(b1, q(20_000));
    await rMilestone.deposit(b2, q(18_000));
    await rMilestone.deposit(b3, q(12_000));
    const govWrite = async (actor: Actor, fn: string, args: unknown[]) => {
      const hash = await ctx.wallet(actor).writeContract({
        address: rMilestone!.addrs.governor,
        abi: govAbi,
        functionName: fn,
        args: args as never,
        chain: undefined,
        account: actor.account,
      });
      await ctx.client.waitForTransactionReceipt({ hash });
    };
    await govWrite(BUILDER, 'propose', [q(2_000), 'seed://benchmarkforge/milestone-1']);
    ctx.note('proposal 1: 2,000 USDG milestone spend (voting open)');
    await govWrite(b1, 'vote', [1, true]);
    await govWrite(b3, 'vote', [1, false]);
    ctx.note('b1 voted YES (20k weight), b3 voted NO (12k weight) — the proposal stays active');
  } else {
    ctx.note('MILESTONE_FUNDING template not deployed — skipping the milestone raise');
  }

  // ============ profiles + updates + reports + feedback ============
  const all: [string, RaiseSim][] = [
    ['incubating', rIncubating],
    ['almostGates', rAlmost],
    ['commitment', rCommit],
    ['growth', rGrowth],
    ['migrated', rMigrated],
    ['failed', rFailed],
    ...(rMilestone ? [['milestone', rMilestone] as [string, RaiseSim]] : []),
  ];

  if (useApi) {
    console.log('\n— posting builder profiles + updates + signed feedback through the backend —');
    for (const [key, rs] of all) {
      const p = PROJECTS[key];
      await waitForIndexed(ctx, rs.addrs.raise);
      await postProfile(ctx, rs.addrs.raise, p);
      for (const u of p.updates) await postUpdate(ctx, rs.addrs.raise, p, u);
    }
    await postFeedback(ctx, rIncubating.addrs.raise, b1, 4, 'The uptime agent caught our staging outage. Following the incubation trial.');
    await postFeedback(ctx, rAlmost.addrs.raise, b2, 4, 'The MEV tracing demo reproduced the transactions we submitted.');
    if (rMilestone) await postFeedback(ctx, rMilestone.addrs.raise, b1, 4, 'Reviewed the adversarial benchmark milestone and cast my capital-weighted vote.');
    await postFeedback(ctx, rGrowth.addrs.raise, b1, 5, 'Ran the review swarm on 30 PRs from our repo. Two of the five agents disagreed on a race condition — the consensus view was right. Staking my early tranches.');
    await postFeedback(ctx, rGrowth.addrs.raise, b2, 4, 'Solid precision, a bit slow on monorepos. Committed two tranches.');
    await postFeedback(ctx, rGrowth.addrs.raise, b3, 3, 'Good reviews but the false-positive rate on generated code is high. Trimming a third of my position.');
    await postFeedback(ctx, rMigrated.addrs.raise, b1, 5, 'Cartographer flagged our exposure to a wobbling oracle two days before it depegged. Full conviction.');
    await postFeedback(ctx, rMigrated.addrs.raise, b4, 4, 'The contagion graphs are genuinely useful. Took some profit after migration.');
    await postFeedback(ctx, rCommit.addrs.raise, b3, 4, 'Dockminder’s rollback drills worked in our staging chaos week. In for the long haul.');
    await postFeedback(ctx, rFailed.addrs.raise, b5, 2, 'Backtest looked great, live signals were coin flips. Glad the principal protection is real.');

    // ============ run the analyst for every raise (deployer key, admin-signed) ============
    console.log('\n— running the analyst through the backend for every raise —');
    for (const [key, rs] of all) {
      await analyze(ctx, rs.addrs.raise, PROJECTS[key].symbol);
    }
  } else {
    // no backend: post analyst reports directly so the UI still has them
    await postReport(ctx, rGrowth.addrs.raise, 1800, 'seed://reports/quorum');
    await postReport(ctx, rMigrated.addrs.raise, 1200, 'seed://reports/cartographer');
    await postReport(ctx, rCommit.addrs.raise, 2500, 'seed://reports/dockminder');
  }

  console.log('\nSeed complete. Raises:');
  for (const [label, rs] of [
    ['Incubation (mid)', rIncubating],
    ['Incubation (gates ~met)', rAlmost],
    ['Commitment', rCommit],
    ['Growth', rGrowth],
    ['Migrated', rMigrated],
    ['Failed', rFailed],
    ...(rMilestone ? [['Milestones (vote open)', rMilestone] as const] : []),
  ] as const) {
    console.log(`  ${label.padEnd(24)} ${rs.name} (${rs.symbol})  ${rs.addrs.raise}`);
  }

  // ============ verify via the API: every raise has a risk score and a description ============
  if (useApi) {
    console.log('\n— verifying via GET /v1/raises —');
    const ours = new Map(all.map(([, rs]) => [rs.addrs.raise.toLowerCase(), rs]));
    // the indexer needs a beat to see the last transactions
    const deadline = Date.now() + 30_000;
    let rows: { address: string; name: string; symbol: string; state: string; riskScoreBps: number | null; description: string }[] = [];
    for (;;) {
      const res = await fetch(`${API_URL}/v1/raises`);
      rows = (await res.json()) as typeof rows;
      if (rows.filter((r) => ours.has(r.address.toLowerCase())).length >= ours.size) break;
      if (Date.now() > deadline) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    console.log(`\n  ${'raise'.padEnd(16)} ${'state'.padEnd(11)} ${'risk'.padStart(7)}  description`);
    console.log(`  ${'-'.repeat(16)} ${'-'.repeat(11)} ${'-'.repeat(7)}  ${'-'.repeat(60)}`);
    const failures: string[] = [];
    for (const [, rs] of all) {
      const row = rows.find((r) => r.address.toLowerCase() === rs.addrs.raise.toLowerCase());
      if (!row) {
        failures.push(`${rs.symbol}: not in GET /v1/raises`);
        console.log(`  ${rs.symbol.padEnd(16)} ${'?'.padEnd(11)} ${'?'.padStart(7)}  (not indexed)`);
        continue;
      }
      const risk = row.riskScoreBps === null ? '—' : `${(row.riskScoreBps / 100).toFixed(1)}%`;
      const desc = row.description.length > 60 ? `${row.description.slice(0, 57)}…` : row.description;
      console.log(`  ${rs.symbol.padEnd(16)} ${row.state.padEnd(11)} ${risk.padStart(7)}  ${desc}`);
      if (row.riskScoreBps === null) failures.push(`${rs.symbol}: riskScoreBps is null`);
      if (!row.description) failures.push(`${rs.symbol}: description is empty`);
    }
    if (failures.length > 0) {
      console.error(`\nSEED VERIFICATION FAILED:\n  ${failures.join('\n  ')}`);
      process.exit(1);
    }
    console.log('\n  ✔ every raise has a risk score and a non-empty description');
  }
}

export async function seedV1(): Promise<void> {
  await main();
}
