#!/usr/bin/env bash
# xihe dev:all — 启动全部服务 + 自动导入 dev 配置
set -euo pipefail

CP_PORT="${XIHE_CP_PORT:-12631}"

cleanup() { docker compose down; }
trap cleanup EXIT

docker compose up --build -d

echo "Waiting for CP to be ready..."
for i in $(seq 1 60); do
  curl -s "http://localhost:${CP_PORT}/actuator/health" >/dev/null 2>&1 && echo "CP ready" && break
  echo "waiting $i/60..."
  sleep 2
done

# dev 模式：自动导入 config.import.local.jsonc
# 默认不自动导入（DataSeeder 为 admin@xihe.local 生成随机密码且不落日志，无法在脚本内登录）。
# 启动后请执行 `mise run reset-admin` 获取密码，再手动 POST /api/v1/config/import。
# 可选：设置 XIHE_DEV_ADMIN_PASSWORD（仅经 OS 环境变量注入，禁止写入脚本/git/日志）显式启用自动导入。
if [ -f config.import.local.jsonc ]; then
  if [ -n "${XIHE_DEV_ADMIN_PASSWORD:-}" ]; then
    echo "Importing dev config (XIHE_DEV_ADMIN_PASSWORD set)..."
    ADMIN_TOKEN=$(
      curl -sS -X POST "http://localhost:${CP_PORT}/api/v1/auth/login" \
        -H "Content-Type: application/json" \
        -d "{\"email\":\"admin@xihe.local\",\"password\":\"${XIHE_DEV_ADMIN_PASSWORD}\"}" \
      | python3 -c "import sys,json; print(json.load(sys.stdin).get('accessToken',''))"
    )
    if [ -n "$ADMIN_TOKEN" ]; then
      RESULT=$(
        curl -sS -X POST "http://localhost:${CP_PORT}/api/v1/config/import" \
          -H "Authorization: Bearer $ADMIN_TOKEN" \
          -H "Content-Type: application/json" \
          --data-binary @config.import.local.jsonc
      )
      echo "Config import: $RESULT"
    else
      echo "Config import skipped (auth failed; check XIHE_DEV_ADMIN_PASSWORD)"
    fi
  else
    echo "Config import skipped: XIHE_DEV_ADMIN_PASSWORD not set."
    echo "Run 'mise run reset-admin' to obtain the dev admin password, then import manually via POST /api/v1/config/import."
  fi
fi

cd packages/ui && pnpm --ignore-workspace run dev
