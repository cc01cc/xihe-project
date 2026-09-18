---
title: DEV-018 - Known Issues 补充
category: dev-guide
lang: zh-Hans
sidebar_group: "开发指南"
sidebar_order: 18
status: active
created: 2026-09-02
updated: 2026-09-06
---

# DEV-018: Known Issues (Supplement)

> 面向排障：AGENTS.md 放最关键项，这里收录其余已知问题（环境/Code 两节）。已修复项保留根因供回溯。

本文件收录 AGENTS.md 之外的已知问题，供排查时参考。

## 全量 host E2E 基线口径（PLAN-0365，2026-09-18）

- **入口必须走 `node scripts/e2e-host.mjs [--llm-mode=<mode>] <spec>`**：手动 `npx playwright test` 不注入 baseURL/fake 端口会产生假失败（ERR_CONNECTION_REFUSED / invalid URL）。
- **Agent 单 workspace MCP 绑定（PLAN-262）**：Agent 进程首个 chat 绑定 workspace 后，其它 workspace 的 chat 将 fail（`MCP workspace context cannot be reused across workspaces`）。全量串行 host E2E 中跨 workspace 的 write_file 审批类 spec（checkpoint-rollback S1、checkpoint-slices S1、journey-a、journey-c）因此**预期失败**；单 spec 复跑（Agent 首绑=本 spec workspace）为验证口径。根治归 PLAN-0348 rebind。
- llm-mode 是 boot 期属性：external 复用栈时 0365 已补 fixture 启动 + provider 重导入，但**最可靠做法仍是以目标 mode boot**。
- 视觉基线（toHaveScreenshot）在 UI 结构变更后须重置，重置前先确认 DOM 断言全过。

## PLAN-0345 工作区生命周期 — 行为变化与已知限制（2026-09-18）

- **`destroying` 409 窗口**：destroy 进行中的 workspace，materialize/ensure 立即 409 `WORKSPACE_DESTROYING`；窗口结束（完成注销）后按 404 处理，再次 ensure = 新建。CP 原样透传该 409（不再 collapse 502）。
- **paused 恢复语义**：`unpause` 失败 fail-closed（`failed` + reason），无 recreate fallback；paused 容器若被外部 `docker kill`，ensure 探测后走正常 reconcile。
- **reaper 只剩 3 档**（15m pause / 2h stop / 24h 注销）；`Suspended/Released` 不再写入 instances，statuses 保留 `released` 字面仅供 UI「已释放」文案推导。
- **lease 为进程内存**：Runtime 重启后 lease 全清，依赖 Docker `rebuild` 接管（无跨进程双主防护，单 Runtime v1 场景可接受）。
- **REST read/list/stat 已走容器 exec**：无 Docker 或容器未启动时这些端点 fail-closed 503（与变更类一致）；binary write 仍 host 直写（JSON 帧 UTF-8 限制，债）。

## PLAN-0342 诊断回灌 — 已知限制（2026-09-17）

- **历史消息不持久化 toolCalls**：刷新后工具卡不显示，诊断仅本 run 可见（`message.toolCalls` 只在 run 内写入）。
- **去重账本为进程内存**：`DiagnosticsLedger` 重启即清空，仅影响去重噪音（可能重复回灌一次），不影响诊断正确性。
- **Ledger 失败判定**：非零 `exit_code` 的命令结果在 Operation Ledger 仍记 `succeeded`，诊断不参与工具失败判定（失败语义只体现在诊断回灌）。

## PLAN-0341 上下文管道与 prune — 状态（2026-09-17）

- **已接线**：`CONTEXT_OVERFLOW` relay 白名单 + 至多一次重跑（force-compact → 预检 → 同 runId）；prune 墓碑；摘要 carry-forward + 熔断；SUM 去双写；U3/U4 toast。
- **Host 证据**：`plans/PLAN-0341-…/evidence/t2.2-*.md`（journey-d D1/D2 + overflow V2）。
- **残项**：全量 `mise run validate`；U4 熔断 host 见 `journey-d-circuit.spec.ts`（与本 PLAN 同批）；LLM 摘要/SC 抽取器归 0354/0355。
- **Host E2E 注意**：本机 Docker 可能仅有 `docker-compose.exe`（e2e-host 已回退）；CP 改 Java 后须 `mvn -o package -DskipTests` 再跑 e2e-host；`/workspace/*` 固定 `toolMode=workspace`，无 Runtime 时 chat 用例走 `/chat/*`。

## PLAN-0340 上下文源注入 — 验收残项（2026-09-17）

- **V14 host/浏览器 U1/U2 截图验收**尚未跑（需 `mise run dev:host` + `e2e-host`）；定向单测已绿。
- **U2** 仅在 `AGENTS.md` 链 `created/updated` 时经 SSE `context_sources_changed` + toast；env（date/HEAD）静默替换符合设计。
- JIT 磁盘内嵌套 `AGENTS.md`：run 级 cwd 恒为 workspace root，基准链退化为根文件；目录标记已接，事件化全量就近账本见 PLAN 边界。

## 已修复 — Chat SSE 生命周期与真实流式（PLAN-230 已完成 M1-M4）

- **会话 SSE 一次性连接导致连续消息 409**：已修复。原因有二：CP 在每轮末尾无条件 `complete(sessionId)` 使会话 SSE 一次性，且旧 emitter `onCompletion` 按 sessionId 清理可能误删新连接；UI 侧 `onclose` 未重连。修复：CP 改持久会话 SSE（`SseEmitterManager` 按 `{sessionId, generation, emitter}` 存储 + `removeIfCurrent` 身份比对，误删记 `stale_cleanup_ignored`；`complete` 仅在客户端断开/session 删除/不可写时调用）；UI `chatTransport` 单飞 + 指数退避重连，`SSEStream` 发送前手工确认连接。验证：同一页面连续两条 `POST /api/v1/chat` 均 202 且助手回复不空；多 `token` 事件在 `done` 前多次增长。
- **真实模型流式未生效（stream=False 单 token）**：已修复。`XiheLiteLLM` 未实现 `_astream()` 导致 `astream_events` 仅产生 `on_chat_model_end` 单包。修复：显式 `streaming=True` 使 `on_chat_model_stream` 产生多 token，`sse_adapter` 按 `run_id` 去重使 `on_chat_model_end` 仅作无流 fallback。
- **日志泄露与关联缺失**：已修复。main.py 前记录消息前缀、ChatController 记录完整 Agent error body、litellm curl debug 的 Authorization: Be****、Spring Using generated security password。修复：litellm.suppress_debug_info=True、log_redact 掩码 Authorization:、pplication.properties 占位密码、scan-log-secrets.mjs 读取失败即失败并扩展 pattern（门禁 clean 20 files）。

## 环境 / Docker

- **WSL2 OOM**: 修改 vitest config 前需 `bash ../../scripts/cleanup-wsl-resources.sh`
- **Container name**: `docker compose up -d` 前先 `docker rm -f xihe-*` 清理残留
- **Native host boundary**: 日常 host 开发只允许 PostgreSQL 运行在 Docker；CP、Agent、Runtime、UI 必须由 mise 作为 Windows 原生任务启动。不要使用不带服务筛选的 `docker compose up -d`，否则会误启动后三个后端容器。
- **Native host startup**: 使用 `mise run dev:host`；该任务先执行 `docker compose up -d --wait postgres`，再并行管理四个原生服务。`mise run dev:host:watch` 由 Node watcher 监督健康端点并在任务组故障后重启。
- **Native host shutdown**: 在运行 `mise run dev:host` 的终端按 Ctrl+C 清理原生任务，再执行 `mise run dev:host:stop` 停止 PostgreSQL。不要依赖残留 PID 或手工猜测进程。
- **Dev data reset**: 使用 `mise run dev:reset` 先查看 dry-run；确认本地数据可丢弃后才使用 `pwsh -File scripts/dev-reset.ps1 -Reset`。该命令会先备份数据库、重建项目卷并将 host workspace 目录送入回收站，不删除 Runtime device identity。
- **Startup latency**: CP/Maven 和 Runtime/Cargo 首次编译可能需要数十秒；端口出现前不应重复启动第二组任务。用 `/actuator/health`、`/internal/v1/agent/health`、`/health` 和 UI 根路径确认就绪。
- **配置生效顺序**: 日常 host 开发推荐优先级为启动环境变量 → `.env.dev` → ConfigService / UI Settings（配置归属速查见 DEV-003 §2）。若 Chat 使用的 model/provider 与预期不一致，先用 `scripts/dev-host-check-config.mjs` 或 Agent 启动日志确认来源，不要只改 UI。
- **Playwright 视觉审查规则**: 在推进 UI 截图前必须先完成一轮真实 chat（发送 → assistant 回复 → 截图）；视觉审查不能只看 accessibility snapshot，必须人工复核截图。
- **Agent MCP lazy init**: Agent 启动阶段不会连接 CP MCP；纯 chat 即使带 current workspace 也不触发工具发现，只有明确需要 Workspace tool 的请求才触发 MCP/Sandbox。当前最小边界按单默认 workspace，其他 workspace 不复用已发现的远程工具。
- **RAG embedding 未配置**: `embedding` provider 没有 API key 时，chat 会跳过 RAG enrichment；RAG ingest/search 明确返回 `503`，不会为每条 chat 发送无凭据的 embedding 请求。
- **Runtime 日志**: host 侧 `logs/runtime.log.<YYYY-MM-DD>`（按日滚动）；容器内 `xihe-container-runtime` 按日文件（`xihe-mcp-bridge` 已随 PLAN-0347 退役）；CP/Agent/UI 用稳定 `logs/<module>.log`，host watcher 用 `logs/host.log`。
- **Host E2E data/readiness**: `test:e2e:host` 每轮使用独立 PostgreSQL 和 host root，在 Playwright 前等待 Runtime `/ready`。成功、失败和中断都必须 teardown 并反向确认无本轮用户、Workspace、Session、ExecutionSpec、Sandbox 或文件残留；不得把长期 dev DB 作为 Host E2E 数据源。
- **Screenshot reproducibility**: A03 当前忽略 `*-snapshots/*.png`，本地 baseline 需要预先生成；`toHaveScreenshot()` 通过不等于人工 UI 审查通过，也不等于 fresh checkout 能复现视觉结果。
- **Runtime CWD 测试**: `dotenv_loader` 测试会临时切换 process CWD，测试 helper 已用 mutex 串行化；默认并行 `cargo test --lib` 可稳定运行。
- **Runtime per-request exec 延迟（PLAN-235）**: Workspace 操作经 Docker exec 单次往返，M0 spike 手工实测均值约 136ms（不可复现锚点，仅供参考）；高频批量操作若不可接受，以纯性能优化另行评估 HTTP 通道，不改变 operation core。
- **Runtime 后台 job 状态文件（PLAN-235）**: job 状态存于容器 `/tmp/xihe-jobs/<jobId>/`，容器重建即自然孤儿化；查询旧 jobId 返回 not found 属设计内行为，非数据丢失。

## PLAN-247 已修复边界

- Chat provider readiness 由 Agent 明确报告，CP 对 `unknown`/non-ready fail-closed；缺凭据不会创建 ChatRun、Message 或空 assistant。
- ChatRun、`Message.runId` 和 Idempotency-Key 持久化执行终态；断流且无法证明 provider 未执行时为 `ambiguous`，禁止自动重试。
- 普通 Chat 固定 `toolMode=none`，Agent 启动不做 MCP discovery；Workspace/tool 操作才按 workspace 懒加载 MCP，跨 workspace 复用会 fail-fast。
- provider catalog 只返回状态、模型能力和验证时间；ConfigAudit 的 provider secret 只保留 present/missing 与 fingerprint。

## PLAN-0327 已修复边界

- **stdio MCP 会话（PLAN-0347 起，替代 bridge）**：配置轮询失败（连接错/非 2xx/解析失败）返回 `Err` 并跳过该 workspace reconcile，**不得被当作"配置为空"停会话**；会话按 `(workspace, serverId)` 共享、FIFO 单飞，预算 3 次 + 退避 1/5/15s + 冷却 5 分钟（半开）；终止用容器内 `ps` 固定串 kill（`inspect_exec` pid 属宿主命名空间、EOF 不保证退出）；容器重建/evict 后会话表清理，首调/轮询惰性重建。原 bridge 生命周期问题（CHN-2/3/4）随之关闭。
- **CP→Runtime 调用超时（CHN-5）**：CP 端 `RestTemplate` 加 connect 2s / read 10s（该 bean 仅 CP→Runtime 调用点消费），Runtime 半死（TCP 可连不响应）不再悬挂 CP 请求线程；超时走各调用点既有显式降级（状态 `blocked`、文件/上下文 `Optional.empty`/`false`），无 host fallback。
- **工作区删除语义（STO-1）**：Runtime 清理移出事务、在提交后 best-effort 执行；失败记 `RUNTIME_CLEANUP_FAILED` 日志（含 stacktrace），DB 逻辑删除为权威，接口恒返回 `204`（与 OpenAPI 一致；旧实现返回未文档化的 `502`）。孤儿沙盒容器由 Runtime 启动期 `cleanup_orphans` 兜底。
- **Agent 配置（CFG-1/2/3）**：修复 llm-ready 守卫读死键 `effective`（改读 `status`），fail-closed 恢复生效；非必需域瞬断保留上一份有效值并在 `SyncReport.degraded` + 日志上报，不再整体替换缓存导致静默丢配置；user 层 `embedding`/`rag`/`agent-runtime` 覆盖随 run payload（`userOverrides`/`workspaceOverrides`）送达 Agent（`context-policy`/`user-preference` 无 Agent 读取点，不纳入）。

## PLAN-0328 当前残余

- **真实预算阈值**：H: 盘冷缓存实测仍为 2 PASS / 7 FAIL；建立、seal 与 100 文件 revert 延迟超过冻结阈值，不能改写为通过。证据：`plans/PLAN-0328-XH-change-safety-net/evidence/m3-revert-and-ui-2026-09-16.md` §8.3。
- **Full UI 上传/树刷新竞态**：workspace 初始 `loadTree` 在途时上传触发的刷新可能被静默丢弃；`full-ui-acceptance` 仍为 5 PASS / 1 FAIL。不得用手动 Refresh 冒充通过。证据：同一 PLAN evidence §8.3。
- **T3.10 审计不变量**：双路径落库及 revert 摘要无文件内容已验证，但 checkpoint×revert 合并矩阵仍待收尾。证据：`plans/PLAN-0328-XH-change-safety-net/evidence/m3-revert-and-ui-2026-09-16.md` §7。
- **T1.9 后置证据**：`headless`/后台/断线 `ask → deny`、`auto_review` 实现及其失败回退仍是后置/待补证据；当前只保留 seam 与 fail-closed 设计，不宣称已完成。证据：`plans/PLAN-0328-XH-change-safety-net/evidence/m1-reuse-and-answerer-2026-09-15.md`。

> UI 触发 revert 的账本来源已修正为 `source=ui`；不要再登记或声称存在未解决的 `source=cp` 缺陷。

## Code

- **Jackson 2/3 混用**: CP 同时依赖 Jackson2（`com.fasterxml.jackson.databind`，如 `McpProxyController` 仍用 `fieldNames()`）与 Jackson3（`tools.jackson`）。3.x 新增 `propertyNames()`（返回 `Collection<String>`）；按所在模块的依赖对齐选用，禁跨版本混调
- **JSONB @JdbcTypeCode**: JPA 实体含 `columnDefinition = "jsonb"` 的 String 字段必须加 `@JdbcTypeCode(SqlTypes.JSON)`，否则 PG 报类型不匹配
- **ConfigClient URL 路径**（Agent `config_client.py`、Runtime `config_client.rs`）：CP 内部端点路径为 `/internal/v1/config/{layer}/{domain}`（注意是 `/internal/v1` 前缀；PLAN-049 T3 测试暴露过误用公开前缀拼接内部路径的 bug）。新增模块调用时确认路径为 `/internal/v1/config/...`

## 技术债（PLAN-0317 收尾登记）

- **账本权威纯度**（**2026-09-14 已修复，PLAN-0326 M1**）：原状：`operation_items` 两类写者（MCP 网关 `source=mcp` 与 SSE 中继 `source=agent`）抢同一行，中继靠 `findLatestOpenItem(toolName)` 启发式匹配。修复（写者模型 v3，决策 #8/#9）：**账本单位 = 通道事实**——中继按事件阶段经 `LedgerToolRecorder` 记 Agent 侧事实（`source=agent` 行），网关自建派发事实行（`source=mcp`），唯一键 `(operation_id, source, tool_call_id)`（V14），`toolCallId` 降级为跨通道关联键，启发式删除；同键同源重放幂等、跨源两行并存。
- **`runtime_jobs` durable registry**（**2026-09-14 已删除，PLAN-0326 M2**）：schema 与服务已建但无 writer/caller（PLAN-274 债务 #11）→ V14 drop 空表 + 删除三层代码；J-3/P1-10 立项时按需重新设计（不沿用 V3）。
- **Rust lint/format 预存问题**（**2026-09-13 已修复，PLAN-0323**）：原状：`cargo clippy --all-targets` 报 `type_complexity`、rustfmt 漂移 ~190 处 / 20 文件、门禁无 fmt 无 `--all-targets`、`format.sh` 吞错。现状：fmt 全量清零（208 处 / 22 文件，style-only `cbb6bbe`）；2 告警清零；门禁 `lint:runtime` = `cargo fmt --check && cargo clippy --all-targets -- -D warnings`；`format.sh` 三段 fail-fast；Rust 工具链 pin 1.97.1（`packages/runtime/rust-toolchain.toml` + mise `[tools].rust`）。**新登记**：`packages/agent` ruff format 漂移（42/85 文件待重排；`format.sh` 长期未执行），同类问题待独立批次。
- **容器侧改动生效条件**：修改 `container_runtime.rs` 后必须重建 `xihe/workspace` 镜像，否则沙盒内仍是旧二进制（PLAN-0317 实测曾据此误判）。
- **UI toast 基础样式缺失**（2026-09-13 由 PLAN-0323 验证发现；**2026-09-14 已修复，PLAN-0325**）：原状：`vue-sonner/style.css`（含 `[data-sonner-toaster]{position:fixed}`）从未被导入（全仓零引用；JS bundle 仅设置 `data-sonner-toaster` 属性、无内联 CSS）→ toaster 无定位样式，toast 以未样式化元素落文档流底部（实测 `rect.y=1080` 视口外、`position: static`），全应用 toast 反馈实际不可见。修复：`packages/ui/src/components/ui/sonner/Sonner.vue` 显式 `import "vue-sonner/style.css"`；浏览器复验 = 真实时间用例 `toBeInViewport()` 通过 + 截图可见（`sse-liveness.spec.ts`，`.local/plan-0323/` 留档）。
- **存量盘点入口**：调用链/审批/物化/SSE 未闭环项与去向以 workspace `plans/PLAN-0318-XH-call-chain-audit/evidence/call-chain-audit-2026-09.md` §9 活表为准；跨来源（审计/缺口审计/挂起项/架构收敛）统一总表见 `internal/A03-xihe/docs/xh-backlog-and-debt.md`（本文件技术债段为项目侧入口，三者互为补充）。
