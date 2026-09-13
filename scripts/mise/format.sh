#!/usr/bin/env bash
set -euo pipefail
PROJECT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$PROJECT_DIR"

echo "[xihe] Formatting UI..."
cd packages/ui && pnpm --ignore-workspace run --if-present format

cd "$PROJECT_DIR"
echo "[xihe] Formatting Agent..."
cd packages/agent && uv run ruff format .

cd "$PROJECT_DIR"
echo "[xihe] Formatting Runtime..."
cd packages/runtime && cargo fmt

echo "[xihe] Format complete."
