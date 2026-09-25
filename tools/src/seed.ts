// The v1 demo is archived and loaded only by explicit opt-in.
import { seedDemoV31 as seedV31 } from './seed-v31';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  for (const arg of args) if (!['--v31', '--v1', '--seed-v1'].includes(arg)) throw new Error(`Unknown seed option: ${arg}`);
  const rpc = process.env.RPC_URL ?? 'http://127.0.0.1:8545';
  const api = process.env.API_URL ?? 'http://localhost:8790';
  if (!args.includes('--v1')) await seedV31(rpc, api);
  if (args.includes('--v1') || args.includes('--seed-v1')) await (await import('./seed-v1')).seedV1();
}
main().catch((error) => { console.error(error); process.exit(1); });
