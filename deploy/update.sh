#!/usr/bin/env bash
# Deploy one commit: the workflow streams `git archive` of it on stdin (the only thing its SSH key may run).
# Each commit unpacks into its own release directory; `current` points at the live one; the last five are kept.
set -euo pipefail
ROOT=/opt/portex
RELEASE="$ROOT/releases/$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$RELEASE"
tar -x -C "$RELEASE"
ln -sfn "$RELEASE" "$ROOT/current"
cd "$ROOT/current"
# The activity runner starts only where it has been explicitly enabled (it owns the persona wallets).
if [ -f "$ROOT/mock.enabled" ]; then export COMPOSE_PROFILES=mock; fi
docker compose -f deploy/docker-compose.yml up -d --build --remove-orphans
ls -1dt "$ROOT"/releases/* | tail -n +6 | xargs -r rm -rf
docker image prune -f >/dev/null
docker compose -f deploy/docker-compose.yml ps --format '{{.Service}}: {{.Status}}'
