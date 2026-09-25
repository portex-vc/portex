#!/usr/bin/env bash
set +x
set -euo pipefail

# Credentials must come from the process environment; never source dotenv files. Without ALCHEMY_API_KEY the
# backend reads X Layer's public testnet RPC. PUBLIC_HOST=<lan-ip> gives the browser LAN URLs.
if [[ "${PORTEX_CHAIN_ID:-1952}" != '1952' || "${NEXT_PUBLIC_CHAIN_ID:-1952}" != '1952' ]]; then
  echo 'Refusing testnet startup: PORTEX_CHAIN_ID and NEXT_PUBLIC_CHAIN_ID must be 1952.' >&2
  exit 1
fi
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export PORTEX_CHAIN_ID=1952 NEXT_PUBLIC_CHAIN_ID=1952
export PORTEX_DEPLOYMENTS_DIR="${PORTEX_DEPLOYMENTS_DIR:-$ROOT/packages/contracts/deployments}"
export BACKEND_PORT="${BACKEND_PORT:-8790}" FRONTEND_PORT="${FRONTEND_PORT:-3100}"
export PUBLIC_HOST="${PUBLIC_HOST:-localhost}"
export NEXT_PUBLIC_API_URL="${NEXT_PUBLIC_API_URL:-http://$PUBLIC_HOST:$BACKEND_PORT}"
for port in "$BACKEND_PORT" "$FRONTEND_PORT"; do
  if (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null; then
    echo "Port $port is occupied; refusing to stop its owner" >&2
    exit 1
  fi
done
exec python3 - "$ROOT" <<'PY'
import json
import os
import re
import signal
import subprocess
import sys
import threading
import time
from pathlib import Path

root = Path(sys.argv[1])
manifest = Path(os.environ['PORTEX_DEPLOYMENTS_DIR']) / '1952-v31.json'
try:
    deployment = json.loads(manifest.read_text())
    assert deployment['chainId'] == 1952 and deployment.get('simulated') is False
    assert isinstance(deployment['deploymentBlock'], int) and deployment['deploymentBlock'] >= 0
    assert all(re.fullmatch(r'0x[0-9a-fA-F]{40}', deployment[k]) for k in ['factory', 'registry', 'quote'])
except (OSError, ValueError, KeyError, AssertionError, TypeError):
    sys.exit('Refusing testnet startup: a broadcast 1952-v31.json with deploymentBlock is required.')

env = dict(os.environ)
env['NODE_OPTIONS'] = f'--import {root / "apps/web/scripts/no-dotenv.mts"}'
env.setdefault('PORTEX_BUILD_DIR', '.next-testnet')
env['PUBLIC_API_URL'] = env['NEXT_PUBLIC_API_URL']
env['CORS_ORIGINS'] = ','.join(dict.fromkeys([f'http://localhost:{env["FRONTEND_PORT"]}', f'http://{env["PUBLIC_HOST"]}:{env["FRONTEND_PORT"]}']))
env['PORTEX_DEV_ORIGINS'] = env['PUBLIC_HOST']
env.setdefault('DATABASE_PATH', str(root / 'apps/api/data/portex-1952.db'))
# X Layer's public testnet RPC answers eth_getLogs for at most 100 blocks per call.
if not env.get('ALCHEMY_API_KEY') and not env.get('RPC_URL'):
    env.setdefault('LOG_PAGE', '100')
    # Its load-balanced nodes can briefly disagree on the newest block; index a few blocks behind the head.
    env.setdefault('CONFIRMATIONS', '3')
# Automated analysis is opt-in; deployment signing material is never needed by the app.
env.setdefault('ANALYST_INTERVAL_MS', '0')
env.pop('DEPLOYER_PRIVATE_KEY', None)
secrets = [v for k, v in os.environ.items() if v and ('KEY' in k or 'SECRET' in k or k == 'RPC_URL')]
children = []
threads = []

def output(child, label):
    for line in child.stdout:
        for value in sorted(secrets, key=len, reverse=True):
            line = line.replace(value, '[REDACTED]')
        line = re.sub(r'https?://[^\s]+\.g\.alchemy\.com/v2/[^\s]+', '[REDACTED_RPC]', line)
        print(f'[{label}] {line}', end='', flush=True)

def stop(signum, frame):
    raise KeyboardInterrupt

signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)
result = 0
try:
    for label, port in [('backend', env['BACKEND_PORT']), ('frontend', env['FRONTEND_PORT'])]:
        command = ['bun', '--no-env-file', 'run', 'start' if label == 'backend' else 'dev']
        if label == 'frontend' and env.get('PORTEX_WEB_MODE') == 'prod':
            # A production build serves in a few hundred MB, where `next dev` grows to several GB.
            command = ['bash', '-c', 'bun --no-env-file run sync-abi && PORTEX_BUILD_DIR=.next-build'
                       ' NODE_OPTIONS="--import ./scripts/no-dotenv.mts --max-old-space-size=1536" ./node_modules/.bin/next build'
                       ' && exec bun --no-env-file run start']
        child = subprocess.Popen(command, cwd=root / ('apps/api' if label == 'backend' else 'apps/web'), env={**env, 'PORT': port},
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, start_new_session=True)
        children.append(child)
        thread = threading.Thread(target=output, args=(child, label), daemon=True)
        thread.start()
        threads.append(thread)
    print(f'X Layer testnet (1952): backend :{env["BACKEND_PORT"]}, frontend :{env["FRONTEND_PORT"]}; deployment block {deployment["deploymentBlock"]}.', flush=True)
    while all(child.poll() is None for child in children):
        time.sleep(0.2)
    result = next((child.returncode or 0 for child in children if child.poll() is not None), 0)
except KeyboardInterrupt:
    pass
finally:
    for child in children:
        try:
            os.killpg(child.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
    for child in children:
        try:
            child.wait(timeout=10)
        except subprocess.TimeoutExpired:
            os.killpg(child.pid, signal.SIGKILL)
            child.wait()
    for thread in threads:
        thread.join(timeout=1)
sys.exit(result)
PY
