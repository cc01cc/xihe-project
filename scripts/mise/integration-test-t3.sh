#!/usr/bin/env bash
# PLAN-0410 T3.3: CP-Agent-PostgreSQL real-process suite.
# Teardown is mandatory on PASS / FAIL / interruption: the EXIT/INT/TERM trap
# always runs `docker compose down`, so a failed pytest or a Ctrl+C can no
# longer leave the partial stack running (previously `set -e` exited before
# the unconditional `docker compose down` at the bottom of the script).
# Toolchain resolution: the task shell does not always carry the mise tool
# PATH (observed 2026-09-25: `uv`/`cargo: command not found` inside the
# runner), so uv/cargo fall back to `mise x -- <tool>` and the preflight
# prints where each tool resolved from.
set -uo pipefail
PROJECT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$PROJECT_DIR"
T3_TOTAL_START=$(date +%s)

CP_PORT="${XIHE_CP_PORT:-12631}"
AGENT_PORT="${XIHE_AGENT_PORT:-12632}"
SERVICE_TOKEN="${XIHE_CP_API_TOKEN:-dev-token-not-secure}"
export XIHE_CP_PORT="${CP_PORT}"
export XIHE_AGENT_PORT="${AGENT_PORT}"
export XIHE_CP_API_TOKEN="${SERVICE_TOKEN}"

cleanup() {
  local rc=$?
  trap - EXIT INT TERM
  echo "=== Teardown (exit=${rc}, total $(( $(date +%s) - T3_TOTAL_START ))s) — stopping compose stack ==="
  docker compose down --remove-orphans || echo "teardown: docker compose down reported errors"
  exit "${rc}"
}
trap cleanup EXIT INT TERM

tool_or_mise() {
  # $1 = tool name; prints either the bare tool or the mise delegation prefix.
  if command -v "$1" >/dev/null 2>&1; then
    command -v "$1"
  else
    echo "MISSING (delegate: mise x -- $1)"
  fi
}

echo "=== Tool preflight ==="
echo "uv:   $(tool_or_mise uv)"
echo "cargo: $(tool_or_mise cargo)"

run_with_uv() {
  if command -v uv >/dev/null 2>&1; then
    uv "$@"
  else
    echo "+ mise x -- uv $*" >&2
    mise x -- uv "$@"
  fi
}

run_with_cargo() {
  if command -v cargo >/dev/null 2>&1; then
    cargo "$@"
  else
    echo "+ mise x -- cargo $*" >&2
    mise x -- cargo "$@"
  fi
}

echo "=== Starting Docker stack for T3 ==="
docker compose up -d --build postgres control-plane agent runtime || exit 1

echo "Waiting for CP on :${CP_PORT} (max 120s)..."
cp_ready=0
for _ in $(seq 1 60); do
  if curl -sf "http://localhost:${CP_PORT}/actuator/health" >/dev/null 2>&1; then
    cp_ready=1
    echo "CP ready"
    break
  fi
  sleep 2
done
if [ "${cp_ready}" -ne 1 ]; then
  echo "ERROR: CP readiness probe timed out after 120s" >&2
  exit 1
fi

echo "Waiting for Agent on :${AGENT_PORT} (max 120s)..."
agent_ready=0
for _ in $(seq 1 60); do
  if curl -sf "http://localhost:${AGENT_PORT}/internal/v1/agent/health" >/dev/null 2>&1; then
    agent_ready=1
    echo "Agent ready"
    break
  fi
  sleep 2
done
if [ "${agent_ready}" -ne 1 ]; then
  echo "ERROR: Agent readiness probe timed out after 120s" >&2
  exit 1
fi

rc=0
T3_START=$(date +%s)

echo "=== Agent T3 real integration tests (branch context API + LLM input) ==="
(
  cd packages/agent &&
  run_with_uv run pytest tests/integration/test_cp_real_integration.py -v
) || rc=1

echo "=== Runtime T3 real integration tests ==="
run_with_cargo test --test cp_real_integration_test --manifest-path packages/runtime/Cargo.toml -- --ignored || rc=1

echo "=== T3 result: rc=${rc} elapsed=$(( $(date +%s) - T3_START ))s (tests only, stack excluded) ==="
exit "${rc}"
