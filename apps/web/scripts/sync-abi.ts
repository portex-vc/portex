import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync } from "node:fs";
import { resolve } from "node:path";
const names = [
  "RaiseCore",
  "ProjectTokenV31",
  "GovernanceV31",
  "ClaimVault",
  "VestingVaultV31",
  "TreasuryV31",
  "RolloverRouterV31",
  "RaiseFactoryV31",
  "PortexRegistryV31",
  "MockV4Adapter",
  "MockUSDGV31",
  "UniswapV4Adapter",
  "PortexSwapRouterV31",
];
const source = process.env.PORTEX_ABI_DIR ?? resolve(import.meta.dir, "../../../packages/contracts/abi");
const out = resolve(import.meta.dir, "../src/generated/abi");
mkdirSync(out, { recursive: true });
const allowed = new Set(names.map((name) => `${name}.json`));
const legacy = [
  ...readdirSync(out)
    .filter((file) => !allowed.has(file))
    .map((file) => resolve(out, file)),
];
const deployments = resolve(out, "../deployments");
if (existsSync(deployments)) for (const file of readdirSync(deployments)) legacy.push(resolve(deployments, file));
if (legacy.length) {
  const archive = resolve(import.meta.dir, `../e2e/.tmp/retired-generated-${Date.now()}`);
  mkdirSync(archive, { recursive: true });
  for (const [index, file] of legacy.entries())
    renameSync(file, resolve(archive, `${index}-${file.split("/").at(-1)}`));
}
for (const name of names) copyFileSync(resolve(source, `${name}.json`), resolve(out, `${name}.json`));
console.log(`sync-abi: ${names.length} v3.1 ABIs (${names.join(", ")})`);
