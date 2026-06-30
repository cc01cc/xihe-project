#!/usr/bin/env bash
# 同步各包根目录 README symlink → docs/i18n/{lang}/
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"

# 根级别 README.md → docs/i18n/zh-Hans/README.md
ln -sf --relative "$ROOT/docs/i18n/zh-Hans/README.md" "$ROOT/README.md"

# 包 README（4 包）
declare -A PKG_MAP=(
  [ui]="ui"
  [control-plane]="control-plane"
  [agent]="agent"
  [runtime]="runtime"
)

for pkg in "${!PKG_MAP[@]}"; do
  dir="$ROOT/packages/$pkg"
  i18n_path="docs/i18n"

  ln -sf --relative "$ROOT/$i18n_path/zh-Hans/packages/$pkg/README.md" "$dir/README.md"

  if [ -f "$ROOT/$i18n_path/en/packages/$pkg/README.md" ]; then
    ln -sf --relative "$ROOT/$i18n_path/en/packages/$pkg/README.md" "$dir/README.en.md"
  elif [ -L "$dir/README.en.md" ]; then
    rm "$dir/README.en.md"
  fi
done
