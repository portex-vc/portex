// `bun run simulate [S1 S2 …]` — runs the design §9 scenarios against a private anvil
// on port 8547 (the only port this script is allowed to touch), each on a freshly
// reverted chain state, asserting design §6 invariants after every step.
// Writes research/sim-results/<scenario>.md and an index README.md.
import { simulateV31 } from './simulate-v31';
import { execSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { Ctx } from './lib/context';
import { CONTRACTS_DIR, REPO_ROOT, loadDeployment } from './lib/abis';
import { rpcReachable, snapshot, revert, makePublicClient } from './lib/chain';
import { SCENARIOS, type ScenarioResult } from './scenarios/index';

const PORT = 8547;
const RPC_URL = `http://127.0.0.1:${PORT}`;
const RESULTS_DIR = `${REPO_ROOT}/scripts/artifacts/v1-simulation`;
const FOUNDRY = `${process.env.HOME}/.foundry/bin`;

function sh(cmd: string, cwd?: string, extraEnv: Record<string, string> = {}): string {
  return execSync(cmd, { cwd, env: { ...process.env, ...extraEnv, PATH: `${FOUNDRY}:${process.env.PATH}` }, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
}

async function waitForRpc(url: string, timeoutMs = 15_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await rpcReachable(url)) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`anvil did not come up at ${url}`);
}

async function main(): Promise<void> {
  if (process.argv.includes('--v31')) {
    await simulateV31(process.env.RPC_URL || 'http://127.0.0.1:18547', process.env.API_URL || 'http://localhost:18792');
    return;
  }
  const wanted = process.argv.slice(2).map((s) => s.toUpperCase().replace(/^S/, ''));
  const selected = SCENARIOS.filter((s) => wanted.length === 0 || wanted.includes(s.id.replace(/^S/, '')));
  if (selected.length === 0) {
    console.error(`No matching scenarios. Available: ${SCENARIOS.map((s) => s.id).join(', ')}`);
    process.exit(1);
  }

  mkdirSync(RESULTS_DIR, { recursive: true });

  // 1. fresh anvil on 8547 (ours to kill)
  if (await rpcReachable(RPC_URL)) throw new Error(`Port ${PORT} is occupied; refusing to stop an existing process`);
  await new Promise((r) => setTimeout(r, 300));
  const anvil: ChildProcess = spawn(`${FOUNDRY}/anvil`, ['--port', String(PORT), '--chain-id', '31337', '--silent'], {
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  const cleanup = () => {
    try {
      anvil.kill('SIGKILL');
    } catch {
      /* already dead */
    }
  };
  process.on('exit', cleanup);
  process.on('SIGINT', () => {
    cleanup();
    process.exit(130);
  });

  try {
    await waitForRpc(RPC_URL);
    console.log(`anvil up on :${PORT} (chain 31337)`);

    // 2. deploy the contracts (deterministic addresses on a fresh chain)
    console.log('deploying contracts via contracts/scripts/deploy-local.sh …');
    const out = sh('bash scripts/deploy-local.sh', CONTRACTS_DIR, { RPC_URL });
    console.log(out.trim().split('\n').pop());
    const deployment = loadDeployment();

    // 3. run scenarios, each on a freshly reverted state
    const client = makePublicClient(RPC_URL);
    let baseSnap = await snapshot(client);
    const results: ScenarioResult[] = [];
    let failures = 0;

    for (const scenario of selected) {
      await revert(client, baseSnap);
      baseSnap = await snapshot(client);
      console.log(`\n${'='.repeat(72)}\n${scenario.id} — ${scenario.title}\n${'='.repeat(72)}`);
      const ctx = new Ctx(RPC_URL, deployment, scenario.id);
      ctx.log(`# ${scenario.id} — ${scenario.title}\n`);
      const t0 = Date.now();
      try {
        const result = await scenario.run(ctx);
        result.durationMs = Date.now() - t0;
        results.push(result);
        ctx.log(`\n---\n_${scenario.id} finished, invariant checker green after every step (${ctx.stepNo} steps)._`);
        writeFileSync(`${RESULTS_DIR}/${scenario.id.toLowerCase()}.md`, ctx.lines.join('\n') + '\n');
        console.log(`${scenario.id}: done (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
      } catch (e) {
        failures += 1;
        const msg = e instanceof Error ? e.message : String(e);
        ctx.log(`\n## ❌ SCENARIO FAILED\n\n\`\`\`\n${msg}\n\`\`\``);
        writeFileSync(`${RESULTS_DIR}/${scenario.id.toLowerCase()}.md`, ctx.lines.join('\n') + '\n');
        console.error(`\n❌❌❌ ${scenario.id} FAILED: ${msg.split('\n')[0]}\n`);
        results.push({
          id: scenario.id,
          title: scenario.title,
          verdict: `FAILED: ${msg.split('\n')[0]}`,
          headline: '—',
          failed: true,
        });
      }
    }

    // 4. index
    writeIndex(results);
    console.log(`\nresults written to research/sim-results/ (${results.length} scenarios, ${failures} failed)`);
    if (failures > 0) process.exit(1);
  } finally {
    cleanup();
  }
}

function writeIndex(results: ScenarioResult[]): void {
  const lines: string[] = [
    '# Portex v1 — simulation results',
    '',
    `Generated by \`bun run simulate\` (anvil :8547, chain 31337, demo parameters from design §4).`,
    'Every scenario asserted the §6 invariants after every step (escrow == escrowedPrincipal,',
    'pool balance == R + builderAccrued, one-shot-dump solvency, token conservation,',
    'withdraw/redeem paid exactly the protected principal).',
    '',
    '| Scenario | Result | Headline |',
    '|---|---|---|',
    ...results.map((r) => `| [${r.id}](./${r.id.toLowerCase()}.md) — ${r.title} | ${r.failed ? '❌ FAIL' : r.skipped ? '⏭ SKIP' : '✅ PASS'} | ${r.headline} |`),
    '',
    '## Verdicts',
    '',
  ];
  for (const r of results) {
    lines.push(`- **${r.id} — ${r.title}.** ${r.verdict}`);
  }
  lines.push('');
  writeFileSync(`${RESULTS_DIR}/README.md`, lines.join('\n'));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
