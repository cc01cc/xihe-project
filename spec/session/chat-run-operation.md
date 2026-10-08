# ChatRun 与 Session Follow-up 生命周期

> 契约状态：`proposed`
>
> 实现状态：`partial`
>
> Profile：`lifecycle`
>
> Owner：CP ChatRun + Follow-up Queue domains
>
> 消费者：Agent、Runtime、UI、Audit
> 来源：PLAN-0387、PLAN-0442、PLAN-0463–0467、DEV-014、DEV-017
> 更新日期：2026-10-08

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

## 恢复

- CP 启动 recovery/reconciliation 负责处理 lease 过期、审批等待和取消中断。
- `ambiguous` 表示无法证明 provider/Agent 是否已完成；只能使用新的 idempotency key 人工重试。
- UI 通过 ChatRun 响应视图与 `GET /api/v1/chat/sessions/{sessionId}/runs` 恢复，不从 Agent 内存推断成功。

## 验证映射

- 事实矩阵：PLAN-0387 `evidence/consumer-matrix.md`。
- Domain owner audit/retirement: PLAN-0462 and PLAN-0467; the historical Operation Ledger is not a runtime contract.
- 真实状态机、取消和 recovery：PLAN-0387 T3.1/V7；Follow-up Queue admission/recovery：PLAN-0442 evidence。
