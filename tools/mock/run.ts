/**
 * Long-running mock activity on a Portex v3.1 deployment. Resumable and idempotent; state lives in
 * tools/mock/state/<chainId>/. Usage is in the root README; `--help` lists every flag and env var.
 *
 *   bun --no-env-file tools/mock/run.ts [--rpc url] [--api url] [--deployments path] [--tempo auto|bootstrap|steady]
 *                                       [--dry-run] [--warp] [--ticks n] [--set path=value] [--no-ai]
 */
import { log, errorText } from './lib/log';
import { wire } from './lib/setup';

async function main() {
  const { engine, opts } = await wire(process.argv.slice(2));
  // Seed-only holds (e.g. "stay ListingPending") end once the long-running runner takes over.
  for (const p of Object.values(engine.state.projects)) if (p.hold) p.hold = null;
  if (opts.dryRun) {
    const plan = engine.planBootstrap();
    if (!engine.state.tempo.bootstrapDone && opts.tempo !== 'steady' && plan.length) {
      console.log('\nBootstrap launches (registry minimum stage lengths unless the fate needs longer):');
      console.table(plan);
    } else {
      const t = engine.state.tempo;
      log.info('plan-steady', {
        nextLaunchAt: t.nextLaunchAt ? new Date(t.nextLaunchAt * 1000).toISOString() : 'now',
        projects: Object.keys(engine.state.projects).length,
      });
    }
    console.log('\nFirst tick (nothing is sent):');
    await engine.tick();
    console.log(`\n${engine.table()}`);
    return;
  }
  await engine.loop({ ticks: opts.ticks });
  console.log(`\n${engine.table()}`);
  if (engine.d.mind.enabled) engine.logAiUsage(true);
  log.info('stopped', { ticks: engine.state.tick, ...engine.d.chain.stats });
}

main().then(
  () => process.exit(0),
  (error) => {
    log.error('fatal', { error: errorText(error) });
    process.exit(1);
  },
);
