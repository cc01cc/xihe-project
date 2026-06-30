#!/usr/bin/env bash
set -euo pipefail
PROJECT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$PROJECT_DIR"

echo "=== Starting Docker stack for T3 ==="
docker compose up -d --build postgres control-plane agent runtime 2>&1

CP_PORT="${XIHE_CP_PORT:-12631}"
echo "Waiting for CP..."
for i in $(seq 1 30); do
  curl -s "http://localhost:${CP_PORT}/actuator/health" >/dev/null 2>&1 && echo "CP ready" && break
  sleep 2
done

echo "=== Agent T3 real integration tests ==="
CP_URL="http://localhost:${CP_PORT}" uv run pytest packages/agent/tests/integration/test_cp_real_integration.py -v
rc1=$?

echo "=== Runtime T3 real integration tests ==="
XIHE_CP_PORT="${CP_PORT}" cargo test --test cp_real_integration_test --manifest-path packages/runtime/Cargo.toml -- --ignored 2>&1 | tail -10
rc2=$?

docker compose down
exit $((rc1 | rc2))
