#!/bin/bash
# Xihe host 栈验证脚本（v1 API，栈感知）
#
# 用途：验证「CP 公开 API → Agent」链路是否可用，并给出可直接照抄的原因码。
# 用法：
#   XIHE_VERIFY_PASSWORD=... bash scripts/verify-stack.sh
#   XIHE_STACK_ID=stack-2 XIHE_VERIFY_PASSWORD=... bash scripts/verify-stack.sh
#
# 凭据（脚本内无任何字面密码）：
#   XIHE_VERIFY_EMAIL     默认 admin@xihe.local
#   XIHE_VERIFY_PASSWORD  必填；可用 `pwsh scripts/reset-admin.ps1` 生成，
#                         或注入 dev 栈的 XIHE_DEV_ADMIN_PASSWORD
#                         注意 reset-admin 默认连 `xihe` 库，stack 化后需同时给
#                         XIHE_CP_DATASOURCE_URL=jdbc:postgresql://localhost:<pg>/<db>
#   XIHE_VERIFY_AGENT_PRINCIPAL_ID  可选；不传时用该账号 workspace 已绑定的第一个
#                         agent principal，仍无则自动建一个（并绑定空 cap）
#
# 退出码：
#   0  A 档与 B 档均通过
#   4  A 档通过，B 档前置未满足（预期不可用，末行打印原因码）
#   1  A 档失败，或 B 档意外错误
#   2  缺凭据 / 派生失败
#
# 说明：端口与路径一律取自 `stack-run.mjs env-json`（端口 SSOT 在 Node 侧，
# bash 无法 import ESM）；只设 XIHE_STACK_ID 不会改变端口，必须经由该桥接。

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STACK_ID="${XIHE_STACK_ID:-stack-1}"
EMAIL="${XIHE_VERIFY_EMAIL:-admin@xihe.local}"
PASSWORD="${XIHE_VERIFY_PASSWORD:-${XIHE_DEV_ADMIN_PASSWORD:-}}"

if [ -z "$PASSWORD" ]; then
  echo "ERROR 缺少 XIHE_VERIFY_PASSWORD"
  echo "      dev 栈：pwsh scripts/reset-admin.ps1 生成后注入同名变量重跑"
  exit 2
fi

DERIVED="$(node "$ROOT/scripts/stack-run.mjs" env-json --stack "$STACK_ID" 2>/dev/null)" || {
  echo "ERROR 无法从 stack-run 派生 stack=${STACK_ID} 的环境（非法或未登记栈？）"
  exit 2
}

eval "$(printf '%s' "$DERIVED" | node -e '
const d = JSON.parse(require("fs").readFileSync(0, "utf8"));
const e = d.env || {};
const pick = (k, dflt) => (e[k] === undefined ? dflt : e[k]);
const emit = (name, value) => console.log(name + "=" + JSON.stringify(value));
emit("CP_PORT", pick("XIHE_CP_PORT", "12631"));
emit("AGENT_PORT", pick("XIHE_AGENT_PORT", "12632"));
emit("LOG_DIR", pick("XIHE_LOG_DIR", "logs"));
emit("DB_NAME", pick("POSTGRES_DB", "xihe_1"));
')"

CP_BASE="http://localhost:${CP_PORT}"
AGENT_HEALTH="http://127.0.0.1:${AGENT_PORT}/internal/v1/agent/health"
BODY="$(mktemp)"
SSE_OUT="$(mktemp)"
SSE_PID=""
TOKEN=""
cleanup() {
  [ -n "$SSE_PID" ] && kill "$SSE_PID" 2>/dev/null
  rm -f "$BODY" "$SSE_OUT"
}
trap cleanup EXIT

# api <method> <path> [json-body] -> prints HTTP status code, body in $BODY
api() {
  local method="$1" path="$2" payload="${3:-}"
  local args=(-sS -o "$BODY" -w '%{http_code}' -X "$method" "${CP_BASE}${path}")
  [ -n "$payload" ] && args+=(-H 'Content-Type: application/json' -d "$payload")
  [ -n "$TOKEN" ] && args+=(-H "Authorization: Bearer ${TOKEN}")
  curl "${args[@]}" 2>/dev/null || echo "000"
}

# json <dot.path> -> prints a scalar from $BODY ("" when missing)
json() {
  node -e '
    const d = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8") || "{}");
    let v = d;
    for (const k of process.argv[2].split(".")) { if (v == null) break; v = v[k]; }
    process.stdout.write(v == null ? "" : String(v));
  ' "$BODY" "$1" 2>/dev/null
}

fail_a() { echo "RESULT: A=FAIL B=NOT_RUN ($1)"; exit 1; }

echo "=== Xihe 栈验证 (stack=${STACK_ID}) ==="
echo "cp=${CP_BASE} agent=${AGENT_PORT} db=${DB_NAME} log=${LOG_DIR}"
echo ""

# ---------------------------------------------------------------- A 档（必过）
echo "--- A1 CP 健康 ---"
CODE="$(api GET /api/v1/health)"
[ "$CODE" = "200" ] || fail_a "CP /api/v1/health -> ${CODE}"
echo "✅ CP health 200"

echo "--- A2 登录 ---"
CODE="$(api POST /api/v1/auth/login "{\"email\":\"${EMAIL}\",\"password\":\"${PASSWORD}\"}")"
[ "$CODE" = "200" ] || fail_a "login -> ${CODE}（凭据错？或 admin 密码已轮换）"
TOKEN="$(json accessToken)"
[ -n "$TOKEN" ] || fail_a "login 200 但无 accessToken"
echo "✅ 登录成功（token 不回显）"

echo "--- A3 建 Session / 取分支 ---"
# 新建 workspace 默认没有 agent principal，而 create session 要求 agentPrincipalId。
# 解析顺序：显式注入 → 该账号默认 workspace 已绑定的第一个 → 现建一个并绑定。
# 注意：对**已存在**的 principal 调 PUT 绑定会收窄它的 workspace cap，所以只在现建后绑定。
WORKSPACE_ID="$(json workspaceId)"
PRINCIPAL_ID="${XIHE_VERIFY_AGENT_PRINCIPAL_ID:-}"
PROVISIONED=""
if [ -z "$PRINCIPAL_ID" ] && [ -n "$WORKSPACE_ID" ]; then
  CODE="$(api GET "/api/v1/workspaces/${WORKSPACE_ID}/agents")"
  if [ "$CODE" = "200" ]; then
    PRINCIPAL_ID="$(json 0.principalId)"   # 该端点为顶层数组
  fi
fi
if [ -z "$PRINCIPAL_ID" ]; then
  CODE="$(api POST /api/v1/agent-principals '{"name":"verify-stack"}')"
  case "$CODE" in
    200 | 201)
      PRINCIPAL_ID="$(json principalId)"
      PROVISIONED=1
      ;;
    *) echo "  （自动建 agent principal 失败：HTTP ${CODE} code=$(json code) detail=$(json detail)）" ;;
  esac
fi
if [ -n "$PROVISIONED" ] && [ -n "$PRINCIPAL_ID" ] && [ -n "$WORKSPACE_ID" ]; then
  CODE="$(api PUT "/api/v1/workspaces/${WORKSPACE_ID}/agents/${PRINCIPAL_ID}" '{"permissions":[]}')"
  echo "  （新 principal 已绑定 workspace，cap 为空 → 仅够建 session，不足以调工具）HTTP ${CODE}"
fi
if [ -z "$PRINCIPAL_ID" ]; then
  fail_a "workspace ${WORKSPACE_ID:-?} 无 agent principal，且自动创建失败（可传 XIHE_VERIFY_AGENT_PRINCIPAL_ID）"
fi
CODE="$(api POST /api/v1/sessions "{\"title\":\"verify-stack\",\"agentPrincipalId\":\"${PRINCIPAL_ID}\"}")"
SESSION_ID="$(json id)"
[ -z "$SESSION_ID" ] && SESSION_ID="$(json sessionId)"
[ "$CODE" = "200" ] || [ "$CODE" = "201" ] || fail_a "create session -> ${CODE} code=$(json code) detail=$(json detail)"
[ -n "$SESSION_ID" ] || fail_a "create session 无 id"
CODE="$(api GET "/api/v1/sessions/${SESSION_ID}/branches")"
[ "$CODE" = "200" ] || fail_a "branches -> ${CODE}"
BRANCH_ID="$(json items.0.branchId)"
[ -n "$BRANCH_ID" ] || fail_a "branches 为空"
echo "✅ workspace=${WORKSPACE_ID} principal=${PRINCIPAL_ID} session=${SESSION_ID} branch=${BRANCH_ID}"

echo "--- A4 SSE 订阅 ---"
curl -sS -N "${CP_BASE}/api/v1/events?sessionId=${SESSION_ID}" \
  -H "Authorization: Bearer ${TOKEN}" -H 'Accept: text/event-stream' \
  >"$SSE_OUT" 2>/dev/null &
SSE_PID=$!
SSE_OK=""
for _ in $(seq 1 20); do
  if grep -q 'connected' "$SSE_OUT" 2>/dev/null; then SSE_OK=1; break; fi
  sleep 0.5
done
[ -n "$SSE_OK" ] || fail_a "SSE 10s 内未收到 connected 帧"
echo "✅ SSE connected"

echo "--- A5 模型列表 ---"
CODE="$(api GET /api/v1/models)"
[ "$CODE" = "200" ] || fail_a "models -> ${CODE}"
MODEL_COUNT="$(node -e '
  const d = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8") || "{}");
  const m = d.models;
  const n = Array.isArray(m) ? m.length : (m && typeof m === "object" ? Object.keys(m).length : 0);
  process.stdout.write(String(n));
' "$BODY" 2>/dev/null)"
[ "${MODEL_COUNT:-0}" != "0" ] || fail_a "models 为空（provider 未配置？）"
echo "✅ models=${MODEL_COUNT} configRevision=$(json configRevision)"

echo "--- A6 Agent 健康 ---"
AGENT_CODE="$(curl -sS -o "$BODY" -w '%{http_code}' "$AGENT_HEALTH" 2>/dev/null || echo 000)"
[ "$AGENT_CODE" = "200" ] || fail_a "agent health -> ${AGENT_CODE}（端口 ${AGENT_PORT} 上的 Agent 未起？）"
echo "✅ agent status=$(json status) llmReady=$(json llmReady) configRevision=$(json configRevision) mcpInitialized=$(json mcpInitialized)"
echo ""

# ---------------------------------------------------------------- B 档（条件过）
echo "--- B 档 发送消息（需 provider 凭据 + principal 绑定 + LLM ready）---"
CODE="$(api POST /api/v1/chat \
  "{\"sessionId\":\"${SESSION_ID}\",\"branchId\":\"${BRANCH_ID}\",\"content\":\"verify-stack ping\"}")"
B_STATE=""
B_DETAIL=""
case "$CODE" in
  200 | 202)
    RUN_ID="$(json runId)"
    if [ -n "$RUN_ID" ]; then
      B_STATE="PASS"
      B_DETAIL="runId=${RUN_ID}"
    else
      B_STATE="FAIL"
      B_DETAIL="HTTP ${CODE} 但无 runId"
    fi
    ;;
  403 | 409 | 503)
    # 预期不可用：principal 未绑定 / SSE 门 / LLM 未就绪
    B_STATE="NOT_AVAILABLE"
    B_DETAIL="HTTP ${CODE} code=$(json code) detail=$(json detail)"
    ;;
  *)
    B_STATE="FAIL"
    B_DETAIL="HTTP ${CODE} code=$(json code) detail=$(json detail)"
    ;;
esac
echo "B 档 = ${B_STATE}（${B_DETAIL}）"
echo ""

# ---------------------------------------------------------------- 环境快照
echo "--- 容器（按 xihe.stack-id=${STACK_ID} 过滤；无标签视为 stack-1）---"
if command -v docker >/dev/null 2>&1; then
  docker ps -a --format '{{.Names}}\t{{.Status}}\t{{.Label "xihe.stack-id"}}' 2>/dev/null |
    awk -F'\t' -v stack="$STACK_ID" '($3 == "" ? "stack-1" : $3) == stack && ($1 ~ /^xihe/ || $1 ~ /^a03-xihe/ || $1 ~ /^xihe-stack-/) { print "  " $0 }' ||
    echo "  （docker 查询失败）"
else
  echo "  （无 docker，跳过）"
fi
echo ""

echo "--- Agent 日志（最近 5 行，来自 ${LOG_DIR}/agent.log）---"
AGENT_LOG="${ROOT}/${LOG_DIR}/agent.log"
if [ -f "$AGENT_LOG" ]; then
  tail -n 5 "$AGENT_LOG"
else
  echo "  （无 ${AGENT_LOG}；dev:host 下 Agent 为宿主进程，容器日志不适用）"
fi
echo ""

case "$B_STATE" in
  PASS)
    echo "RESULT: A=PASS B=PASS (${B_DETAIL})"
    exit 0
    ;;
  NOT_AVAILABLE)
    echo "RESULT: A=PASS B=NOT_AVAILABLE (${B_DETAIL})"
    exit 4
    ;;
  *)
    echo "RESULT: A=PASS B=FAIL (${B_DETAIL})"
    exit 1
    ;;
esac
