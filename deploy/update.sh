#!/usr/bin/env bash
# Pull main and rebuild/restart the server stack. The deploy workflow runs this over SSH after CI passes.
set -euo pipefail
cd /opt/portex/repo
git fetch --quiet origin main
git reset --hard --quiet origin/main
docker compose -f deploy/docker-compose.yml up -d --build --remove-orphans
docker image prune -f >/dev/null
docker compose -f deploy/docker-compose.yml ps --format '{{.Service}}: {{.Status}}'
