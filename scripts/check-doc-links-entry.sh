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
#
# task-256: the checker now scans every language tree under docs/i18n (it used to
# scan zh-Hans only, which let five dead links sit in the en tree). A03 passes its
# false-positive allowlist when present: config/doc-link-allowlist.json. The
# allowlist only suppresses already-reported findings and must carry a reason.
set -euo pipefail

COMMON_DIR="$(git rev-parse --path-format=absolute --git-common-dir)"
ONE_ROOT="$(cd "$(dirname "$COMMON_DIR")/.." && pwd)"
TARGET="$ONE_ROOT/scripts/check-doc-links.sh"

if [[ ! -f "$TARGET" ]]; then
  echo "check-doc-links: skipped — the workspace doc-link checker is not present at $TARGET." >&2
  echo "check-doc-links: this gate belongs to the ONE workspace; A03 runs standalone without it." >&2
  exit 0
fi

PROJECT_DIR="${1:-.}"

# task-256: the multi-language interface (--project-dir/--allow) only exists after the
# ONE-side patch lands. Detect it instead of assuming, so this entry stays correct when
# it is merged before the ONE checkout is updated (degraded: zh-Hans only, as before).
if grep -q -- '--langs' "$TARGET" 2>/dev/null; then
  ALLOW_ARGS=()
  ALLOW_FILE="$PROJECT_DIR/config/doc-link-allowlist.json"
  if [[ -f "$ALLOW_FILE" ]]; then
    ALLOW_ARGS=(--allow "$ALLOW_FILE")
  fi
  exec bash "$TARGET" --project-dir "$PROJECT_DIR" ${ALLOW_ARGS[@]+"${ALLOW_ARGS[@]}"}
fi

exec bash "$TARGET" "$PROJECT_DIR"
