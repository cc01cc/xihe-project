# ChatRun 与 Operation 生命周期

> 契约状态：`proposed`  
> 实现状态：`partial`  
> Profile：`lifecycle`  
> Owner：CP Chat/Operation owners  
> 消费者：Agent、Runtime、UI、Audit  
> 来源：PLAN-0385、PLAN-0387、PLAN-0442、DEV-014、DEV-017
> 更新日期：2026-10-06

## 三类对象

| 对象 | 作用 | canonical owner |
|---|---|---|
| ChatRun | 一次用户 Chat submission 或 CP 内部 spawn 派生执行与终态 | CP Chat |
| Operation | Chat/tool/job 等可审计通道事实的 durable root | CP Operation Ledger |
| Operation item/attempt/event | 工具调用、派发尝试和状态事件 | CP Operation Ledger |

ChatRun 与 Operation 有关联但不是同一对象；Operation 不能替代 ChatRun 终态，ChatRun 也不能替代工具通道事实。

## 关联与幂等

- ChatRun MUST 关联一个 `sessionId` 和一个 effective `workspaceId`。
- CP 创建 ChatRun 后创建/关联 Operation root，并传播 `runId`、`operationId`。
- User submission 的幂等键沿用 `(userId, sessionId, idempotencyKey)` 当前实现；spawn 另按 V39 的父 durable event key 全局防重；principal 泛化由 Security/PLAN-0374 承接。
- `origin` 是持久化来源标签：`user_submission` / `spawn`。公开 `POST /api/v1/chat` 恒为 `user_submission`，请求体不得控制该字段。
- CP 内部 `spawn_agent` 创建不经过浏览器 SSE subscription gate。其 `spawnEventId` 复用父 run 下持久化 Agent `spawn_agent` tool_call 的 `operation_items.id`（canonical UUID），并作为 child ChatRun 的 `idempotency_key`；同事件+同 request hash 返回既有 run，不同 hash 冲突。V39 以 `(user_id, idempotency_key) WHERE origin='spawn'` 唯一索引防并发重复；重试复用父账本行身份。生产 Agent caller / authenticated internal entrypoint 由 PLAN-0407 T2.10（grant gate 启用后）接线。
- Internal spawn 必须校验父 run、父 OperationItem 与 child Session 的 user/workspace/parent provenance 一致；只有子会话派生首条 run 使用 spawn，子会话后续用户输入仍走现有 `/api/v1/chat` 门禁。
- Spawn 不接受调用方自行提交的 attachment JSON；CP 根据 File 表重建只读摘要并把规范化 fileId 纳入 request hash。附件必须归 child Session 所有，不隐式共享 parent Session 的 fileId；跨 Session 携带文件须走 fork 的显式复制或未来显式授权路径。
- 工具 item/attempt 使用 `toolCallId` 作为跨 Agent/CP/Runtime 关联键，禁止按事件时间或工具名启发式配对。

## 状态与终态所有权

ChatRun 当前可经过 `accepted`、`queued`、`running`、`streaming`、`awaiting_approval`、`cancelling` 等非终态；终态包括 `succeeded`、`failed`、`partial`、`ambiguous`、`cancelled`。具体 transition 以 CP entity/repository/service 为事实源。

1. ChatRun terminal outcome MUST 由 CP transition/settlement/recovery 路径落定。
2. Agent SSE `done`、晚到的 tool result 或 UI 本地关闭不得单独改写 durable terminal state。
3. 取消路径 MUST 让位于结算路径；取消窗口中的晚到副作用不能抢写已收口 item/run 终态。
4. 审批等待是 ChatRun/Operation 的中间状态，不是 authorization decision；拒绝/过期必须进入明确终态。
5. Operation audit MUST 保留 source、toolCallId、attempt 和错误/策略摘要，但不得持久化原始 secret/arguments。

## Follow-up 队列（PLAN-0442）

- 队列是 CP-owned 的 durable 投影（V49 `session_follow_up_items`），不是 ChatRun；item 行是队列事实源，SSE/snapshot 只作刷新提示。
- 入队（`POST /api/v1/sessions/{sessionId}/follow-ups`，`Idempotency-Key` 必带）返回 202 = durable 入队，不代表 child Run 已创建；普通 `POST /api/v1/chat` 在队列未清空时 MUST 409 `FOLLOW_UP_QUEUE_NOT_EMPTY`，Run 中排队必须走显式 Queue 动作。
- 每 Session 至多一个 active child：`admitHead` 先锁 Session 行再锁 item 行，QueueItem 状态转换与 child ChatRun/Message/Operation 在同一 REQUIRES_NEW 事务写入，失败整体回滚；claim 与 withdraw 并发时至多一方转换成功，已 claim 后撤回返回 409 `FOLLOW_UP_ALREADY_ADMITTED`。
- 父/child Run 进入终态由既有 settlement 路径同事务推进队列：succeeded/partial/failed → consumed child `completed` 并推进下一项；cancelled/ambiguous → 整队 `paused`（`parent_cancelled`/`child_cancelled`/`child_ambiguous`）。已 admission 的 cancelled/ambiguous child MUST NOT 重放；继续（`POST .../continue`）把已消耗 child 收敛为 `completed`，只放行其后项目。
- admission 前重验附件所有权、branch 可见性与 binding，失败置 `paused`（如 `attachment_unavailable`）而非切换分支或放行。
- Session 删除意图期间队列变更与普通 Chat 均 MUST 409 `SESSION_DELETING`；CP 启动恢复暂停 admitted-without-child 项并唤醒 queued head（幂等）。
- PLAN-0442 V1 runtime constraint: deployments using Follow-up MUST run exactly one active CP instance. The after-commit wake is process-local and startup recovery only runs on application startup; this is not cross-instance durable delivery. Multi-instance Follow-up support requires a separately approved design and verification before scaling CP.

## 恢复

- CP 启动 recovery/reconciliation 负责处理 lease 过期、审批等待和取消中断。
- `ambiguous` 表示无法证明 provider/Agent 是否已完成；只能使用新的 idempotency key 人工重试。
- UI 通过 ChatRun/Operation 响应视图恢复，不从 Agent 内存推断成功。

## 验证映射

- 事实矩阵：PLAN-0387 `evidence/consumer-matrix.md`。
- Operation Ledger owner：PLAN-0385 `spec/data/operation-ledger.md`。
- 真实状态机、取消和 recovery：PLAN-0387 T3.1/V7，尚未完成。
