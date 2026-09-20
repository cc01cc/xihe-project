# ChatRun 与 Operation 生命周期

> 契约状态：`proposed`  
> 实现状态：`partial`  
> Profile：`lifecycle`  
> Owner：CP Chat/Operation owners  
> 消费者：Agent、Runtime、UI、Audit  
> 来源：PLAN-0385、PLAN-0387、DEV-014、DEV-017  
> 更新日期：2026-09-20

## 三类对象

| 对象 | 作用 | canonical owner |
|---|---|---|
| ChatRun | 一次用户 Chat submission 的执行与终态 | CP Chat |
| Operation | Chat/tool/job 等可审计通道事实的 durable root | CP Operation Ledger |
| Operation item/attempt/event | 工具调用、派发尝试和状态事件 | CP Operation Ledger |

ChatRun 与 Operation 有关联但不是同一对象；Operation 不能替代 ChatRun 终态，ChatRun 也不能替代工具通道事实。

## 关联与幂等

- ChatRun MUST 关联一个 `sessionId` 和一个 effective `workspaceId`。
- CP 创建 ChatRun 后创建/关联 Operation root，并传播 `runId`、`operationId`。
- ChatRun 的幂等键沿用 `(userId, sessionId, idempotencyKey)` 当前实现；principal 泛化由 Security/PLAN-0374 承接。
- 工具 item/attempt 使用 `toolCallId` 作为跨 Agent/CP/Runtime 关联键，禁止按事件时间或工具名启发式配对。

## 状态与终态所有权

ChatRun 当前可经过 `accepted`、`queued`、`running`、`streaming`、`awaiting_approval`、`cancelling` 等非终态；终态包括 `succeeded`、`failed`、`partial`、`ambiguous`、`cancelled`。具体 transition 以 CP entity/repository/service 为事实源。

1. ChatRun terminal outcome MUST 由 CP transition/settlement/recovery 路径落定。
2. Agent SSE `done`、晚到的 tool result 或 UI 本地关闭不得单独改写 durable terminal state。
3. 取消路径 MUST 让位于结算路径；取消窗口中的晚到副作用不能抢写已收口 item/run 终态。
4. 审批等待是 ChatRun/Operation 的中间状态，不是 authorization decision；拒绝/过期必须进入明确终态。
5. Operation audit MUST 保留 source、toolCallId、attempt 和错误/策略摘要，但不得持久化原始 secret/arguments。

## 恢复

- CP 启动 recovery/reconciliation 负责处理 lease 过期、审批等待和取消中断。
- `ambiguous` 表示无法证明 provider/Agent 是否已完成；只能使用新的 idempotency key 人工重试。
- UI 通过 ChatRun/Operation projection 恢复，不从 Agent 内存推断成功。

## 验证映射

- 事实矩阵：PLAN-0387 `evidence/consumer-matrix.md`。
- Operation Ledger owner：PLAN-0385 `spec/data/operation-ledger.md`。
- 真实状态机、取消和 recovery：PLAN-0387 T3.1/V7，尚未完成。
