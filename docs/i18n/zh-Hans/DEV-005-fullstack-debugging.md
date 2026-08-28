# DEV-005: 全栈调试方法论

Xihe 是四模块架构（UI → CP → Agent → Runtime），单看代码无法发现跨层 bug。必须全栈运行验证。

## 调试流程

```bash
# 1. 启动全栈
docker compose up -d && sleep 15

# 2. 验证每个端点
TOKEN=$(curl -s -X POST 'http://localhost:12631/auth/login' \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@xihe.local","password":"admin123"}' | \
  python3 -c "import sys,json; print(json.load(sys.stdin).get('accessToken',''))")

# SSE 连接
curl -s -H "Authorization: Bearer $TOKEN" "http://localhost:12631/api/v1/events?sessionId=test" --max-time 3

# 模型列表
curl -s 'http://localhost:12631/models' -H "Authorization: Bearer $TOKEN"

# 发送消息
curl -s -X POST 'http://localhost:12631/exec' \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"session_id":"test","content":"hi","stream":true}'

# 3. 检查 Agent 日志
docker compose logs --no-color agent 2>&1 | grep -i "error\|model\|deepseek" | tail -10
```

## 常见陷阱

| 陷阱 | 症状 | 排查方法 |
|------|------|---------|
| CP 端点路径不一致 | Vite proxy rewrite 后 404 | 对比 `@GetMapping` 路径 vs Vite proxy rewrite 规则 |
| Docker 网络配置缺失 | CP→Agent 连接拒绝 | 检查 `docker-compose.yml` 环境变量是否完整 |
| JWT 认证方式不匹配 | SSE 401 | 检查 JWT filter 是否支持 query param token |
| 属性名不一致 | 配置读取为空 | 对比 `application.properties` 中的 key 名 vs docker-compose 环境变量名 |
| litellm model 格式 | BadRequestError | litellm 需要 `provider/model` 格式（如 `deepseek/deepseek-v4-flash`） |

## 跨层协议验证清单

修改任何一层时，检查其他层是否兼容：

| 修改层 | 检查项 |
|--------|--------|
| **CP Controller** | Vite proxy rewrite 后路径是否匹配？`@RequestBody` 的 Content-Type 是否与前端请求一致？ |
| **CP JWT Filter** | SSE 端点是否支持 query param token？其他端点是否只接受 header？ |
| **前端 useSSE** | 发送格式（JSON/FormData）是否与 CP `@RequestBody` 匹配？EventSource URL 是否正确？ |
| **Agent ConfigClient** | `get_providers()` 返回的 key 名（`apiKey`/`baseUrl`）是否与 `_rebuild_provider_cache()` 读取的 key 一致？ |
| **Agent LLM** | model 格式是否为 `provider/model`（litellm 要求）？provider 前缀是否正确？ |
| **Docker Compose** | 所有 `XIHE_*` 环境变量是否在 `application.properties` 中有对应的 `${XIHE_*}` 映射？ |

## E2E 验证 (Docker Compose)

```bash
# 构建并启动全栈
docker compose build && docker compose up -d
# 等待 CP 就绪
sleep 15
# 测试 CP 配置 API
ADMIN_TOKEN=$(curl -s -X POST 'http://localhost:${XIHE_CP_PORT:-12631}/auth/login' \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@xihe.local","password":"admin123"}' | \
  python3 -c "import sys,json; print(json.load(sys.stdin).get('accessToken',''))")
# PUT → GET → restart → GET (PG 持久化验证)
curl -s -X PUT 'http://localhost:${XIHE_CP_PORT:-12631}/config/admin/logging' \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' \
  -d '{"logLevel":"DEBUG"}'
curl -s 'http://localhost:${XIHE_CP_PORT:-12631}/config/logging' -H "Authorization: Bearer $ADMIN_TOKEN"
docker compose restart control-plane && sleep 10
curl -s 'http://localhost:${XIHE_CP_PORT:-12631}/config/logging' -H "Authorization: Bearer $ADMIN_TOKEN"
# 清理
docker compose down
```
