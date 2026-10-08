# ChatRun 与 Operation 生命周期（历史规范）

> 契约状态：`superseded`；实现状态：`partial`；Profile：`historical`；Owner：退休的 CP Operation Ledger owner；消费者：仅历史设计回溯；退役：PLAN-0467 / Flyway V55（2026-10-08）

> 本文件把 ChatRun 与跨域 Operation 聚合在一个生命周期模型中，已不再是当前契约。Session/ChatRun 现行边界见 [`chat-session.md`](chat-session.md)；MCP 调用事实由 MCP invocation 域持有；Workspace Job 见 [`../workspace/execution-job.md`](../workspace/execution-job.md)；API/wire 以 DEV-014、DEV-015、OpenAPI 和 inventory 为准。以下正文仅作旧设计记录，不得用于实现新调用方。

## 三类对象

| 对象 | 作用 | canonical owner |
|---|---|---|
| ChatRun | 一次用户 Chat submission 或 CP 内部 spawn 派生执行与终态；**Chat 生命周期的唯一根（PLAN-0464）** | CP Chat |
| Operation | tool/job 等可审计通道事实的 durable root；**不再有 `kind=chat` root** | CP Operation Ledger |
| Operation item/attempt/event | 工具调用、派发尝试和状态事件（0466 审计视图 / 0467 退役） | CP Operation Ledger |
| mcp_invocations / mcp_attempts / mcp_dispatch_history | Agent 工具调用的执行域事实（gate 建行、relay attempt、流转历史） | CP MCP execution domain |
| chat_run_history | ChatRun 状态流转的 append-only 历史（terminal/cancel/recovery/restore 四写入方） | CP Chat |

ChatRun 与 Operation 有关联但不是同一对象；Operation 不能替代 ChatRun 终态，ChatRun 也不能替代工具通道事实。

## 关联与幂等

- ChatRun MUST 关联一个 `sessionId` 和一个 effective `workspaceId`。
- **CP 创建 ChatRun 不再创建/关联 Operation root，响应体不再传播 `operationId`（PLAN-0464 T1.1）**；admission 冲突由 `chat_runs` 唯一索引映射为 409。
- User submission 的幂等键沿用 `(userId, sessionId, idempotencyKey)` 当前实现；spawn 另按 V39 的父 durable event key 全局防重；principal 泛化由 Security/PLAN-0374 承接。
- `origin` 是持久化来源标签：`user_submission` / `spawn`。公开 `POST /api/v1/chat` 恒为 `user_submission`，请求体不得控制该字段。
- CP 内部 `spawn_agent` 创建不经过浏览器 SSE subscription gate。其 spawn event key = 父 run 下 `spawn_agent` 的 canonical `toolCallId`（PLAN-0464 T2.1；旧 `operation_items.id` 身份退役），并作为 child ChatRun 的 `idempotency_key`；同事件+同 request hash 返回既有 run，不同 hash 冲突。V39 以 `(user_id, idempotency_key) WHERE origin='spawn'` 唯一索引防并发重复。
- Internal spawn MUST 校验父 run、父 `mcp_invocations(source=agent)` 行与 child Session 的 user/workspace/parent provenance 一致；child run 行记录 waiting link（`waiting_on_run_id`/`waiting_tool_call_id`，V50 无回填，pre-V50 子 run 按 legacy 处理、不阻断终态）；只有子会话派生首条 run 使用 spawn，子会话后续用户输入仍走现有 `/api/v1/chat` 门禁。
- Spawn 不接受调用方自行提交的 attachment JSON；CP 根据 File 表重建只读摘要并把规范化 fileId 纳入 request hash。附件必须归 child Session 所有，不隐式共享 parent Session 的 fileId；跨 Session 携带文件须走 fork 的显式复制或未来显式授权路径。
- 工具关联使用 `toolCallId` 作为跨 Agent/CP/Runtime 关联键，禁止按事件时间或工具名启发式配对。

## 状态与终态所有权

ChatRun 当前可经过 `accepted`、`queued`、`running`、`streaming`、`awaiting_approval`、`cancelling` 等非终态；终态包括 `succeeded`、`failed`、`partial`、`ambiguous`、`cancelled`。具体 transition 以 CP entity/repository/service 为事实源。

1. ChatRun terminal outcome MUST 由 CP transition/settlement/recovery 路径落定（`ChatRunTerminalService`），并同步写 `chat_run_history`。
2. Agent SSE `done`、晚到的 tool result 或 UI 本地关闭不得单独改写 durable terminal state。
3. 取消路径 MUST 让位于结算路径；取消窗口中的晚到副作用不能抢写已收口 item/run 终态。
4. 审批等待是 ChatRun 的中间状态，不是 authorization decision；拒绝/过期必须进入明确终态。
5. Operation audit MUST 保留 source、toolCallId、attempt 和错误/策略摘要，但不得持久化原始 secret/arguments。
6. `llm.usage` ContextEvent 由终态从 relay 内存 usage payload 直写（无 usageData ⇒ 不写事件）；run 终态事务后 best-effort 触发 `closeRunScope` 并对账仍 `active` 的 agent invocation。

## 恢复

- CP 启动 recovery/reconciliation 负责处理 lease 过期、审批等待和取消中断。
- `ambiguous` 表示无法证明 provider/Agent 是否已完成；只能使用新的 idempotency key 人工重试。
- UI 通过 ChatRun 响应视图与 `GET /api/v1/chat/sessions/{sessionId}/runs` 恢复，不从 Agent 内存推断成功。

## 验证映射

- 事实矩阵：PLAN-0387 `evidence/consumer-matrix.md`。
- Operation Ledger owner：PLAN-0385 `spec/data/operation-ledger.md`（0467 退役路径）。
- 真实状态机、取消和 recovery：PLAN-0387 T3.1/V7，尚未完成。
