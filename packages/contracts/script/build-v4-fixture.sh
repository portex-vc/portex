#!/usr/bin/env bash
set +x
set -euo pipefail
PORTEX_CONTRACTS_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
PORTEX_CORE_DIR="${PORTEX_CONTRACTS_DIR}/lib/v4-core"
if [[ "$(git -C "$PORTEX_CORE_DIR" rev-parse HEAD)" != e50237c43811bd9b526eff40f26772152a42daba ]]; then
  echo 'Refusing fixture generation: v4-core must be pinned to v4.0.0.' >&2
  exit 1
fi
# Foundry startup must not discover a repository dotenv file.
cd /tmp
forge build --root "$PORTEX_CORE_DIR" --profile default --use 0.8.26 --evm-version cancun --via-ir --optimizer-runs 44444444 --skip test --skip script
python3 - "$PORTEX_CONTRACTS_DIR" <<'PY'
import hashlib
import json
import sys
from pathlib import Path
root = Path(sys.argv[1])
artifact = json.loads((root / 'lib/v4-core/out/PoolManager.sol/PoolManager.json').read_text())
settings = artifact['metadata']['settings']
assert artifact['metadata']['compiler']['version'] == '0.8.26+commit.8a97fa7a'
assert settings['optimizer'] == {'enabled': True, 'runs': 44444444}
assert settings['viaIR'] and settings['evmVersion'] == 'cancun'
assert settings['metadata'] == {'bytecodeHash': 'none'}
assert not artifact['bytecode']['linkReferences']
code = artifact['bytecode']['object'].removeprefix('0x')
expected = '416d955e1da0680180668fc29b98eea6d0b3ec216aab3bfefb9f1f8d07820b8e'
assert hashlib.sha256(bytes.fromhex(code)).hexdigest() == expected, 'PoolManager bytecode changed; review before replacing the fixture' 
source = '''// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

/// @notice Generated, unmodified PoolManager creation code from Uniswap/v4-core v4.0.0.
/// @dev Commit e50237c43811bd9b526eff40f26772152a42daba, solc 0.8.26, upstream default profile.
///      Embedded because PoolManager pins 0.8.26 while Portex pins 0.8.28. See README for reproduction.
library PoolManagerBytecode {
    function creationCode() internal pure returns (bytes memory) {
        return hex"''' + code + '''";
    }
}
'''
(root / 'test/v31/venue/PoolManagerBytecode.sol').write_text(source)
print('PoolManager creation bytecode SHA-256: ' + hashlib.sha256(bytes.fromhex(code)).hexdigest())
PY
