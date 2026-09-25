#!/usr/bin/env bash
set +x
set -euo pipefail

# Refuse before invoking Foundry or accessing any project files. Never source a dotenv file.
if [[ -z "${DEPLOYER_PRIVATE_KEY:-}" ]]; then
  echo 'Refusing deployment: DEPLOYER_PRIVATE_KEY must be set in the process environment.' >&2
  exit 1
fi
if [[ $# -gt 1 || ( $# -eq 1 && "$1" != '--broadcast' ) ]]; then
  echo 'Usage: bash tools/deploy-testnet.sh [--broadcast] (default: simulation only)' >&2
  exit 2
fi

if [[ "${PORTEX_CHAIN_ID:-1952}" != '1952' ]]; then
  echo 'Refusing deployment: X Layer testnet chain 1952 required.' >&2
  exit 1
fi
# Governed timings are set through the curator's parameter setter after deployment, never hard-coded in contracts.
export PORTEX_TIMINGS="${PORTEX_TIMINGS:-testnet}"
if [[ "$PORTEX_TIMINGS" != 'testnet' && "$PORTEX_TIMINGS" != 'production' ]]; then
  echo 'Refusing deployment: PORTEX_TIMINGS must be testnet or production.' >&2
  exit 1
fi
if [[ "$PORTEX_TIMINGS" == 'testnet' ]]; then
  echo 'Governed timings: testnet profile (Stage 1 from 10 minutes, Stage 2 from 30 minutes; 10-minute votes).'
fi

PORTEX_CONTRACTS_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../packages/contracts" && pwd)"
export PORTEX_CONTRACTS_DIR
# Alchemy when its key is in the environment, otherwise X Layer's public testnet RPC (or XLAYER_TESTNET_RPC_URL).
if [[ -n "${ALCHEMY_API_KEY:-}" ]]; then
  export FOUNDRY_ETH_RPC_URL="https://xlayer-testnet.g.alchemy.com/v2/${ALCHEMY_API_KEY}"
else
  export FOUNDRY_ETH_RPC_URL="${XLAYER_TESTNET_RPC_URL:-https://testrpc.xlayer.tech}"
fi

# Foundry 1.8 loads .env from its startup cwd/project root even before handling --root.
# Start in a temporary directory outside this repository; --root still selects the actual contracts.
# Redact subprocess output, including error messages which might otherwise expose an RPC URL.
python3 - "$@" <<'PY'
import os
import json
from pathlib import Path
import re
import subprocess
import sys
import tempfile

secrets = [os.environ.get('ALCHEMY_API_KEY', ''), os.environ['DEPLOYER_PRIVATE_KEY']]
if os.environ.get('ALCHEMY_API_KEY'):
    secrets.append(os.environ['FOUNDRY_ETH_RPC_URL'])
key = os.environ['DEPLOYER_PRIVATE_KEY']
try:
    numeric_key = int(key, 16) if key.startswith('0x') else int(key)
    secrets.extend([str(numeric_key), hex(numeric_key), format(numeric_key, '064x')])
except ValueError:
    pass
command = ['forge', 'script', os.environ['PORTEX_CONTRACTS_DIR'] + '/script/DeployXLayerTestnet.s.sol:DeployXLayerTestnet',
           '--root', os.environ['PORTEX_CONTRACTS_DIR'], '--sig', 'run()']
if sys.argv[1:]:
    # One transaction at a time: the package is larger than one block and nonces must stay ordered.
    command.extend(['--broadcast', '--slow'])
print('X Layer testnet: broadcast requested.' if sys.argv[1:] else 'X Layer testnet: simulation only; no transactions will be broadcast.', flush=True)
with tempfile.TemporaryDirectory(prefix='portex-foundry-', dir='/tmp') as startup:
    result = subprocess.run(command, cwd=startup, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    output = result.stdout
    for secret in sorted(set(secrets), key=len, reverse=True):
        if secret:
            output = output.replace(secret, '[REDACTED]')
    output = re.sub(r'https://xlayer-testnet\.g\.alchemy\.com/v2/[^\s"\x27]+', '[REDACTED_RPC]', output)
    sys.stdout.write(output)
    if result.returncode == 0 and sys.argv[1:]:
        root = Path(os.environ['PORTEX_CONTRACTS_DIR'])
        receipt_file = root / 'broadcast/DeployXLayerTestnet.s.sol/1952/run-latest.json'
        manifest = root / 'deployments/1952-v31.json'
        try:
            receipts = json.loads(receipt_file.read_text())['receipts']
            blocks = [int(r['blockNumber'], 16) if isinstance(r['blockNumber'], str) else r['blockNumber'] for r in receipts]
            if not blocks or any(int(str(r['status']), 16) != 1 for r in receipts):
                raise ValueError('missing successful receipts')
            deployment = json.loads((root / 'deployments/1952-v31.pending.json').read_text())
            deployment['deploymentBlock'] = min(blocks)
            deployment['simulated'] = False
            manifest.write_text(json.dumps(deployment, indent=2) + '\n')
            print('Broadcast manifest: packages/contracts/deployments/1952-v31.json (deploymentBlock from receipts).')
        except (OSError, KeyError, ValueError, TypeError):
            print('Deployment receipts could not be verified; do not start the app until the manifest is reconciled.', file=sys.stderr)
            sys.exit(1)
    sys.exit(result.returncode)
PY
