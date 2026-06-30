#!/usr/bin/env bash
set -euo pipefail
PROJECT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$PROJECT_DIR"

echo "=== CP T2 WireMock tests ==="
cd packages/control-plane && mvn test -Dtest="crossmodule/*" -pl . 2>&1 | tail -5

cd "$PROJECT_DIR"
echo "=== Agent T2 stub tests ==="
cd packages/agent && uv run pytest tests/integration/test_cp_stub_integration.py -v 2>&1 | tail -10

cd "$PROJECT_DIR"
echo "=== Runtime T2 stub tests ==="
cd packages/runtime && cargo test --test cp_stub_integration_test 2>&1 | tail -5
