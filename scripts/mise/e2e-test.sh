#!/usr/bin/env bash
set -euo pipefail
PROJECT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$PROJECT_DIR"

docker compose up -d --build
echo "Waiting for stack..."
CP_PORT="${XIHE_CP_PORT:-12631}"
for i in $(seq 1 30); do
  curl -s "http://localhost:${CP_PORT}/actuator/health" >/dev/null 2>&1 && echo "Ready" && break
  sleep 2
done

cd packages/ui
npx playwright test --config e2e/playwright.config.ts
rc=$?

cd "$PROJECT_DIR"
docker compose down
exit $rc
