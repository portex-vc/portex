/** Portex v3.1 reads and calls used by the mock runner (ABIs from packages/contracts/abi via the generated module). */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  decodeEventLog,
  getAddress,
  parseAbi,
  zeroAddress,
  type Abi,
  type Address,
  type Hex,
  type TransactionReceipt,
} from 'viem';
import { A } from '../../src/lib/v31';
import type { Chain } from './chain';

export { A };
export const MAX_UINT256 = 2n ** 256n - 1n;
export const PHASES = ['Stage1', 'Stage2', 'ListingPending', 'Stage3', 'Dissolved'] as const;
export type Phase = (typeof PHASES)[number];

/** Secondary-market swap router (shared interface; the manifest key is `router`, zero = not deployed). */
export const SwapRouterAbi = parseAbi([
  'event Swapped(address indexed trader, address indexed token, bytes32 indexed poolId, bool buy, uint256 amountIn, uint256 amountOut, address recipient)',
  'function swapExactIn(address token, bool buy, uint256 amountIn, uint256 minAmountOut, address recipient, uint256 deadline) returns (uint256 amountOut)',
  'function quoteExactIn(address token, bool buy, uint256 amountIn) returns (uint256 amountOut)',
  'function quote() view returns (address)',
]);
/** Pre-governed-timings registries exposed immutable bounds here. */
const LegacyBoundsAbi = parseAbi([
  'function stageBounds() view returns ((uint64 stage1Min, uint64 stage1Max, uint64 stage2Min, uint64 stage2Max))',
]);

export interface Deployment {
  path: string;
  chainId: number;
  factory: Address;
  registry: Address;
  quote: Address;
  rolloverRouter: Address | null;
  router: Address | null;
  escrowTemplate: Hex;
  budgetTemplate: Hex;
  deploymentBlock: bigint;
  testQuote: boolean;
}

/** Resolve the v3.1 manifest: an explicit file, a directory holding `<chainId>-v31.json`, or the repo default. */
export function manifestPath(input: string | undefined, chainId: number): string {
  const repoDefault = resolve(dirname(fileURLToPath(import.meta.url)), '../../../packages/contracts/deployments');
  const base = input || process.env.PORTEX_DEPLOYMENTS_DIR || repoDefault;
  const path = existsSync(base) && statSync(base).isDirectory() ? resolve(base, `${chainId}-v31.json`) : resolve(base);
  if (!existsSync(path)) throw new Error(`v3.1 deployment manifest not found: ${path}`);
  return path;
}

export function loadDeployment(path: string, chainId: number): Deployment {
  const m = JSON.parse(readFileSync(path, 'utf8')) as Record<string, any>;
  if (m.simulated) throw new Error(`${path} is a simulated (dry-run) manifest`);
  if (Number(m.chainId) !== chainId) throw new Error(`manifest chain ${m.chainId} does not match RPC chain ${chainId}`);
  const addr = (v: unknown) =>
    typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v) && v.toLowerCase() !== zeroAddress ? getAddress(v) : null;
  const need = (key: string, v: unknown) => {
    const a = addr(v);
    if (!a) throw new Error(`manifest is missing ${key}`);
    return a;
  };
  return {
    path,
    chainId,
    factory: need('factory', m.factory),
    registry: need('registry', m.registry),
    quote: need('quote', m.quote ?? m.mockUSDG),
    rolloverRouter: addr(m.rolloverRouter),
    router: addr(m.router),
    escrowTemplate: m.escrowTemplate as Hex,
    budgetTemplate: m.budgetTemplate as Hex,
    deploymentBlock: BigInt(m.deploymentBlock ?? 0),
    testQuote: m.testQuote === true || chainId === 31337,
  };
}

export interface VersionParams {
  version: bigint;
  stage1Min: number;
  stage1Max: number;
  stage2Min: number;
  stage2Max: number;
  voting: number;
  dispute: number;
  execution: number;
  proposalInterval: number;
  minimumBackers: number;
  budgetCeilingMax: bigint;
  vetoMax: number;
}

/** Bounds and timers pinned into the newest published version of a template (never hard-coded). */
export async function versionParams(chain: Chain, dep: Deployment, templateId: Hex): Promise<VersionParams> {
  const count = await chain.read<bigint>(dep.registry, A.PortexRegistryV31Abi as Abi, 'versionCount', [templateId]);
  if (count === 0n) throw new Error(`template ${templateId} has no published version`);
  const version = await chain.read<bigint>(dep.registry, A.PortexRegistryV31Abi as Abi, 'versionAt', [
    templateId,
    count - 1n,
  ]);
  const tv = await chain.read<any>(dep.registry, A.PortexRegistryV31Abi as Abi, 'getVersion', [templateId, version]);
  const p = tv.parameters;
  let bounds = { stage1Min: p.stage1Min, stage1Max: p.stage1Max, stage2Min: p.stage2Min, stage2Max: p.stage2Max };
  if (bounds.stage1Min === undefined) bounds = await chain.read(dep.registry, LegacyBoundsAbi as Abi, 'stageBounds');
  return {
    version,
    stage1Min: Number(bounds.stage1Min),
    stage1Max: Number(bounds.stage1Max),
    stage2Min: Number(bounds.stage2Min),
    stage2Max: Number(bounds.stage2Max),
    voting: Number(p.voting),
    dispute: Number(p.dispute),
    execution: Number(p.execution),
    proposalInterval: Number(p.proposalInterval),
    minimumBackers: Number(p.minimumBackers),
    budgetCeilingMax: BigInt(p.budgetCeilingMax),
    vetoMax: Number(p.vetoMax),
  };
}

export interface RaiseSnapshot {
  phase: Phase;
  start: number;
  stage1End: number;
  vetoUntil: number;
  stage2Start: number;
  stage2End: number;
  listedAt: number;
  /** Stage 1 tokens sold, and tokens held by backers (the contract does not expose its live-backer count). */
  sold: bigint;
  backerTokens: bigint;
  supply: bigint;
  targetPrice: bigint;
  stateNonce: bigint;
}

export async function raiseSnapshot(chain: Chain, raise: Address, now: number): Promise<RaiseSnapshot> {
  const [d, acc, cfg, nonce] = await Promise.all([
    chain.read<any>(raise, A.RaiseCoreAbi as Abi, 'stageDeadlines'),
    chain.read<any>(raise, A.RaiseCoreAbi as Abi, 'accounting'),
    chain.read<any>(raise, A.RaiseCoreAbi as Abi, 'getConfig'),
    chain.read<bigint>(raise, A.RaiseCoreAbi as Abi, 'stateNonce'),
  ]);
  const raw = Number(d.validity.phase);
  const stage2End = Number(d.stage2End);
  const phase: Phase = (raw === 1 || raw === 2) && stage2End > 0 && now >= stage2End ? 'ListingPending' : PHASES[raw];
  return {
    phase,
    start: Number(d.start),
    stage1End: Number(d.stage1End),
    vetoUntil: Number(d.vetoUntil),
    stage2Start: Number(d.stage2Start),
    stage2End,
    listedAt: Number(d.listedAt),
    sold: BigInt(acc[0]),
    backerTokens: BigInt(acc[2]),
    supply: BigInt(cfg.supply),
    targetPrice: BigInt(cfg.targetPrice),
    stateNonce: BigInt(nonce),
  };
}

/** Decode every log in a receipt against the given ABIs; unknown logs are skipped. */
export function events(
  receipt: TransactionReceipt | null,
  ...abis: Abi[]
): { eventName: string; args: any; address: Address }[] {
  if (!receipt) return [];
  const out: { eventName: string; args: any; address: Address }[] = [];
  for (const logEntry of receipt.logs) {
    for (const abi of abis) {
      try {
        const decoded = decodeEventLog({ abi, topics: logEntry.topics, data: logEntry.data }) as {
          eventName: string;
          args: any;
        };
        out.push({ ...decoded, address: getAddress(logEntry.address) });
        break;
      } catch {
        /* not this ABI */
      }
    }
  }
  return out;
}
