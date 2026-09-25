// Loads contract ABIs and the local deployment manifest produced by
// packages/contracts/scripts/deploy-local.sh. Paths are relative to the repo root.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Abi, Address } from 'viem';

export const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
export const CONTRACTS_DIR = `${REPO_ROOT}/packages/contracts`;

const ABI_NAMES = [
  'PortexRegistry',
  'RaiseFactory',
  'Raise',
  'ProjectToken',
  'Stage2Pool',
  'DiamondVault',
  'AttestationBoard',
  'IDexAdapter',
  'MockDexAdapter',
  'MockUSDG',
] as const;

export type AbiName = (typeof ABI_NAMES)[number];

function loadAbi(name: string): Abi | null {
  try {
    const parsed = JSON.parse(readFileSync(`${CONTRACTS_DIR}/abi/${name}.json`, 'utf8'));
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    return parsed as Abi;
  } catch {
    return null;
  }
}

export const ABIS = Object.fromEntries(ABI_NAMES.map((n) => [n, loadAbi(n)])) as Record<
  AbiName,
  Abi
>;

/** SpendGovernor ships separately (Rule 2). Null until contracts/abi/SpendGovernor.json exists. */
export const GOVERNOR_ABI: Abi | null = loadAbi('SpendGovernor');

for (const name of ABI_NAMES) {
  if (!ABIS[name]) throw new Error(`Missing or invalid ABI: contracts/abi/${name}.json — run contracts/scripts/deploy-local.sh first`);
}

export interface Deployment {
  chainId: number;
  deployer: Address;
  attester: Address;
  council: Address;
  mockUSDG: Address;
  registry: Address;
  attestationBoard: Address;
  dexAdapter: Address;
  factory: Address;
  raiseImpl: Address;
  poolImpl: Address;
  vaultImpl: Address;
  tokenImpl: Address;
  templateZeroExtraction: `0x${string}`;
  templateZeroExtractionVersion: number;
  // Present only once the Rule 2 package is deployed:
  templateMilestoneFunding?: `0x${string}`;
  templateMilestoneFundingVersion?: number;
  governorImpl?: Address;
}

export function loadDeployment(): Deployment {
  const raw = readFileSync(`${process.env.PORTEX_DEPLOYMENTS_DIR || `${CONTRACTS_DIR}/deployments`}/31337.json`, 'utf8');
  return JSON.parse(raw) as Deployment;
}
