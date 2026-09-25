import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { deployments } from '../generated/deployments.ts';

export type DeploymentV31 = Record<string, string | number | boolean>;
export function getDeploymentV31(chainId: number): DeploymentV31 | null {
  const dir = process.env.PORTEX_DEPLOYMENTS_DIR || resolve(import.meta.dir, '../../../../packages/contracts/deployments');
  const path = resolve(dir, `${chainId}-v31.json`);
  if (!existsSync(path)) return null;
  const value = JSON.parse(readFileSync(path, 'utf8')) as DeploymentV31;
  if (value.simulated) return null;
  if (Number(value.chainId) !== chainId) throw new Error('Deployment manifest chain mismatch');
  if (chainId !== 31337 && !Number.isSafeInteger(Number(value.deploymentBlock)))
    throw new Error('Deployment manifest requires deploymentBlock');
  if (value.deploymentBlock !== undefined && (!Number.isSafeInteger(Number(value.deploymentBlock)) || Number(value.deploymentBlock) < 0))
    throw new Error('Invalid deploymentBlock');
  return value;
}
/** In-process override for isolated stacks; never rewrites the live v1 generated module. */
export function loadIsolatedV1Deployment(chainId: number): void {
  if (!process.env.PORTEX_DEPLOYMENTS_DIR) return;
  const file = resolve(process.env.PORTEX_DEPLOYMENTS_DIR, `${chainId}.json`);
  // A v3.1-only workspace must not inherit the live stack's v1 addresses.
  if (existsSync(file)) deployments[String(chainId)] = JSON.parse(readFileSync(file, 'utf8'));
  else delete deployments[String(chainId)];
}
