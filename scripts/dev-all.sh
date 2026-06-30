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

# dev 模式：自动导入 config.import.local.jsonc（首次启动）
if [ -f config.import.local.jsonc ]; then
  echo "Importing dev config..."
  ADMIN_TOKEN=$(
    curl -s -X POST "http://localhost:${CP_PORT}/auth/login" \
      -H "Content-Type: application/json" \
      -d '{"email":"admin@xihe.local","password":"admin123"}' \
    | python3 -c "import sys,json; print(json.load(sys.stdin).get('accessToken',''))"
  )
  if [ -n "$ADMIN_TOKEN" ]; then
    RESULT=$(
      curl -s -X POST "http://localhost:${CP_PORT}/config/import" \
        -H "Authorization: Bearer $ADMIN_TOKEN" \
        -H "Content-Type: application/json" \
        --data-binary @config.import.local.jsonc
    )
    echo "Config import: $RESULT"
  else
    echo "Config import skipped (auth failed)"
  fi
fi

cd packages/ui && pnpm --ignore-workspace run dev
