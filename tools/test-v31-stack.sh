#!/usr/bin/env bash
# Fresh v3.1 acceptance run; owns only its isolated processes and workspace.
SECONDS=0
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="$HOME/.foundry/bin:$PATH"
ANVIL_PORT="${ANVIL_PORT:-18547}"
BACKEND_PORT="${BACKEND_PORT:-18792}"
ASSETS_PORT="${ASSETS_PORT:-18793}"
for port in "$ANVIL_PORT" "$BACKEND_PORT" "$ASSETS_PORT"; do
  case "$port" in 8545|8790|3100|8793) echo 'Refusing demo ports' >&2; exit 1 ;; esac
  if (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null; then echo "Port $port is occupied; refusing to stop its owner" >&2; exit 1; fi
done
mkdir -p "$ROOT/tools/artifacts/v31"
RUN_DIR="$(mktemp -d "$ROOT/tools/artifacts/v31/stack-XXXXXX")"
export RPC_URL="http://127.0.0.1:$ANVIL_PORT"
export API_URL="http://localhost:$BACKEND_PORT"
export DEPLOY_WORKSPACE="$RUN_DIR/contracts"
export PORTEX_DEPLOYMENTS_DIR="$DEPLOY_WORKSPACE/deployments"
export PORTEX_ASSETS_URL="http://localhost:$ASSETS_PORT"
export PORTEX_RESULTS_DIR="$RUN_DIR"
ANVIL_PID=''; BACKEND_PID=''; ASSETS_PID=''
cleanup() {
  result=$?
  echo "ISOLATED STACK: exit code $result; duration ${SECONDS}s"
  [ -z "$ASSETS_PID" ] || kill "$ASSETS_PID" 2>/dev/null || true
  [ -z "$BACKEND_PID" ] || kill "$BACKEND_PID" 2>/dev/null || true
  [ -z "$ANVIL_PID" ] || kill "$ANVIL_PID" 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
# The seed spans 103 days; finish near wall time instead of dating the demo in the future.
anvil --port "$ANVIL_PORT" --chain-id 31337 --timestamp "$(( $(date +%s) - 103 * 86400 ))" --silent > "$RUN_DIR/anvil.log" 2>&1 &
ANVIL_PID=$!
for _ in $(seq 1 100); do
  if curl -sf -H 'content-type: application/json' --data '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' "$RPC_URL" > /dev/null; then break; fi
  sleep .1
done
echo "ISOLATED STACK: fresh anvil :$ANVIL_PORT → deploy v3.1 → backend :$BACKEND_PORT → seed → simulate"
bash "$ROOT/tools/deploy-demo.sh" > "$RUN_DIR/deploy.log" 2>&1
[ ! -e "$PORTEX_DEPLOYMENTS_DIR/31337.json" ] || { echo "Unexpected v1 deployment" >&2; exit 1; }
env ASSETS_PORT="$ASSETS_PORT" bun --no-env-file "$ROOT/tools/src/demo-assets.ts" > "$RUN_DIR/assets.log" 2>&1 &
ASSETS_PID=$!
cd "$ROOT/apps/api"
env PORT="$BACKEND_PORT" DATABASE_PATH="$RUN_DIR/backend.db" PUBLIC_API_URL="$API_URL" POLL_MS=100 \
  ANTHROPIC_API_KEY= ANALYST_INTERVAL_MS=0 CONFIRMATIONS=0 PORTEX_CHAIN_ID=31337 ADMIN_ADDRESSES=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266 \
  bun --no-env-file run src/server-v2.ts > "$RUN_DIR/backend.log" 2>&1 &
BACKEND_PID=$!
healthy=0
for _ in $(seq 1 100); do
  if curl -sf "$API_URL/v2/health" | grep -q '"ok":true'; then healthy=1; break; fi
  sleep .2
done
[ "$healthy" = 1 ] || { cat "$RUN_DIR/backend.log"; exit 1; }
cd "$ROOT/tools"
bun --no-env-file run seed 2>&1 | tee "$RUN_DIR/seed.log"
echo "FRESH START: ready in ${SECONDS}s"
bun --no-env-file run simulate --v31 --require-seed | tee "$RUN_DIR/simulate.log"
echo "curl -s $API_URL/v2/raises | python3 -c \"import json,sys; [print(r['name'], r['symbol'], r['template'], r['phase']) for r in json.load(sys.stdin)]\""
curl -sf "$API_URL/v2/raises" | tee "$RUN_DIR/raises.json" | python3 -c "import json,sys; [print(r['name'], r['symbol'], r['template'], r['phase']) for r in json.load(sys.stdin)]"
curl -sf "$API_URL/v2/health" > "$RUN_DIR/health.json"
echo 'ISOLATED STACK: PASS (fresh anvil → deploy → backend → seed → simulate)'
echo "Evidence: $RUN_DIR"
