#!/usr/bin/env bash
# Deploy v3.1 in a dotenv-free workspace under tools/. v1 requires --with-v1.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="$HOME/.foundry/bin:$PATH"
WITH_V1=0
for arg in "$@"; do
  case "$arg" in --with-v1) WITH_V1=1 ;; *) echo "Unknown deploy option: $arg" >&2; exit 2 ;; esac
done
WORKSPACE="${DEPLOY_WORKSPACE:-$ROOT/tools/artifacts/dev/contracts}"
mkdir -p "$WORKSPACE/script" "$WORKSPACE/deployments"
cp "$ROOT/packages/contracts/foundry.toml" "$WORKSPACE/foundry.toml"
cp "$ROOT/packages/contracts/remappings.txt" "$WORKSPACE/remappings.txt"
# Every non-deploy script file travels along: deploy scripts import shared helpers (timing profiles, fixtures).
for f in "$ROOT"/packages/contracts/script/*.sol; do
  case "$(basename "$f")" in DeployLocal.s.sol | DeployXLayerTestnet.s.sol) ;; *) cp "$f" "$WORKSPACE/script/" ;; esac
done
for dir in src lib test; do [ -e "$WORKSPACE/$dir" ] || ln -s "$ROOT/packages/contracts/$dir" "$WORKSPACE/$dir"; done
if [ "$WITH_V1" = 1 ]; then cp "$ROOT/packages/contracts/script/DeployLocal.s.sol" "$WORKSPACE/script/"; fi
cd "$WORKSPACE"
RPC_URL="${RPC_URL:-http://127.0.0.1:8545}"
# Public anvil account zero; no dotenv files are read by this workspace.
export PRIVATE_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
if [ "$WITH_V1" = 1 ]; then
  forge script script/DeployLocal.s.sol:DeployLocal --rpc-url "$RPC_URL" --broadcast --slow --non-interactive --quiet
fi
# --slow: the package exceeds one 30M-gas block; anvil automine would leave a concurrent batch's tail pending.
forge script script/DeployV31Local.s.sol:DeployV31Local --rpc-url "$RPC_URL" --private-key "$PRIVATE_KEY" --broadcast --slow --non-interactive --quiet
echo "DEPLOY: v3.1 ready (v1=$WITH_V1); manifests: $WORKSPACE/deployments"
