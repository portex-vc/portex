#!/usr/bin/env bash
# Alias for the standalone backend test entry point.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/apps/api"
exec bun --no-env-file test
