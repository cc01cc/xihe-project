#!/bin/bash
# Xihe 全栈验证脚本
# 用途：一键验证 UI → CP → Agent → Provider 链路
# 使用：bash scripts/verify-stack.sh

set -euo pipefail

STACK_ID="${XIHE_STACK_ID:-stack-1}"
UI_PORT="${XIHE_UI_PORT:-12630}"
CP_PORT="${XIHE_CP_PORT:-12631}"
AGENT_PORT="${XIHE_AGENT_PORT:-12632}"
RUNTIME_PORT="${XIHE_RUNTIME_PORT:-12633}"
PG_PORT="${XIHE_PG_PORT:-12634}"

echo "=== Xihe 全栈验证 (stack=$STACK_ID) ==="
echo "ports: ui=$UI_PORT cp=$CP_PORT agent=$AGENT_PORT runtime=$RUNTIME_PORT pg=$PG_PORT"
echo ""

# 1. 检查服务状态（按 xihe.stack-id 标签过滤，避免跨栈误匹配；无标签视为 stack-1）
echo "--- 1. 服务状态 ---"
docker ps -a --format '{{.Names}}\t{{.Status}}\t{{.Label "xihe.stack-id"}}' |
  awk -F'\t' -v stack="$STACK_ID" '($3 == "" ? "stack-1" : $3) == stack && $1 ~ /^xihe/ { print }' ||
  echo "❌ 无 xihe 容器运行"
echo ""

# 2. 获取 token
echo "--- 2. 认证 ---"
TOKEN=$(curl -s -X POST "http://localhost:${CP_PORT}/auth/login" \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@xihe.local","password":"admin123"}' | \
  python3 -c "import sys,json; print(json.load(sys.stdin).get('accessToken',''))" 2>/dev/null)

if [ -z "$TOKEN" ]; then
  echo "❌ 认证失败"
  exit 1
fi
echo "✅ Token 获取成功"
echo ""

# 3. SSE 连接
echo "--- 3. SSE 连接 ---"
SSE_RESULT=$(curl -s "http://localhost:${CP_PORT}/events?session_id=verify&token=$TOKEN" \
  -H "Accept: text/event-stream" --max-time 3 2>&1 || true)
if echo "$SSE_RESULT" | grep -q "connected"; then
  echo "✅ SSE 连接成功"
else
  echo "❌ SSE 连接失败: $SSE_RESULT"
fi
echo ""

# 4. 模型列表
echo "--- 4. 模型列表 ---"
MODELS=$(curl -s "http://localhost:${CP_PORT}/models" -H "Authorization: Bearer $TOKEN" 2>&1)
if echo "$MODELS" | python3 -c "import sys,json; d=json.load(sys.stdin); print('✅ 模型:', list(d.get('models',{}).keys()))" 2>/dev/null; then
  :
else
  echo "❌ 模型列表获取失败: $MODELS"
fi
echo ""

# 5. 发送消息
echo "--- 5. 发送消息 ---"
EXEC_RESULT=$(curl -s -X POST "http://localhost:${CP_PORT}/exec" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"session_id":"verify","content":"hello","stream":true}' 2>&1)
if echo "$EXEC_RESULT" | grep -q "accepted"; then
  echo "✅ 消息发送成功"
else
  echo "❌ 消息发送失败: $EXEC_RESULT"
fi
echo ""

# 6. Agent 日志检查
echo "--- 6. Agent 日志（最近 5 行） ---"
docker compose logs --no-color --tail=5 agent
echo ""

echo "=== 验证完成 ==="
