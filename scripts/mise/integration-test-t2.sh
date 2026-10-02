#!/usr/bin/env bash
set -euo pipefail
PROJECT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$PROJECT_DIR"

# Toolchain resolution: the mise task shell does not always carry the tool
# PATH (documented in integration-test-t3.sh header; observed again during the
# PLAN-0428 L2 run on 2026-10-02: `uv: command not found` at this line), so
# uv/cargo fall back to `mise x -- <tool>`.
tool_or_mise() {
  if command -v "$1" >/dev/null 2>&1; then
    command -v "$1"
  else
    echo "MISSING (delegate: mise x -- $1)"
  fi
}

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

echo "=== Tool preflight ==="
echo "uv:     $(tool_or_mise uv)"
echo "cargo:  $(tool_or_mise cargo)"

echo "=== CP T2 WireMock tests ==="
cd packages/control-plane && mvn test -Dtest="crossmodule/*" -pl . 2>&1 | tail -5

cd "$PROJECT_DIR"
echo "=== Agent T2 stub tests ==="
cd packages/agent && run_with_uv run pytest tests/integration/test_cp_stub_integration.py -v 2>&1 | tail -10

cd "$PROJECT_DIR"
echo "=== Runtime T2 stub tests ==="
cd packages/runtime && run_with_cargo test --test cp_stub_integration_test 2>&1 | tail -5
