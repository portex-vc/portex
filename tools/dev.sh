#!/usr/bin/env bash
# Portex v3.1 local demo: deploy, backend, monograms, frontend, seven seeded raises.
# Flags: --fresh · --no-frontend · --no-backend · --no-seed · --seed
#        --with-v1 (also deploy v1) · --seed-v1 (also seed v1; requires --with-v1)
# Existing listeners are never stopped. Stop your previous dev session before --fresh.
# PUBLIC_HOST=<lan-ip> binds anvil to all interfaces and gives the browser LAN URLs (open the app from another
# machine, e.g. a VM's host); the default stays localhost-only.
set -euo pipefail
SECONDS=0
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="$HOME/.foundry/bin:$PATH"
WITH_FRONTEND=1; WITH_BACKEND=1; RUN_SEED=1; WITH_V1=0; SEED_V1=0
for arg in "$@"; do
  case "$arg" in
    --fresh) : ;;
    --no-frontend) WITH_FRONTEND=0 ;;
    --no-backend) WITH_BACKEND=0 ;;
    --no-seed) RUN_SEED=0 ;;
    --seed) RUN_SEED=1 ;;
    --with-v1) WITH_V1=1 ;;
    --seed-v1) SEED_V1=1 ;;
    -h|--help) sed -n '2,5p' "$0"; exit 0 ;;
    *) echo "unknown flag: $arg" >&2; exit 2 ;;
  esac
done
[ "$SEED_V1" = 0 ] || [ "$WITH_V1" = 1 ] || { echo '--seed-v1 requires --with-v1' >&2; exit 2; }
[ "$RUN_SEED" = 0 ] || [ "$WITH_BACKEND" = 1 ] || { echo '--no-backend requires --no-seed' >&2; exit 2; }
ANVIL_PORT="${ANVIL_PORT:-8545}"; BACKEND_PORT="${BACKEND_PORT:-8790}"
FRONTEND_PORT="${FRONTEND_PORT:-3100}"; ASSETS_PORT="${ASSETS_PORT:-8793}"
PUBLIC_HOST="${PUBLIC_HOST:-localhost}"
ANVIL_HOST=127.0.0.1; [ "$PUBLIC_HOST" = localhost ] || ANVIL_HOST=0.0.0.0
export RPC_URL="http://127.0.0.1:$ANVIL_PORT" API_URL="http://$PUBLIC_HOST:$BACKEND_PORT"
export PORTEX_ASSETS_URL="http://$PUBLIC_HOST:$ASSETS_PORT"
BROWSER_RPC_URL="http://$PUBLIC_HOST:$ANVIL_PORT"
CORS_ORIGINS="http://localhost:$FRONTEND_PORT"
[ "$PUBLIC_HOST" = localhost ] || CORS_ORIGINS="$CORS_ORIGINS,http://$PUBLIC_HOST:$FRONTEND_PORT"
for command in anvil forge bun; do command -v "$command" >/dev/null || { echo "Missing $command" >&2; exit 1; }; done
ports=("$ANVIL_PORT" "$ASSETS_PORT")
[ "$WITH_BACKEND" = 0 ] || ports+=("$BACKEND_PORT")
[ "$WITH_FRONTEND" = 0 ] || ports+=("$FRONTEND_PORT")
for port in "${ports[@]}"; do
  if (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null; then echo "Port $port is occupied; stop its owner before starting a fresh demo" >&2; exit 1; fi
done
mkdir -p "$ROOT/tools/artifacts"
RUN_DIR="$(mktemp -d "$ROOT/tools/artifacts/dev-XXXXXX")"
export DEPLOY_WORKSPACE="$RUN_DIR/contracts" PORTEX_RESULTS_DIR="$RUN_DIR"
export PORTEX_DEPLOYMENTS_DIR="$DEPLOY_WORKSPACE/deployments"
PIDS=()
cleanup() { result=$?; for pid in "${PIDS[@]}"; do kill "$pid" 2>/dev/null || true; done; return "$result"; }
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
CHAIN_START="$(date +%s)"
[ "$RUN_SEED" = 0 ] || CHAIN_START="$(( CHAIN_START - 103 * 86400 ))"
anvil --host "$ANVIL_HOST" --port "$ANVIL_PORT" --chain-id 31337 --timestamp "$CHAIN_START" --silent > "$RUN_DIR/anvil.log" 2>&1 &
PIDS+=($!)
for _ in $(seq 1 100); do
  if curl -sf -H 'content-type: application/json' --data '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' "$RPC_URL" >/dev/null; then break; fi
  sleep .1
done
if [ "$WITH_V1" = 1 ]; then
  bash "$ROOT/tools/deploy-demo.sh" --with-v1 > "$RUN_DIR/deploy.log" 2>&1
else
  bash "$ROOT/tools/deploy-demo.sh" > "$RUN_DIR/deploy.log" 2>&1
fi
ASSETS_PORT="$ASSETS_PORT" ASSETS_HOST="$ANVIL_HOST" bun --no-env-file "$ROOT/tools/src/demo-assets.ts" > "$RUN_DIR/assets.log" 2>&1 &
PIDS+=($!)
if [ "$WITH_BACKEND" = 1 ]; then
  (cd "$ROOT/apps/api" && exec env PORT="$BACKEND_PORT" DATABASE_PATH="$RUN_DIR/backend.db" PUBLIC_API_URL="$API_URL" CORS_ORIGINS="$CORS_ORIGINS" \
    POLL_MS=100 PORTEX_CHAIN_ID=31337 CONFIRMATIONS=0 ANTHROPIC_API_KEY= ANALYST_INTERVAL_MS=0 ADMIN_ADDRESSES=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266 \
    bun --no-env-file src/server-v2.ts) > "$RUN_DIR/backend.log" 2>&1 &
  PIDS+=($!)
fi
if [ "$WITH_FRONTEND" = 1 ]; then
  (cd "$ROOT/apps/web" && exec env PORT="$FRONTEND_PORT" PORTEX_BUILD_DIR="${PORTEX_BUILD_DIR:-.next-local-$FRONTEND_PORT}" NEXT_PUBLIC_CHAIN_ID=31337 NEXT_PUBLIC_API_URL="$API_URL" NEXT_PUBLIC_RPC_LOCAL="$BROWSER_RPC_URL" PORTEX_DEV_ORIGINS="$PUBLIC_HOST" bun --no-env-file run dev) > "$RUN_DIR/frontend.log" 2>&1 &
  PIDS+=($!)
fi
if [ "$RUN_SEED" = 1 ]; then
  healthy=0
  for _ in $(seq 1 100); do
    if curl -sf "$API_URL/v2/health" | grep -q '"ok":true'; then healthy=1; break; fi
    sleep .2
  done
  [ "$healthy" = 1 ] || { cat "$RUN_DIR/backend.log"; exit 1; }
  if [ "$SEED_V1" = 1 ]; then
    (cd "$ROOT/tools" && bun --no-env-file run seed --seed-v1) 2>&1 | tee "$RUN_DIR/seed.log"
  else
    (cd "$ROOT/tools" && bun --no-env-file run seed) 2>&1 | tee "$RUN_DIR/seed.log"
  fi
fi
echo "[dev] ready in ${SECONDS}s; logs and seed table: $RUN_DIR"
echo "[dev] v2: $API_URL/v2/health · $API_URL/v2/config · $API_URL/v2/raises"
[ "$WITH_FRONTEND" = 0 ] || echo "[dev] demo: http://$PUBLIC_HOST:$FRONTEND_PORT"
echo "[dev] monograms: $PORTEX_ASSETS_URL"
echo '[dev] Ctrl-C stops only the processes started by this session.'
wait
