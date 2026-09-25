/**
 * A small initial set of projects at different stages, as fast as the chain allows (registry minimum stage
 * lengths): two in Stage 3 with trading history, one ListingPending, two in Stage 2 (one Budget draw in vote),
 * one Dissolved and one still in Stage 1. Afterwards `run.ts` continues in the steady tempo.
 *
 *   bun --no-env-file tools/mock/seed.ts [--rpc url] [--api url] [--deployments path] [--warp] [--max-minutes n]
 */
import type { LaunchSpec } from './lib/engine';
import { log, errorText } from './lib/log';
import { wire } from './lib/setup';
import type { ProjectState } from './lib/state';

const PLAN: (LaunchSpec & { target: 'Stage1' | 'Stage2' | 'ListingPending' | 'Stage3' | 'Dissolved' })[] = [
  { target: 'Stage3', fate: 'graduate', template: 'ESCROW_LAUNCH', stage1: 'min', stage2: 'min' },
  { target: 'Stage3', fate: 'graduate', template: 'BUDGET_LAUNCH', stage1: 'min', stage2: 'min' },
  {
    target: 'ListingPending',
    fate: 'graduate',
    template: 'ESCROW_LAUNCH',
    stage1: 'min',
    stage2: 'min',
    hold: 'ListingPending',
  },
  { target: 'Stage2', fate: 'graduate', template: 'BUDGET_LAUNCH', stage1: 'min', stage2: 'long' },
  { target: 'Stage2', fate: 'graduate', template: 'ESCROW_LAUNCH', stage1: 'min', stage2: 'long' },
  { target: 'Dissolved', fate: 'dissolve-builder', template: 'ESCROW_LAUNCH', stage1: 'min', stage2: 'min' },
  { target: 'Stage1', fate: 'graduate', template: 'ESCROW_LAUNCH', stage1: 'long', stage2: 'long', hold: 'Stage1' },
];

async function main() {
  const { engine, opts } = await wire(process.argv.slice(2), { tempo: 'bootstrap' });
  const state = engine.state;
  if (Object.keys(state.projects).length && !opts.force)
    throw new Error(
      `state already has ${Object.keys(state.projects).length} projects; seed is for a fresh deployment (use --force to add anyway)`,
    );
  // The seed replaces the bootstrap tempo; run.ts continues in steady mode afterwards.
  state.tempo.bootstrapDone = true;
  state.tempo.seeded = true;
  const seeded: { p: ProjectState; target: string }[] = [];
  for (const spec of PLAN) {
    const p = await engine.launch(spec);
    if (p) seeded.push({ p, target: spec.target });
  }
  if (opts.dryRun) {
    console.log(`\n${engine.table()}`);
    return;
  }
  const deadline = Date.now() + (opts.maxMinutes ?? 150) * 60_000;
  const reached = ({ p, target }: { p: ProjectState; target: string }) => {
    if (!p.raise || !p.profileSet || p.lastPhase !== target) return false;
    if (target === 'Stage3') return engine.now - (p.phaseSince ?? engine.now) >= 3 * engine.config.tickSeconds;
    if (target === 'Stage2') return p.template === 'BUDGET_LAUNCH' ? p.proposals.length > 0 : p.market.trades > 0;
    return true;
  };
  await engine.loop({ stopWhen: () => seeded.every(reached) || Date.now() > deadline });
  state.tempo.nextLaunchAt = engine.now + 60 * 60;
  engine.save();
  console.log(`\n${engine.table()}`);
  if (engine.d.mind.enabled) engine.logAiUsage(true);
  const missing = seeded
    .filter((s) => !reached(s))
    .map((s) => `${s.p.ticker}: ${s.p.lastPhase ?? 'pending'} (want ${s.target})`);
  if (missing.length) throw new Error(`seed stopped before every target was reached: ${missing.join('; ')}`);
  log.info('seed-complete', {
    projects: seeded.length,
    next: 'bun --no-env-file tools/mock/run.ts (continues in the steady tempo)',
  });
}

main().then(
  () => process.exit(0),
  (error) => {
    log.error('fatal', { error: errorText(error) });
    process.exit(1);
  },
);
