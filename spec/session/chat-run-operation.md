# ChatRun 与 Session Follow-up 生命周期

> 契约状态：`proposed`
>
> 实现状态：`partial`
>
> Profile：`lifecycle`
>
> Owner：CP ChatRun + Follow-up Queue + Run Guidance domains
>
> 消费者：Agent、Runtime、UI、Audit
> 来源：PLAN-0387、PLAN-0442、PLAN-0463–0467、PLAN-0528、PLAN-0529、PLAN-0530、PLAN-0536、DEV-014、DEV-017
> 更新日期：2026-10-22

## 三类对象

| 对象 | 作用 | canonical owner |
|---|---|---|
| ChatRun | 一次用户 Chat submission 或 CP 内部 spawn 派生执行与终态；**Chat 生命周期的唯一根（PLAN-0464）** | CP Chat |
| Message | 用户输入与助手输出；ChatRun 生命周期的消息事实 | CP Chat |
| Follow-up QueueItem | 入队 payload、FIFO 顺序、暂停/撤回/admission 状态；admission 后只作队列投影 | CP Follow-up Queue |
| mcp_invocations / mcp_attempts / mcp_dispatch_history | Agent 工具调用的执行域事实（gate 建行、relay attempt、流转历史） | CP MCP execution domain |
| chat_run_history | ChatRun 状态流转的 append-only 历史（terminal/cancel/recovery/restore 四写入方） | CP Chat |

ChatRun 是 Chat 生命周期的唯一执行根。工具调用、Workspace Job 和 Follow-up 队列分别由其 owner domain 保存事实；不存在跨域 Operation root。

## 关联与幂等

- ChatRun MUST 关联一个 `sessionId` 和一个 effective `workspaceId`。
- CP admission 创建 ChatRun 与 user Message；不创建/关联跨域 Operation root，也不传播 `operationId`。Admission 冲突由 `chat_runs` 唯一索引映射为 409。
- User submission 的幂等键沿用 `(userId, sessionId, idempotencyKey)` 当前实现；spawn 另按 V39 的父 durable event key 全局防重；principal 泛化由 Security/PLAN-0374 承接。
- `origin` 是持久化来源标签：`user_submission` / `spawn`。公开 `POST /api/v1/chat` 恒为 `user_submission`，请求体不得控制该字段。
- CP 内部 `spawn_agent` 创建不经过浏览器 SSE subscription gate。其 spawn event key = 父 run 下 `spawn_agent` 的 canonical `toolCallId`（PLAN-0464 T2.1；旧 `operation_items.id` 身份退役），并作为 child ChatRun 的 `idempotency_key`；同事件+同 request hash 返回既有 run，不同 hash 冲突。V39 以 `(user_id, idempotency_key) WHERE origin='spawn'` 唯一索引防并发重复。
- Internal spawn MUST 校验父 run、父 `mcp_invocations(source=agent)` 行与 child Session 的 user/workspace/parent provenance 一致；child run 行记录 waiting link（`waiting_on_run_id`/`waiting_tool_call_id`，V52 无回填，pre-V52 子 run 按 legacy 处理、不阻断终态）；只有子会话派生首条 run 使用 spawn，子会话后续用户输入仍走现有 `/api/v1/chat` 门禁。
- Spawn 不接受调用方自行提交的 attachment JSON；CP 根据 File 表重建只读摘要并把规范化 fileId 纳入 request hash。附件必须归 child Session 所有，不隐式共享 parent Session 的 fileId；跨 Session 携带文件须走 fork 的显式复制或未来显式授权路径。
- 工具关联使用 `toolCallId` 作为跨 Agent/CP/Runtime 关联键，禁止按事件时间或工具名启发式配对。

## 状态与终态所有权

ChatRun 当前可经过 `accepted`、`queued`、`running`、`streaming`、`awaiting_approval`、`cancelling` 等非终态；终态包括 `succeeded`、`failed`、`partial`、`ambiguous`、`cancelled`。具体 transition 以 CP entity/repository/service 为事实源。

1. ChatRun terminal outcome MUST 由 CP transition/settlement/recovery 路径落定（`ChatRunTerminalService`），并同步写 `chat_run_history`。
2. Agent SSE `done`、晚到的 tool result 或 UI 本地关闭不得单独改写 durable terminal state。
3. 取消路径 MUST 让位于结算路径；取消窗口中的晚到副作用不能抢写已收口 item/run 终态。
4. 审批等待是 ChatRun 的中间状态，不是 authorization decision；拒绝/过期必须进入明确终态。
5. 每类 durable audit/history MUST 保留其 owner-domain 身份、关联键、attempt 和安全错误/策略摘要，但不得持久化原始 secret/arguments。
6. `llm.usage` ContextEvent 由终态从 relay 内存 usage payload 直写（无 usageData ⇒ 不写事件）；run 终态事务后 best-effort 触发 `closeRunScope` 并对账仍 `active` 的 agent invocation。

## Follow-up 队列（PLAN-0442）

- 队列是 CP-owned 的 durable 投影（V49 `session_follow_up_items`），不是 ChatRun；item 行是队列事实源，SSE/snapshot 只作刷新提示。
- 入队（`POST /api/v1/sessions/{sessionId}/follow-ups`，`Idempotency-Key` 必带）返回 202 = durable 入队，不代表 child Run 已创建；普通 `POST /api/v1/chat` 在队列未清空时 MUST 409 `FOLLOW_UP_QUEUE_NOT_EMPTY`，Run 中排队必须走显式 Queue 动作。
- 每 Session 至多一个 active child：`admitHead` 先锁 Session 行再锁 item 行，QueueItem 状态转换与 child ChatRun/Message 在同一 REQUIRES_NEW 事务写入，失败整体回滚；claim 与 withdraw 并发时至多一方转换成功，已 claim 后撤回返回 409 `FOLLOW_UP_ALREADY_ADMITTED`。
- 父/child Run 进入终态由既有 settlement 路径同事务推进队列：succeeded/partial/failed → consumed child `completed` 并推进下一项；cancelled/ambiguous → 整队 `paused`（`parent_cancelled`/`child_cancelled`/`child_ambiguous`）。已 admission 的 cancelled/ambiguous child MUST NOT 重放；继续（`POST .../continue`）把已消耗 child 收敛为 `completed`，只放行其后项目。
- admission 前重验附件所有权、branch 可见性与 binding，失败置 `paused`（如 `attachment_unavailable`）而非切换分支或放行。
- Session 删除意图期间队列变更与普通 Chat 均 MUST 409 `SESSION_DELETING`；CP 启动恢复暂停 admitted-without-child 项并唤醒 queued head（幂等）。
- PLAN-0442 V1 runtime constraint: deployments using Follow-up MUST run exactly one active CP instance. The after-commit wake is process-local and startup recovery only runs on application startup; this is not cross-instance durable delivery. Multi-instance Follow-up support requires a separately approved design and verification before scaling CP.

## Run Guidance（PLAN-0528/0529/0530/0536）

> 实现状态：`implemented`（CP 0528、Agent 0529、UI 0530、竞态收口 0536；2026-10-19）。

- Guidance 是 Run-scoped 的 CP durable 记录（V77 `chat_run_guidance`），独立于 Message、Follow-up Queue、Context EventStore 与 Operation audit；同一事实不得在四处重复宣称。来源首版仅 `user`（DB `CHECK source_kind='user'` fail-closed；guard 接入须新迁移 + Security 立项），作者由 CP 从 TenantContext 派生，请求体不得自报来源。
- 仅活跃 Run（`running`、`streaming`、`awaiting_approval`）接受提交，其余状态 `409 GUIDANCE_RUN_NOT_ACTIVE`；`Idempotency-Key` 必带，同键回放返回原记录。正文 ≤8000 字符，日志/审计只记 id/sequence/status，不记正文原文。
- 状态机仅 `pending → consumed`（Agent consume 确认，幂等）与 `pending → terminal_expired`（Run 终态事务内收敛，与 Follow-up settle 同位；启动恢复对存量收敛一次性清扫）；两终态互斥且不可回转。terminal 后未消费 Guidance MUST NOT 迁移到续跑新 Run（PLAN-0510 continuation 读不到源 Run pending）。
- Agent 消费协议（`GET /internal/v1/chat/runs/{runId}/guidance/pending` + `POST .../{guidanceId}/consume`）：consume 幂等；consume 命中 terminal-expired 返回 `409 GUIDANCE_ALREADY_TERMINAL_EXPIRED`，Agent MUST 停止重试且不注入。
- **无 Guidance 专属 SSE 事件**（裁定候选①）：提交/消费/失效的 UI 可见性一律通过 `GET /api/v1/chat/runs/{runId}/guidance` 快照重读（提交后 + Run 终态事件时）。
- PLAN-0528 V1 runtime constraint: Guidance 与 Follow-up 同源——deployments using Guidance MUST run exactly one active CP instance；跨实例可靠投递需另行设计验收后方可扩展 CP。

### 持久模型（V77）

表 `chat_run_guidance`（Flyway V77，forward-only）：

| 列 | 类型 | 约束/说明 |
|---|---|---|
| `id` | `uuid` | PK |
| `session_id` | `uuid` | NOT NULL，来自 Run（派生，非客户端传入） |
| `run_id` | `uuid` | NOT NULL，目标 ChatRun |
| `branch_id` | `uuid` | NOT NULL，来自 Run 的当前 branch（派生；仅作 run-scoped 读取对齐，禁客户端传入） |
| `source_kind` | `text` | NOT NULL，**`CHECK (source_kind = 'user')`**（fail-closed） |
| `author_principal_id` | `uuid` | NOT NULL，提交者（=当前认证用户） |
| `body_markdown` | `text` | NOT NULL，长度 ≤ `8000` 字符（DB CHECK） |
| `sequence` | `bigint` | NOT NULL，Run 内单调递增（1 起，取 `max(sequence)+1`，行锁内） |
| `status` | `text` | NOT NULL，`pending` / `consumed` / `terminal_expired` |
| `idempotency_key` | `text` | NOT NULL（`Idempotency-Key` 头）；`(run_id, idempotency_key)` 唯一 |
| `created_at` / `updated_at` | `timestamptz` | NOT NULL DEFAULT now() |
| `consumed_at` | `timestamptz` | NULL（consumed 时写） |
| `terminal_expired_at` | `timestamptz` | NULL（terminal_expired 时写） |

索引：`(run_id, sequence)` 唯一；`(run_id, status)` 普通（Agent pending 读取）；`(session_id)` 普通。

### 公开路由（`/api/v1`，用户 JWT 鉴权）

**`POST /api/v1/chat/runs/{runId}/guidance`**

- 请求头：`Idempotency-Key`（必填；缺失 400）。
- 请求体：`{ "content": string }`（**不含 sourceKind**；服务端恒置 `user`）。`content` 空白/超 8000 字符 → 422。
- 校验与作者派生：runId 存在 → Run 属调用者可见 session/workspace → Run 状态 ∈ 允许集合 → 派生 author = 当前用户。
- 允许提交的 Run 状态集合（冻结）：`running`、`streaming`、`awaiting_approval`。显式排除：`accepted`、`queued`、`cancelling` 与全部终态。
- 成功 `201`：`{ "id", "runId", "sessionId", "sequence", "status": "pending", "createdAt" }`（不含正文回显）。
- 幂等重放：仅 Run 所属 Session 的 user/workspace 可重放；同 `(runId, Idempotency-Key)` → `200` 返回原记录（不新建），`status` 为存储状态 `pending|consumed|terminal_expired`（终态不回转为 pending）。非属主在返回任何记录字段之前 `403`，响应体不得含 `id/runId/sessionId/sequence/status/createdAt/content`。
- 错误：`404` run 不存在/不可见；`403` 非本工作区/越权；`409 GUIDANCE_RUN_NOT_ACTIVE`；`400` 缺 Idempotency-Key；`422` content 非法。

**`GET /api/v1/chat/runs/{runId}/guidance`**

- 返回该 Run 的 Guidance 快照（按 `sequence` 升序）：`{ "items": [ { "id", "sequence", "sourceKind", "status", "createdAt", "consumedAt", "terminalExpiredAt", "authorPrincipalId", "content" } ], "latestSequence" }`。
- 越权 → `403`；run 不可见 → `404`。

### 内部路由（服务间，`Authorization: Bearer <service token>`）

**`GET /internal/v1/chat/runs/{runId}/guidance/pending`**

- 返回 `status=pending` 的条目（`sequence` 升序，全部），体：`{ "runId", "items": [ { "id", "sequence", "sourceKind", "content" } ] }`。
- Agent 侧以 `id` 做注入去重键；`sourceKind` 首版恒 `user`（预留位）。run 不存在 → `404`。

**`POST /internal/v1/chat/runs/{runId}/guidance/{guidanceId}/consume`**

- 语义：`pending → consumed`。请求体：`{ "consumedBy": "agent-runner" }`（预留，便于审计区分消费方）。
- `200`：`{ "id", "status": "consumed", "consumedAt", "firstConsumption" }`（首次或重复，幂等）。`firstConsumption` 仅在 `pending → consumed` 的胜者上为 `true`，重复 consume 恒为 `false`；并发 consume 由数据库行条件更新裁判，恰好一个请求得到 `true`。
- `409 GUIDANCE_ALREADY_TERMINAL_EXPIRED`：条目已 terminal_expired；Agent 收到此码 MUST 停止重试且不再注入。
- `404`：run/guidance 不存在。

### 日志与脱敏

- 任何日志只允许 `id/sequence/sourceKind/status/runId`；**禁止记录 `content`（body_markdown）原文**（不可信请求正文）。

### 与相邻机制边界

- 不复用 EventStore/Operation audit；不复用 Follow-up Queue 状态；不新增 SSE 事件类型（候选①）；不改变取消/审批/续跑端点。
- 续跑（0510）新 Run 读不到源 Run 的 pending Guidance（runId 隔离 + terminal 收敛）；已消费条目**不在**本表迁移。

## 恢复

- CP 启动 recovery/reconciliation 负责处理 lease 过期、审批等待和取消中断。
- `ambiguous` 表示无法证明 provider/Agent 是否已完成；只能使用新的 idempotency key 人工重试。
- UI 通过 ChatRun 响应视图与 `GET /api/v1/chat/sessions/{sessionId}/runs` 恢复，不从 Agent 内存推断成功。

## 验证映射

- 事实矩阵：PLAN-0387 `evidence/consumer-matrix.md`。
- Domain owner audit/retirement: PLAN-0462 and PLAN-0467; the historical Operation Ledger is not a runtime contract.
- 真实状态机、取消和 recovery：PLAN-0387 T3.1/V7；Follow-up Queue admission/recovery：PLAN-0442 evidence。
