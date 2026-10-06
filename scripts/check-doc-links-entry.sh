#!/usr/bin/env bash
# Worktree-safe entry for the workspace doc-link checker (PLAN-0461 residual).
# Resolves one/scripts via the shared git common-dir, so the same invocation
# works from the main checkout and from any linked worktree (where the old
# ../scripts relative path pointed at <repo>/.worktrees/scripts and failed).
set -euo pipefail

COMMON_DIR="$(git rev-parse --path-format=absolute --git-common-dir)"
ONE_ROOT="$(cd "$(dirname "$COMMON_DIR")/.." && pwd)"

exec "C:/Progra~1/Git/bin/bash.exe" "$ONE_ROOT/scripts/check-doc-links.sh" "$@"
