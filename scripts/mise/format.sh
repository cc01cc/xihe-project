#!/usr/bin/env bash
set -euo pipefail
PROJECT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$PROJECT_DIR"

echo "[xihe] Formatting UI..."
cd packages/ui && pnpm --ignore-workspace run format 2>/dev/null || echo "  (no format script)"

cd "$PROJECT_DIR"
echo "[xihe] Formatting Agent..."
cd packages/agent && uv run ruff format . 2>/dev/null || echo "  (ruff format skipped)"

cd "$PROJECT_DIR"
echo "[xihe] Formatting Runtime..."
cd packages/runtime && cargo fmt 2>/dev/null || echo "  (cargo fmt skipped)"

echo "[xihe] Format complete."
