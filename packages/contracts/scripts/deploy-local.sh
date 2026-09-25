#!/usr/bin/env bash
# Deploys Portex v1 and v3.1 to a local anvil node (chain 31337) and exports ABIs.
# Usage: start anvil on :8545 first, then run scripts/deploy-local.sh
set -euo pipefail
export PATH="$HOME/.foundry/bin:$PATH"
CONTRACTS_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# Compile the real project; only deployment outputs belong in the fixture workspace.
forge_args=(--root "$CONTRACTS_ROOT")
OUTPUT_ROOT="$CONTRACTS_ROOT"
if [ -n "${DEPLOY_WORKSPACE:-}" ]; then
  mkdir -p "$DEPLOY_WORKSPACE"
  OUTPUT_ROOT="$(cd "$DEPLOY_WORKSPACE" && pwd)"
  export FOUNDRY_PROFILE=backend-fixture
fi
# Foundry discovers dotenv from its launch directory before processing --root.
cd /tmp

forge build "${forge_args[@]}" --quiet

if [ -n "${DEPLOY_WORKSPACE:-}" ]; then
  # The existing Solidity scripts write relative manifests. Give their execution an
  # isolated root while resolving every source and dependency from the real project.
  # --config-path also sets the execution root, so it must live in the workspace.
  forge config --root "$CONTRACTS_ROOT" > "$OUTPUT_ROOT/foundry.toml"
  export FOUNDRY_REMAPPINGS
  FOUNDRY_REMAPPINGS="$(forge remappings --root "$CONTRACTS_ROOT" | awk -v root="$CONTRACTS_ROOT/" '
    { split($0, parts, "="); prefix = parts[1]; target = parts[2];
      if (index(prefix, ":") && substr(prefix, 1, 1) != "/") prefix = root prefix;
      if (substr(target, 1, 1) != "/") target = root target;
      print prefix "=" target; }
  ')"
  export FOUNDRY_AUTO_DETECT_REMAPPINGS=false
  export FOUNDRY_SCRIPT="$CONTRACTS_ROOT/script"
  export FOUNDRY_TEST="$CONTRACTS_ROOT/test"
  # Fail closed if Foundry ever resolves the execution root differently.
  export FOUNDRY_FS_PERMISSIONS
  FOUNDRY_FS_PERMISSIONS="$(jq -cn --arg path "$OUTPUT_ROOT/deployments" '[{access: "read-write", path: $path}]')"
  forge_args=(--root "$OUTPUT_ROOT" --config-path "$OUTPUT_ROOT/foundry.toml"
    --contracts "$CONTRACTS_ROOT/src" --lib-paths "$CONTRACTS_ROOT/lib")
fi

RPC_URL="${RPC_URL:-http://127.0.0.1:8545}"
# anvil account #0 (well-known, localhost only)
export PRIVATE_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80

mkdir -p "$OUTPUT_ROOT/deployments" "$OUTPUT_ROOT/abi"

forge script "$CONTRACTS_ROOT/script/DeployLocal.s.sol:DeployLocal" "${forge_args[@]}" \
  --rpc-url "$RPC_URL" \
  --broadcast \
  --slow \
  --non-interactive \
  --quiet

# --slow: the v3.1 package no longer fits one 30M-gas block. Anvil's automine only mines when a transaction
# arrives, so a concurrently sent batch can leave its tail pending forever; send one transaction at a time.
forge script "$CONTRACTS_ROOT/script/DeployV31Local.s.sol:DeployV31Local" "${forge_args[@]}" \
  --rpc-url "$RPC_URL" \
  --private-key "$PRIVATE_KEY" \
  --broadcast \
  --slow \
  --non-interactive \
  --quiet

# `forge inspect <C> abi` prints a human table on Foundry >= 1.0; --json is required for a real ABI.
# SpendGovernor is exported only once it exists (Rule 2 package).
for c in PortexRegistry RaiseFactory Raise ProjectToken Stage2Pool DiamondVault AttestationBoard SpendGovernor IDexAdapter MockDexAdapter MockUSDG RaiseCore ProjectTokenV31 GovernanceV31 VestingVaultV31 ClaimVault TreasuryV31 RolloverRouterV31 RaiseFactoryV31 PortexRegistryV31 MockV4Adapter MockUSDGV31 UniswapV4Adapter PortexSwapRouterV31; do
  if [ "$c" = "SpendGovernor" ] && [ ! -f "$CONTRACTS_ROOT/src/SpendGovernor.sol" ]; then continue; fi
  source_path=''
  for dir in src src/v31 src/v31/venue src/interfaces src/mocks; do
    if [ -f "$CONTRACTS_ROOT/$dir/$c.sol" ]; then source_path="$CONTRACTS_ROOT/$dir/$c.sol"; break; fi
  done
  [ -n "$source_path" ] || { echo "Missing source for $c" >&2; exit 1; }
  forge inspect "$source_path:$c" abi --json "${forge_args[@]}" > "$OUTPUT_ROOT/abi/$c.json"
  jq -e 'type == "array" and length > 0' "$OUTPUT_ROOT/abi/$c.json" > /dev/null || { echo "ERROR: abi/$c.json is not a valid ABI array" >&2; exit 1; }
done

echo "OK: deployments/31337.json, deployments/31337-v31.json and abi/*.json written"
