#!/usr/bin/env bash
# Worktree-safe entry for the workspace doc-link checker (PLAN-0461 residual).
# Resolves one/scripts via the shared git common-dir, so the same invocation
# works from the main checkout and from any linked worktree (where a
# <repo>/../scripts relative path would point at <repo>/.worktrees/scripts and fail).
#
# PLAN-0612: the checker itself lives in the ONE workspace, which A03 no longer
# depends on. When A03 is cloned on its own there is no ONE root, so this gate
# reports an explicit skip instead of failing with a confusing "file not found".
# The skip is non-silent (stderr) and `lint:links` stays usable standalone.
set -euo pipefail

COMMON_DIR="$(git rev-parse --path-format=absolute --git-common-dir)"
ONE_ROOT="$(cd "$(dirname "$COMMON_DIR")/.." && pwd)"
TARGET="$ONE_ROOT/scripts/check-doc-links.sh"

if [[ ! -f "$TARGET" ]]; then
  echo "check-doc-links: skipped — the workspace doc-link checker is not present at $TARGET." >&2
  echo "check-doc-links: this gate belongs to the ONE workspace; A03 runs standalone without it." >&2
  exit 0
fi

exec bash "$TARGET" "$@"
