#!/usr/bin/env bash

set -euo pipefail

if [[ $# -lt 2 ]]; then
    echo "Usage: $0 <module> <command> [args...]" >&2
    exit 64
fi

module_name=$1
shift

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
project_root=$(cd -- "$script_dir/.." && pwd)

# PLAN-0307 T3.2: env files are loaded by the module-local dotenv loaders
# (.env → .env.$XIHE_ENV → .env.local, plus CLI --set). This wrapper no longer
# sources env files — it keeps process management and logging only.

if [[ "${XIHE_LOG_TO_FILE:-1}" != "1" ]]; then
    exec "$@"
fi

log_dir=${XIHE_LOG_DIR:-logs}
if [[ "$log_dir" != /* ]]; then
    log_dir="$project_root/$log_dir"
fi

mkdir -p "$log_dir"
log_file="$log_dir/$module_name.log"

exit_code=0
if ! {
    printf '[xihe-log] module=%s file=%s started_at=%s\n' \
        "$module_name" \
        "$log_file" \
        "$(date -Is)"
    "$@"
} 2>&1 | tee -a "$log_file"; then
    pipe_status=("${PIPESTATUS[@]}")
    if (( pipe_status[0] != 0 )); then
        exit_code=${pipe_status[0]}
    else
        exit_code=${pipe_status[1]}
    fi
fi

exit "$exit_code"