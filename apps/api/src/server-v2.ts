/** Combined entry point. The existing v1 app and its loaded modules remain unchanged. */
import { createApp, type Deps } from './server.ts';
import { loadConfig } from './config.ts';
import { openDb, listRaises } from './db.ts';
import { makeClients } from './chain.ts';
import { Indexer } from './indexer.ts';
import { Analyst } from './analyst/index.ts';
import { IndexerV31 } from './v31/indexer.ts';
import { AnalystV31 } from './v31/analyst.ts';
import { createV31App, type V31Deps } from './v31/api.ts';
import { loadIsolatedV1Deployment } from './v31/deployment.ts';
import { listRaisesV31 } from './v31/db.ts';

export function createCombinedApp(v1: Deps, v31: V31Deps) {
  const app = createApp(v1);
  app.route('/v2', createV31App(v31));
  return app;
}
export async function main(): Promise<void> {
  const config = loadConfig();
  loadIsolatedV1Deployment(config.chainId);
  const db = openDb(config.databasePath);
  const clients = makeClients(config);
  const indexer = new Indexer(db, clients.public, config);
  const analyst = new Analyst(db, clients, config);
  const indexerV31 = new IndexerV31(db, clients.public, config);
  const analystV31 = new AnalystV31(db, clients, config);
  indexer.start(); indexerV31.start();
  let analyzing = false;
  if (config.analystIntervalMs > 0) setInterval(async () => {
    if (analyzing) return;
    analyzing = true;
    try {
      for (const r of listRaises(db, 'Incubation')) await analyst.analyze(r.address).catch(console.error);
      for (const r of listRaisesV31(db).filter((r) => Number(JSON.parse(r.state).phase) === 0)) await analystV31.analyze(r.address).catch(console.error);
    } finally { analyzing = false; }
  }, config.analystIntervalMs);
  const app = createCombinedApp({ config, db, clients, indexer, analyst }, { config, db, clients, indexer: indexerV31, analyst: analystV31 });
  Bun.serve({ port: config.port, fetch: app.fetch });
  console.log(`portex-backend v1 + v2 listening on :${config.port} (chain ${config.chainId})`);
}
if (import.meta.main) void main();
