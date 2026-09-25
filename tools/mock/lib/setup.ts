/** Shared CLI parsing and wiring for run.ts and seed.ts. */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createPublicClient, formatEther, http, type Hex } from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { DEPLOYER } from '../../src/lib/chain';
import { ApiClient } from './api';
import { Chain } from './chain';
import { loadConfig, type MockConfig } from './config';
import { Engine, type TempoMode } from './engine';
import { configureLog, errorText, log } from './log';
import { loadDeployment, manifestPath } from './protocol';
import { loadState, stateDir } from './state';
import { loadPersonas } from './wallets';
import { AiClient, DEFAULT_BASE_URL, DEFAULT_MODEL } from '../ai/client';
import { MindService } from '../ai/mind';

export interface CliOptions {
  rpc: string;
  api: string;
  deployments?: string;
  config?: string;
  set: string[];
  tempo: TempoMode;
  dryRun: boolean;
  warp: boolean;
  ticks?: number;
  maxMinutes?: number;
  force: boolean;
  noAi: boolean;
}

const HELP = `Options (flags win over env):
  --rpc <url>            JSON-RPC endpoint            (env MOCK_RPC_URL or RPC_URL; default http://127.0.0.1:8545)
  --api <url>            Portex API base URL          (env MOCK_API_URL or API_URL; default http://localhost:8790)
  --deployments <path>   v3.1 manifest file or dir    (env MOCK_DEPLOYMENTS or PORTEX_DEPLOYMENTS_DIR; default packages/contracts/deployments)
  --config <path>        tempo config                 (default tools/mock/config/tempos.json)
  --set <path=value>     override a config value, repeatable (e.g. --set tickSeconds=10)
  --tempo <mode>         auto (bootstrap, then steady) | bootstrap | steady      [run only]
  --dry-run              print the plan and the first tick's transactions without sending anything
  --warp                 local chain only: advance chain time by warpSeconds after every tick
  --ticks <n>            stop after n ticks
  --max-minutes <n>      seed only: give up after n wall-clock minutes (default 150)
  --json | --verbose     JSON-lines logs | debug logs
  --no-ai                template behaviour only, even when MIMO_API_KEY is set
Env: MOCK_FUNDER_PRIVATE_KEY funds persona gas on non-local chains (process env only; never printed).
     MIMO_API_KEY gives the personas an AI mind (MIMO_BASE_URL, MIMO_MODEL optional; process env only).`;

export function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    rpc: process.env.MOCK_RPC_URL || process.env.RPC_URL || 'http://127.0.0.1:8545',
    api: (process.env.MOCK_API_URL || process.env.API_URL || 'http://localhost:8790').replace(/\/$/, ''),
    deployments: process.env.MOCK_DEPLOYMENTS || undefined,
    set: [],
    tempo: 'auto',
    dryRun: false,
    warp: false,
    force: false,
    noAi: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${arg} needs a value`);
      return v;
    };
    switch (arg) {
      case '--rpc':
        opts.rpc = value();
        break;
      case '--api':
        opts.api = value().replace(/\/$/, '');
        break;
      case '--deployments':
        opts.deployments = value();
        break;
      case '--config':
        opts.config = value();
        break;
      case '--set':
        opts.set.push(value());
        break;
      case '--tempo': {
        const t = value();
        if (!['auto', 'bootstrap', 'steady'].includes(t)) throw new Error('--tempo must be auto, bootstrap or steady');
        opts.tempo = t as TempoMode;
        break;
      }
      case '--dry-run':
        opts.dryRun = true;
        break;
      case '--warp':
        opts.warp = true;
        break;
      case '--ticks':
        opts.ticks = Number(value());
        break;
      case '--max-minutes':
        opts.maxMinutes = Number(value());
        break;
      case '--no-ai':
        opts.noAi = true;
        break;
      case '--force':
        opts.force = true;
        break;
      case '--json':
      case '--verbose':
        break;
      case '-h':
      case '--help':
        console.log(HELP);
        process.exit(0);
      default:
        throw new Error(`unknown option ${arg}\n${HELP}`);
    }
  }
  return opts;
}

/** Bun loads .env files from the working directory unless told not to; secrets must come from the process env only. */
function refuseDotenv(): void {
  if (process.execArgv.includes('--no-env-file')) return;
  const mode = process.env.NODE_ENV || 'development';
  const files = ['.env', '.env.local', `.env.${mode}`, `.env.${mode}.local`].filter((f) =>
    existsSync(resolve(process.cwd(), f)),
  );
  if (files.length) {
    console.error(
      `Refusing to run: Bun may have loaded ${files.join(', ')} from ${process.cwd()}. Run with \`bun --no-env-file tools/mock/<script>.ts\` or \`bun run mock:run\` from tools/.`,
    );
    process.exit(2);
  }
}

export interface Wired {
  engine: Engine;
  opts: CliOptions;
  config: MockConfig;
  funder: PrivateKeyAccount | null;
}

export async function wire(argv: string[], defaults: Partial<CliOptions> = {}): Promise<Wired> {
  refuseDotenv();
  const opts = {
    ...parseArgs(argv),
    ...Object.fromEntries(Object.entries(defaults).filter(([, v]) => v !== undefined)),
  } as CliOptions;
  configureLog({ json: argv.includes('--json'), level: argv.includes('--verbose') ? 'debug' : undefined });
  const probe = createPublicClient({ transport: http(opts.rpc, { timeout: 15_000 }) });
  const chainId = await probe.getChainId().catch((error) => {
    throw new Error(`cannot reach RPC ${opts.rpc}: ${errorText(error)}`);
  });
  if (opts.warp && chainId !== 31337) throw new Error('--warp is for the local chain (31337) only');
  const config = loadConfig(opts.config, opts.set);
  const dep = loadDeployment(manifestPath(opts.deployments, chainId), chainId);
  const chain = new Chain({
    rpcUrl: opts.rpc,
    chainId,
    dryRun: opts.dryRun,
    gasPriceMultiplier: config.gas.priceMultiplier,
    maxGasPriceGwei:
      chainId === 31337
        ? config.gas.localMaxGasPriceGwei
        : Number(process.env.MOCK_MAX_GAS_GWEI || config.gas.maxGasPriceGwei),
  });
  const code = await chain.retry('getCode', () => chain.client.getCode({ address: dep.factory }));
  if (!code || code === '0x')
    throw new Error(`factory ${dep.factory} has no code on chain ${chainId}; wrong manifest or a restarted chain`);

  let funder: PrivateKeyAccount | null = null;
  const key = process.env.MOCK_FUNDER_PRIVATE_KEY?.trim();
  if (key) {
    if (!/^(0x)?[0-9a-fA-F]{64}$/.test(key)) throw new Error('MOCK_FUNDER_PRIVATE_KEY is not a 32-byte hex key');
    funder = privateKeyToAccount((key.startsWith('0x') ? key : `0x${key}`) as Hex);
  } else if (chainId === 31337) {
    funder = privateKeyToAccount(DEPLOYER.privateKey); // anvil account #0, local only
  } else if (!opts.dryRun) {
    throw new Error('MOCK_FUNDER_PRIVATE_KEY is required on non-local chains (set it in the process environment)');
  }

  const { personas, created, path: walletsPath } = loadPersonas(chainId);
  const genesis = (await chain.retry('genesis', () => chain.client.getBlock({ blockNumber: 0n }))).hash ?? undefined;
  const { state, path: statePath, archived } = loadState(chainId, dep.factory, genesis);
  if (archived) log.warn('state-archived', { reason: 'deployment changed', archived });
  const api = new ApiClient(opts.api, opts.dryRun);
  log.info('mock', {
    chainId,
    rpc: opts.rpc,
    api: opts.api,
    manifest: dep.path,
    factory: dep.factory,
    quote: dep.quote,
    rolloverRouter: dep.rolloverRouter ?? 'none',
    router: dep.router ?? 'none (Stage 3 swaps skipped)',
    funder: funder?.address ?? 'none',
    funderBalance: funder ? formatEther(await chain.balance(funder.address)) : undefined,
    personas: personas.length,
    wallets: created ? `created ${walletsPath}` : walletsPath,
    state: statePath,
    projects: Object.keys(state.projects).length,
    dryRun: opts.dryRun || undefined,
    warp: opts.warp || undefined,
  });
  try {
    const health = await api.get('/v2/health');
    if (!health?.ok) log.warn('api-unhealthy', { health: JSON.stringify(health).slice(0, 200) });
  } catch (error) {
    log.warn('api-unreachable', { api: opts.api, error: errorText(error), note: 'off-chain steps retry every tick' });
  }
  const aiKey = opts.noAi || !config.ai.enabled ? null : process.env.MIMO_API_KEY?.trim() || null;
  const client = new AiClient({
    apiKey: aiKey,
    baseUrl: process.env.MIMO_BASE_URL || DEFAULT_BASE_URL,
    model: process.env.MIMO_MODEL || DEFAULT_MODEL,
    cacheDir: resolve(stateDir(chainId), 'ai-cache'),
    config: config.ai,
    log: (event, fields) => (event === 'ai-retry' ? log.debug(event, fields) : log.warn(event, fields)),
  });
  log.info(
    'ai',
    aiKey
      ? {
          enabled: true,
          model: client.model,
          baseUrl: client.baseUrl,
          maxCallsPerHour: config.ai.maxCallsPerHour,
          concurrency: config.ai.concurrency,
        }
      : {
          enabled: false,
          reason: opts.noAi ? '--no-ai' : !config.ai.enabled ? 'ai.enabled=false' : 'MIMO_API_KEY not set',
          behaviour: 'templates',
        },
  );
  const engine = new Engine({
    chain,
    dep,
    api,
    personas,
    funder,
    state,
    statePath,
    config,
    dryRun: opts.dryRun,
    warp: opts.warp,
    tempo: opts.tempo,
    mind: new MindService(client),
  });
  await engine.init();
  let signals = 0;
  const stop = (signal: string) => {
    signals++;
    if (signals > 1) {
      log.warn('forced-exit', { signal });
      process.exit(130);
    }
    log.info('shutdown', { signal, note: 'finishing in-flight transactions; press again to force' });
    engine.stopping = true;
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));
  return { engine, opts, config, funder };
}
