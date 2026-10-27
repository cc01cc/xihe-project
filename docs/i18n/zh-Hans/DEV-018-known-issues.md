---
title: DEV-018 - Known Issues 补充
category: dev-guide
lang: zh-Hans
sidebar_group: "开发指南"
sidebar_order: 18
status: active
created: 2026-09-02
updated: 2026-10-25
---

# DEV-018: Known Issues (Supplement)

> 面向排障：AGENTS.md 放最关键项，这里收录其余已知问题（环境/Code 两节）。已修复项保留根因供回溯。

本文件收录 AGENTS.md 之外的已知问题，供排查时参考。

## OpenAPI 与 MCP 入口 405 漂移（PLAN-0537 登记，未修复）

`docs/api/openapi.yaml` 的 `mcpStream`（GET）与 `mcpDisconnect`（DELETE）仍声明 `200` / `204`，而代码自 PLAN-0308 决策 #34 起固定返回 405（`MCP_STREAM_NOT_SUPPORTED` / `MCP_SESSION_NOT_SUPPORTED`）。属历史漂移，不影响运行时行为；下次修订 OpenAPI 时一并校正。

## LLM 行为断言的确定性缺口（PLAN-0532 登记，2026-10-21；2026-10-22 由 PLAN-0540 解决）

- **现象**：PLAN-0532 的 `failure_budget.no_repeat.v1` 三连跑中 1 次 A2 失败——模型未发起任何工具调用，run 正常 `completed`，没有 `RUN_BUDGET_EXHAUSTED`/`RUN_NO_PROGRESS`。
- **根因**：该断言同时要求「运行时刹车生效」（确定）与「模型至少尝试一次」（随机）；评测阈值 `runMaxTurns=2` 恰好落在「尝试=2 次 LLM 调用 / 不尝试=1 次」的分叉点，结果二值化。机制本身无缺陷（r2/r3 已真实触发预算码）。
- **判定**：测试设计缺陷，不是基础设施 flaky；不在 0532 内改 dataset/scorer/report/gate，也不以重试掩盖。
- **处置（已落地，PLAN-0540）**：拆为 `failure_budget.no_repeat.v2`（invariant，脚本化 provider 强制触发刹车，只判机制）与 `failure_budget.attempt_rate.v2`（behavior，真实模型固定 5 次统计「至少一次工具调用」率）；gate v2 对 behavior 用 `behavior_rate_min=0.8` + 最小有效样本 3 判定，infra 不计入分母。契约见 DEV-025 §3.3 / §5，实测见 `plans/PLAN-0540-XH-llm-test-determinism/evidence/behavior-gate.md`（3 轮 × 3 任务 × 5 次，单次成功率 43/45，无 infra）。
- **复现（历史）**：stack-2，`xiaomi/mimo-v2.6-flash`，eval workspace 的 `agent-runtime.runMaxTurns=2`；证据见 `plans/archive/PLAN-0532-XH-agent-eval-tool-surface/evidence/baseline-4class.md`。

## 全量 host E2E 基线口径（PLAN-0365，2026-09-18）

- **入口必须走 `node scripts/e2e-host.mjs [--llm-mode=<mode>] <spec>`**：手动 `npx playwright test` 不注入 baseURL/fake 端口会产生假失败（ERR_CONNECTION_REFUSED / invalid URL）。
- **Agent 单 workspace MCP 绑定（PLAN-262）**：Agent 进程首个 chat 绑定 workspace 后，其它 workspace 的 chat 将 fail-closed（`MCP workspace context cannot be reused across workspaces`）。全量串行 host E2E 中跨 workspace 的 write_file 审批类 spec（checkpoint-rollback S1、checkpoint-slices S1、journey-a、journey-c）因此**预期失败**；单 spec 复跑（Agent 首绑=本 spec workspace）为验证口径。**按 fail-closed 接受（PLAN-0348，2026-10-17 决策 #7）**：该行为是 Session 固定 Workspace 的既定安全边界，不实现 Session 内 rebind；根治若需要另立计划/backlog。PLAN-0348 已将本条收敛为「验证型收口」并补负向证据（CP 作用域拒绝 + Agent 跨 workspace fail-closed）。
- llm-mode 是 boot 期属性：external 复用栈时 0365 已补 fixture 启动 + provider 重导入，但**最可靠做法仍是以目标 mode boot**。
- 视觉基线（toHaveScreenshot）在 UI 结构变更后须重置，重置前先确认 DOM 断言全过。

## CP 拉取 Runtime 根 AGENTS.md 返回 403（2026-09-27 登记；2026-09-30 静态复核收敛）

- **现象**：Host E2E 创建 parent/child chat 时，CP `RuntimeContextSourceClient` 以固定 body `{"path":"AGENTS.md"}` 调 `/internal/v1/runtime/workspaces/{workspaceId}/files/read` 收到 403；CP 以 `Optional.empty` 继续，不注入该文件上下文。与浏览器 `/api/v1/mcp` `list_directory` 403 是不同 route/caller，互不归因（见 PLAN-0420 `evidence/m0-auth-call-path-inventory.md`）。
- **根因（高置信，静态复核；非新问题）**：该 403 只能来自 `PathTraversal`/`SymlinkEscape`（`ws_file_handler::map_error`）；`fs.rs resolve_canonical` 把 canonicalize 任意失败（**含 ENOENT**）判为 `PathTraversal`，因此**目标文件不存在即回 403 而非 404**（`FileNotFound → 404` 在 read/stat 路径不可达）。host E2E 新注册 workspace 根目录无 `AGENTS.md` 写入者，故命中。同结论已有容器 probe 实锤：`plans/archive/20260919/PLAN-0345-XH-workspace-lifecycle-core/evidence/validation.md`、`plans/archive/20260918/PLAN-0365-XH-host-e2e-legacy-failures/{design.md,evidence/triage-matrix.md}`；**PLAN-0365 决策 #3 已裁定维持 403 现状不改 404**（0340 `readAgents` 容忍失败）。原「待诊断」系未交叉引用归档证据的重复登记。
- **为何当时无底层 error**：结构性缺口而非丢日志——Runtime 全 app 无 per-request trace、`map_error` 不打日志、problem `detail` 为静态串且 `requestId` 自造，该请求在 Runtime 侧零日志；CP 侧唯一痕迹是 `Runtime AGENTS.md read failed` WARN，并被 `ContextSourceRefreshService` 归为 `status=unchanged`，UI 无提示。
- **剩余低概率分支（未复现排除）**：① workspace 根目录未物化/挂载空（`resolve_canonical` 先试文件后试根，根缺失也先落 403）；② `AGENTS.md` 为外指 symlink/断链。单变量判定：同 workspace `files/list {"path":"."}` 200 = 根存在 → 只剩文件缺失；`files/stat` 与缺文件 `read` 同为 403 = 语义复现；`files/write` 后 read 200 = 闭环。
- **边界**：确认上述分支前不放宽 Runtime 路径安全策略；「403→404 语义矫正」与 PLAN-0365 决策 #3 冲突，属 B 类设计变更，须经用户裁定。
- **处置更新（2026-10-01，PLAN-0427）**：用户裁定机制三并立项 **PLAN-0427** 承接——`fs.rs resolve_canonical` 区分 ENOENT→`FileNotFound`（真越界/`ELOOP` 仍 403，路径安全零放宽），`files/read` 缺文件承载为 **`200 {found:false}`**（自描述成功响应，非错误通道），supersede 归档 PLAN-0365 决策 #3（#2 的 handler 特判否决维持，落点仍在 fs 层）。**本条目的 403 现象随 0427 落地关闭**；CP `readAgents` 对 `found:false` 行为与旧 403 等价（`Optional.empty`→`ContextSourceRefreshService` 同一「无文件」分支），消费 `found` 区分 missing/unavailable 归 PLAN-0382 Q2=A。**本条目保留的残项**：Runtime 零日志（无 per-request trace、`map_error` 不打日志、problem `requestId` 自造）为独立可观测性债，不随 0427 关闭，待另行立项。

## PLAN-0345 工作区生命周期 — 行为变化与已知限制（2026-09-18）

- **`destroying` 409 窗口**：destroy 进行中的 workspace，materialize/ensure 立即 409 `WORKSPACE_DESTROYING`；窗口结束（完成注销）后按 404 处理，再次 ensure = 新建。CP 原样透传该 409（不再 collapse 502）。
- **paused 恢复语义**：`unpause` 失败 fail-closed（`failed` + reason），无 recreate fallback；paused 容器若被外部 `docker kill`，ensure 探测后走正常 reconcile。
- **reaper 只剩 3 档**（15m pause / 2h stop / 24h 注销）；`Suspended/Released` 不再写入 instances，statuses 保留 `released` 字面仅供 UI「已释放」文案推导。
- **工作区生命周期操作锁为进程内存**：`WorkspaceOperationLock` 重启后全清，依赖 Docker `rebuild` 接管；它只串行化 Runtime 内 ensure materialization 与显式删除，不提供跨进程双主防护，单 Runtime v1 场景可接受。空闲回收循环与进程退出清理仍是独立流程。
- **REST read/list/stat 已走容器 exec**：无 Docker 或容器未启动时这些端点 fail-closed 503（与变更类一致）；binary write 仍 host 直写（JSON 帧 UTF-8 限制，债）。

## PLAN-0391 工作区运行资源释放 — 已知限制（2026-10-17）

实现与真实 host 栈验收见 PLAN-0391 M3 证据（`plans/PLAN-0391-XH-workspace-runtime-disconnect/evidence/m3-acceptance-2026-10-17.md`）。未关闭限制：

- **active-Job 门只覆盖 Job engine 管理的执行（host/MXC）**：Runtime release 的锁内实时复查用 `JobEngine::running_job_ids_for_workspace`（后端无关，`job_engine/mod.rs`）；Docker 容器内的 job 不在 Job engine 表中，故 docker 模式（服务容器化冻结；工作区 Docker 后端仍受支持）下 Runtime 侧无法感知在飞的容器 job。CP 侧 durable `hasRunningForWorkspace` 仍会先行拒绝，但两条路径之间无共享锁，docker 模式下存在 check-then-act 残余窗口。
- **`cleanupFailed` 目前恒为 false**：release 的清理原语（停事件 watcher / 终止 job 进程树 / 清 MCP session）当前不返回失败，`cleanupFailed` 字段为契约预留；若后续清理步骤可能失败，须在 Runtime 上报真实结果。
- **可重试冲突不消费幂等键**：Runtime 返回 `WORKSPACE_BUSY`/`WORKSPACE_DESTROYING` 时释放操作被 `discard`（不落终态）；客户端应使用**同一 Idempotency-Key 重试**，换个新键会被在飞检查拒绝为 409。

## PLAN-0354 LLM 摘要 — 适用前提、租约与回退排障（2026-09-19；0355 裁定：默认关）

- **默认关（PLAN-0355 质量门，2026-09-19）**：`context-policy.summaryProvider` 默认 `rule`（LLM 摘要需显式 `llm` 开启）；裁定 reject——失败率 35.2%、延迟 p95 44.4s（阈值 10s）、约束保留 96.97% 低于规则式基线（`plans/archive/20260919/PLAN-0355-XH-quality-cost-gate/evidence/gate-decision.md`）。重开先决：修复 F1（`shrink_failed` 截断摘要丢 `[Constraints]`）并以 p95 ≤10s 的 provider/model 按冻结判据复测。
- **BYOK 前提（显式 `llm` 时）**：LLM 摘要仅在会话绑定 provider connection（`sessions.provider_connection_id`）且 canonical pair（provider+model）完整、provider ≠ `mock` 时发起；env-only / 无连接用户回退规则式（`fallbackReason=no_credential`），属设计内回退而非故障，压缩与 run 均不受影响（I1）。默认 `rule` 时为直属规则式、无 `fallbackReason`。
- **租约 2 分钟 TTL**：摘要跳使用 `ProviderCredentialLeaseService.issue(..., 2min)` 新重载（既有调用方保持 5 分钟默认），窗口覆盖 `summaryTimeoutMs` 上限 60s；兑换仍走既有 `/internal/v1/provider-leases/redeem` 通道，租约行以 `sessionId` 落审计、不新增 purpose 列，租约 token/apiKey 不入日志。
- **回退原因对照（排障）**：
  - `no_credential`：会话未绑定 provider connection（BYOK 前提）→ 在会话中重选连接。
  - `lease_failed`：connection revision 过期 / 连接不可用 → 重选连接后重试。
  - `timeout`：模型响应超过 `summaryTimeoutMs` → 调大该键（≤ 60000）。
  - `agent_error`：Agent 非 2xx / 连接失败 / 响应不可解析（CP 不区分细分码）。
  - `invalid_output`：摘要为空 / 超 100000 chars / 无 `^[` 分节行；`shrink_failed`：产出未通过缩减校验，实际应用截断摘要（LLM usage 成本仍计）。
- **验证边界**：无 BYOK 凭据的环境（host E2E）只覆盖回退路径；LLM 成功路径由 WireMock 集成测试与 Agent 单测覆盖（`evidence/observability.md` 与 spec §10 断言清单）。

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

## PLAN-0416 上下文 epoch — 契约与实现不一致（2026-10-13 登记，部分收口）

- **现象**：`epoch.started` / `epoch.replaced` 与 `session.created` 在两条投影路径（CP `ContextProjectionService`、Agent `AgentContext.apply_event`）都有消费者，但**生产代码没有任何 producer 写入它们**——全仓只有 taxonomy 声明、投影消费、`V43` 分类排除清单与测试里的手工 append。因此 `session.created` 的「payload 带 `epoch_id` 即建首个 epoch」分支线上不可达，`epoch_id` / `baseline_hash` 在真实会话中恒为空；epoch 只有 L1（`context.source_changed`）、env（`context.env_updated`）与 SUM（compaction）三个子槽被真实更新（唯一例外：`session.forked` 的 child 会分配 `contextEpoch`）。
- **后果（当前无用户可见故障）**：普通会话在事件重放路径上 `epoch` 恒为 `None`，而 CP 投影无条件输出字段全空的 epoch 对象——两条恢复路径对「尚无 epoch」的表达不一致（`null` vs 空对象、语义等价但形态不同）。正常路径上首轮 chat 必写一次 `context.source_changed`，两端都会得到非空 epoch，故分歧被掩盖。命中场景 = 绕过 source refresh 直接写事件的路径（合成会话、测试夹具、未来的导入/迁移工具）、首轮 chat 之前的快照比对，以及未来真正接上 `epoch.*` producer 时的 payload 键映射等价性（legacy `baseline_hash` 会同时映射到 `source_hash` 与 `summary_hash`，无测试覆盖）。
- **证据**：隔离 CP+PG 恢复探针曾因此在 `agent_live_cp_recovery_equivalent` 判不等；V13 冻结判据只要求 messages 侧 `(sequence/type/payload/prune 状态)` 相等，故 V13 判通过。见 `plans/PLAN-0416-XH-context-reliability-and-retrieval/evidence/host-verification-2026-10-13.md`。
- **收口状态**：
  - **恢复路径表达不一致 — 已收口**（2026-10-13 用户裁定选项 ①，CH `1c005f92`）：`AgentContext.from_snapshot()` 仅在 epoch 携带内容时重建 `ContextEpoch`，CP 的全空占位对象读作「无 epoch」；隔离探针复测 **18/18 全绿**。
  - **`epoch.*`/`session.created` 无 producer 与 `session.created` 消费分支线上不可达 — 仍待裁定**（登记 known issue 不改 spec／修订 spec 声明为未实现／另立「接上 producer」任务）。
  - **`epoch.*` 的 payload 键映射等价性 — 无测试覆盖**，待真正接上 producer 时补。

## 已修复 — Chat SSE 生命周期与真实流式（PLAN-230 已完成 M1-M4）

- **会话 SSE 一次性连接导致连续消息 409**：已修复。原因有二：CP 在每轮末尾无条件 `complete(sessionId)` 使会话 SSE 一次性，且旧 emitter `onCompletion` 按 sessionId 清理可能误删新连接；UI 侧 `onclose` 未重连。修复：CP 改持久会话 SSE（`SseEmitterManager` 按 `{sessionId, generation, emitter}` 存储 + `removeIfCurrent` 身份比对，误删记 `stale_cleanup_ignored`；`complete` 由客户端断开/发送失败等内部清理触发，服务端主动收尾仅会话删除成功路径，见下节 PLAN-0352）；UI `chatTransport` 单飞 + 指数退避重连，`SSEStream` 发送前手工确认连接。验证：同一页面连续两条 `POST /api/v1/chat` 均 202 且助手回复不空；多 `token` 事件在 `done` 前多次增长。
- **真实模型流式未生效（stream=False 单 token）**：已修复。`XiheLiteLLM` 未实现 `_astream()` 导致 `astream_events` 仅产生 `on_chat_model_end` 单包。修复：显式 `streaming=True` 使 `on_chat_model_stream` 产生多 token，`sse_adapter` 按 `run_id` 去重使 `on_chat_model_end` 仅作无流 fallback。
- **日志泄露与关联缺失**：已修复。main.py 前记录消息前缀、ChatController 记录完整 Agent error body、litellm curl debug 的 Authorization: Be****、Spring Using generated security password。修复：litellm.suppress_debug_info=True、log_redact 掩码 Authorization:、pplication.properties 占位密码、scan-log-secrets.mjs 读取失败即失败并扩展 pattern（门禁 clean 20 files）。

## PLAN-0352 会话删除 SSE 与在飞 run 收尾（2026-09-19）

- **会话删除不收尾 SSE、不处置在飞 run**：已修复。`SessionController.delete` 在删除事务外先取消该会话全部非终态 run（`ChatRunCancellationService`，与 `POST /api/v1/chat/runs/{runId}/cancel` 共用编排），再有界等待终态投递（上界 N=2s，等待信号 = relay 终结 `releaseRun`/`lease_owner` 置空；超时记 `session_delete_sse_wait_timeout` 后继续），然后执行删除事务，成功后 `complete(sessionId)` 关闭 SSE；无在飞 run 时删除后立即收尾。删除失败保留连接并记 `session_delete_failed`。
- **已知前置（阻断，非本计划范围）**：含 `operation_extensions` 行（`llm_usage`/`job_state`/`mcp_call`）的会话硬删会被 `ck_operation_extensions_target`（`V2__session_operation_ledger.sql:181-192`）阻断；登记 backlog `DDL-13`。**已修复（PLAN-0367 V34，2026-09-19）**：两目标 FK 改 `ON DELETE CASCADE`（CHECK 保留），硬删随账本删除 extension 档案（接受的取舍，登记于 backlog DDL-13）。
- **审计留存边界（2026-10-06）**：当前领域审计事实随所属 Session/Workspace 生命周期级联删除；删除后独立留存或匿名化不属于当前需求，后置债务登记为 DDL-14。
- **残余**：会话硬删时 `scope=session` 存活 job 无处置入口（依赖 BL-21 单 job 取消入口）；承接登记 PLAN-0353。

## 宿主注入畸形 `NO_PROXY`（PLAN-0539 代码侧已兜底，2026-10-20）

- **现象**：某些宿主（实测 DeepSeek Harness `0.2.1-rc.2`）向子进程注入 `NO_PROXY=…,::1,[::1]`。httpx 在**构造**客户端时把每个条目解析成 `URLPattern`，方括号写法被读成端口 `':1]'` → `httpx.InvalidURL`。Agent 在 import 期构造 CP 客户端，于是「进程启动即退、端口永不监听」；`pytest` 因 `tests/conftest.py` 收集期 import `main` 而整体不可收集。
- **代码侧处置**：`xihe_agent/__init__.py` 在任何子模块导入前归一化 `NO_PROXY`/`no_proxy`（只删含方括号的条目，裸 `::1` 保留，结果为空则删变量）；内部 CP 客户端统一 `trust_env=False`；MCP 传输经 `httpx_client_factory` 注入同等客户端。规则边界：**只有含方括号的条目会崩**，裸 `::1` 安全。
- **残余风险**：宿主注入本身未消失，其他 Python 工具仍会中招。另注意：从父 shell 改 `NO_PROXY` **对 python 子进程无效**（继承型启动会被宿主改写，只有显式传 env 块才生效），排障时不要据此判断「修复无效」。
- **排障判据**：`curl 127.0.0.1:<agent port>/internal/v1/agent/health` 有响应且 `configRevision` 非空 = 正常；若进程已退出、日志里有 `InvalidURL: Invalid port: ':1]'` 即为本条。

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

## Mock E2E ProviderHub 夹具债务（PLAN-0505 审查发现，2026-10-15 登记；未修，需立项）

- **现象**：`e2e/mock/full-ui-acceptance.spec.ts` 的 ProviderHub-creates 用例在 develop 基线（e42d95c0）即红：点击 provider 卡片后 `provider-connection-modal`（连接表单）不出现，15s 超时。同轮 sidebar、message-search（PLAN-0401 evidence 已登记同族）、workspace-file、PDF、FileEditor 共 6 个红点。0505 的双端对照实证见 `plans/PLAN-0505-*/evidence/reports/plan0505-baseline-mock.log`。
- **影响**：mock lane 对 ProviderHub 表单类流程（创建/类型变更 UI 流）失去回归能力；0505 删除流的浏览器证据由 real lane `plan-0505-delete-impact.spec.ts` 承载（真实链路一次通过），不受影响。
- **修复方向**：独立小批次修 mock 夹具（route mock 与组件接线的对齐），修好后补删除流桌面/移动断言。真实链路回归不可因此省略（0505 复跑曾靠 real lane 逮住单测漏掉的对话框回归）。
- **PLAN-0560 复核（2026-10-27）**：develop `3516901b` 与 `plan-0560` worktree 双侧仍红，与 0505 同根（picker→connection form 打开链路），同族新增 `e2e/mock/provider-protocol-groups.spec.ts:104`（discovery select 选项缺失，同为 picker 表单链路）。另发现独立根因一例：`workspace-management.spec.ts:65` empty-state——router 守卫对 `/workspace/new` 执行 `writeTabWorkspaceId("new")`，而 helper 对任意 id 的 `GET /api/v1/workspaces/*` 一律返回 Mock Workspace，导致空态分支永不可达。三例均已在两侧复跑归因（`one/plans/PLAN-0560-*/evidence/m4-wave.md`）。全量 mock lane 并行 run 在两侧都大面积环境性 flaky（分支 17F / develop ≥25F，失败集互相重叠且含大量非 ProviderHub spec），逐 spec 串行为准。

## PLAN-0505 审查次生回归 — 状态机守卫须双侧验证（已修复，供回溯）

- **教训**：为 `cancelDelete` 加 `deleting` 守卫（防中途取消吞错）时，成功路径调用的同一函数被守卫拦截，删除成功后确认对话框不关闭。单测未断言「成功后对话框关闭」而漏过；真实链路 spec（`plan-0505-delete-impact.spec.ts`）复跑一次逮住。
- **修复**：拆出无守卫的 `closeDeleteDialog()` 供成功路径（commit `a70d5425`），单测补断言。
- **规则**：破坏性操作的状态机守卫改动，必须同时验证守卫路径与既有成功路径两侧；UI 门禁类修复的真实浏览器回归不可省。

## PLAN-0505 D-1 判定修正 — 部分唯一索引可命中非前导列（已证伪，供回溯）

- 审查曾判定「`config` 表 `WHERE layer=? AND domain=?` 无法走索引，删除事务锁持有时间随表规模线性增长」。经 600k 行合成基准实测推翻：Postgres 对 partial index 的 `WHERE layer='user'` 谓词匹配后，可按非前导列 `domain` 做 Bitmap Index Scan（8.9ms，含 2KB config_value 堆取），4 次扫描合计 ≈36ms。删除路径无需 `(layer, domain)` 迁移（V72+ 备用）；证据与口径见 `plans/PLAN-0505-*/design.md` 技术债 D-1。

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
