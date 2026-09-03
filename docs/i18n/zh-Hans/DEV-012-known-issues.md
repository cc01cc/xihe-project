# DEV-012: Known Issues (Supplement)

本文件收录不属于 AGENTS.md 最关键的 5 项的已知问题，供排查时参考。

## 已修复 — Chat SSE 生命周期与真实流式（PLAN-230 已完成 M1-M4）

- **会话 SSE 一次性连接导致连续消息 409**：已修复。原因：CP ChatController 每轮 inally 执行 sseManager.complete(sessionId) 使会话 SSE 变为一次性，且旧 emitter onCompletion 按 sessionId 无条件 emove 可能误删新连接；UI onclose 未重连。修复：CP 改为持久会话 SSE（SseEmitterManager 按 {sessionId, generation, emitter} + compareAndRemove/stale_cleanup_ignored，complete(sessionId) 不在普通 run 末尾调用，仅客户端断开/session 删除/不可写时清理）；UI chatTransport 单飞 + 退避重连 + nsureConnected 一次 409 恢复；SSEStream 每 	oken 整量替换（eplaceStreamingParts）。验证：同一页面连续两条 POST /api/v1/chat 均 202 且助手回复不空；	oken 增量在 done 前多次增长（手工 115 长度样本 + xh-incremental-stream-verified.png）。
- **真实模型流式未生效（stream=False 单 token）**：已修复。XiheLiteLLM 未实现 _astream() 导致 stream_events 仅产生 on_chat_model_end 单包。修复：llm/base.py 实现 streaming=True 异步 hook，sse_adapter 按 un_id 去重使 on_chat_model_end 仅在无 stream 时 fallback；真实 MiMo 长回复多 	oken（ChatIntegration/AgentChatIntegration + 手工 115 长度证据）。
- **日志泄露与关联缺失**：已修复。main.py 前记录消息前缀、ChatController 记录完整 Agent error body、litellm curl debug 的 Authorization: Be****、Spring Using generated security password。修复：litellm.suppress_debug_info=True、log_redact 掩码 Authorization:、pplication.properties 占位密码、scan-log-secrets.mjs 读取失败即失败并扩展 pattern（门禁 clean 20 files）。

## 环境 / Docker

- **WSL2 OOM**: 修改 vitest config 前需 `bash ../../scripts/cleanup-wsl-resources.sh`
- **Container name**: `docker compose up -d` 前先 `docker rm -f xihe-*` 清理残留
- **Native host boundary**: 日常 host 开发只允许 PostgreSQL 运行在 Docker；CP、Agent、Runtime、UI 必须由 mise 作为 Windows 原生任务启动。不要使用不带服务筛选的 `docker compose up -d`，否则会误启动后三个后端容器。
- **Native host startup**: 使用 `mise run dev:host`；该任务先执行 `docker compose up -d --wait postgres`，再并行管理四个原生服务。`mise run dev:host:watch` 由 Node watcher 监督健康端点并在任务组故障后重启。
- **Native host shutdown**: 在运行 `mise run dev:host` 的终端按 Ctrl+C 清理原生任务，再执行 `mise run dev:host:stop` 停止 PostgreSQL。不要依赖残留 PID 或手工猜测进程。
- **Dev data reset**: 使用 `mise run dev:reset` 先查看 dry-run；确认本地数据可丢弃后才使用 `pwsh -File scripts/dev-reset.ps1 -Reset`。该命令会先备份数据库、重建项目卷并将 host workspace 目录送入回收站，不删除 Runtime device identity。
- **Startup latency**: CP/Maven 和 Runtime/Cargo 首次编译可能需要数十秒；端口出现前不应重复启动第二组任务。用 `/actuator/health`、`/internal/v1/agent/health`、`/health` 和 UI 根路径确认就绪。
- **配置生效顺序**: 日常 host 开发推荐优先级为 OS 引导变量 → `.env.dev` → ConfigService / UI Settings。若 Chat 使用的 model/provider 与预期不一致，先用 `scripts/dev-host-check-config.mjs` 或 Agent 启动日志确认来源，不要只改 UI。
- **Playwright 视觉审查规则**: 在推进 UI 截图前必须先完成一轮真实 chat（发送 → assistant 回复 → 截图）；视觉审查不能只看 accessibility snapshot，必须人工复核截图。
- **Agent MCP lazy init**: Agent 启动阶段不会连接 CP MCP；纯 chat 即使带 current workspace 也不触发工具发现，只有明确需要 Workspace tool 的请求才触发 MCP/Sandbox。当前最小边界按单默认 workspace，其他 workspace 不复用已发现的远程工具。
- **RAG embedding 未配置**: `embedding` provider 没有 API key 时，chat 会跳过 RAG enrichment；RAG ingest/search 明确返回 `503`，不会为每条 chat 发送无凭据的 embedding 请求。
- **Runtime host 日志**: Runtime 使用按日滚动文件，路径为 `logs/runtime.log.<YYYY-MM-DD>`；CP/Agent/UI 使用稳定的 `logs/<module>.log`，host watcher 使用 `logs/host.log`。
- **Host E2E data/readiness**: `test:e2e:host` 每轮使用独立 PostgreSQL 和 host root，在 Playwright 前等待 Runtime `/ready`。成功、失败和中断都必须 teardown 并反向确认无本轮用户、Workspace、Session、ExecutionSpec、Sandbox 或文件残留；不得把长期 dev DB 作为 Host E2E 数据源。
- **Screenshot reproducibility**: A03 当前忽略 `*-snapshots/*.png`，本地 baseline 需要预先生成；`toHaveScreenshot()` 通过不等于人工 UI 审查通过，也不等于 fresh checkout 能复现视觉结果。
- **Runtime CWD 测试**: `dotenv_loader` 测试会临时切换 process CWD，测试 helper 已用 mutex 串行化；默认并行 `cargo test --lib` 可稳定运行。

## Code

- **Jackson 3.x fieldNames**: Spring Boot 4.x 使用 Jackson 3.x (`tools.jackson.databind`)。`JsonNode.fieldNames()` 已移除，改为 `JsonNode.propertyNames()`（返回 `Collection<String>` 而非 `Iterator<String>`）
- **JSONB @JdbcTypeCode**: JPA 实体含 `columnDefinition = "jsonb"` 的 String 字段必须加 `@JdbcTypeCode(SqlTypes.JSON)`，否则 PG 报类型不匹配
- **ConfigClient URL 路径**（Agent `config_client.py`、Runtime `config_client.rs`）：CP 内部端点路径为 `/internal/v1/config/{layer}/{domain}`（注意是 `/internal/v1` 前缀，非 `/internal`，亦非 `/api/v1/internal`）。PLAN-049 T3 测试暴露了此 bug——Agent/Runtime ConfigClient 曾误用 `/api/v1/internal/config/...`。新增模块调用时确认路径为 `/internal/v1/config/...`
