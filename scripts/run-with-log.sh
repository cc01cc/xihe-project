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

resolve_env_path() {
    local env_path=$1
    if [[ "$env_path" == /* ]]; then
        printf '%s\n' "$env_path"
    else
        printf '%s\n' "$project_root/$env_path"
    fi
}

load_env_file() {
    local env_file=$1
    if [[ -f "$env_file" ]]; then
        set -a
        # shellcheck disable=SC1090
        source "$env_file"
        set +a
    fi
}

if [[ "${XIHE_LOAD_DOTENV:-1}" == "1" ]]; then
    if [[ -n "${XIHE_ENV_FILE:-}" ]]; then
        load_env_file "$(resolve_env_path "$XIHE_ENV_FILE")"
    else
        env_profile=${XIHE_ENV:-}
        load_env_file "$project_root/.env"
        if [[ -n "$env_profile" ]]; then
            load_env_file "$project_root/.env.$env_profile"
        fi
        load_env_file "$project_root/.env.local"
        if [[ -n "$env_profile" ]]; then
            load_env_file "$project_root/.env.$env_profile.local"
        fi
    fi
fi

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