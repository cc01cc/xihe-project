#!/usr/bin/env bash
set -euo pipefail

# Run Agent integration tests with automatic Docker Compose lifecycle.
# Starts CP + PostgreSQL + Agent + Runtime, runs tests, then tears down.

COMPOSE_FILE="${1:-docker-compose.yml}"
TEST_PATH="${2:-packages/agent/tests/test_agent_cp_integration.py}"

cleanup() {
  echo ""
  echo "=== Cleaning up Docker Compose ==="
  docker compose -f "$COMPOSE_FILE" down --remove-orphans 2>/dev/null || true
}
trap cleanup EXIT

echo "=== Starting xihe stack ==="
docker compose -f "$COMPOSE_FILE" up -d --build postgres control-plane agent runtime

echo "=== Waiting for CP to be ready ==="
for i in $(seq 1 30); do
  if curl -sf http://localhost:8080/actuator/health >/dev/null 2>&1; then
    echo "CP ready (attempt $i)"
    break
  fi
  if [ "$i" -eq 30 ]; then
    echo "ERROR: CP failed to start within 30 attempts"
    exit 1
  fi
  sleep 2
done

echo "=== Running integration tests ==="
cd "$(dirname "$0")/.."
cd packages/agent && uv run pytest "$TEST_PATH" -v
