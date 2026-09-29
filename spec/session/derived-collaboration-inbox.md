# Session SPEC：派生协作 Inbox 生命周期

> 契约状态：`proposed`  
> 实现状态：`partial`  
> Profile：`lifecycle`  
> Owner：CP Chat/Operation  
> 消费者：Agent、CP、UI  
> 来源：PLAN-0408  
> 更新日期：2026-09-28

## 范围

本规范冻结子 ChatRun terminal 结果向 parent Session 投影的最小 durable Inbox 生命周期。API DTO 以 OpenAPI 为准；用户旅程和实现验收见 PLAN-0408。不得修改 PLAN-0387 当前 Owner 的 Session 生命周期 SPEC。

## 数据关系

- 一条 Inbox 行属于唯一 `to_session_id`（parent Session），引用一个 terminal child ChatRun。
- `type='child_terminal'`，`ref=childRunId`，唯一键为 `(to_session_id,type,ref)`。
- `payload_pointer` 只允许 `{sessionId,runId,state}`；内容和 child name 不在 Inbox 中。
- `injected_run_id` 为 NULL 或一个父 ChatRun ID；领取后不自动转投。
- Inbox 不拥有、不级联删除 child Session 或 ChatRun。

## 写入与删除

- CP 唯一 terminal CAS 在同一数据库事务中提交 ChatRun terminal status/`terminal_at`；仅 parent 存在且 OperationItem/waiting link 一致时，同事务收口 parent item 并 upsert Inbox。
- parent 缺失时走 child-local 分支，不写 parent/Inbox，并记录 `derived_parent_missing` diagnostic；不自动重试。
- parent 存在但 parent OperationItem 缺失或 `waiting_on_run_id` 不匹配时，整笔 terminal transaction rollback 并记录一致性 diagnostic；修复关联后显式重试。
- 重复 terminal CAS 由条件 CAS 与唯一键保证至多一条 Inbox 行。锁序服从 0407/0408 Session-first 契约，每个账本域先锁 LedgerOperation，再锁 OperationItem，Inbox business key 最后。
- parent 删除清理其 Inbox 行；child Session/ChatRun 生命周期保持独立，不得级联删除。

## 领取与恢复

- 父 ChatRun 创建事务锁定尚未注入的 Inbox 行，并原子写入 `injected_run_id`。
- Idempotency replay 复用原 Run/claim；创建事务 rollback 保留 pending 状态。
- Run commit 后 dispatch 失败或 Agent crash 不会自动转投新 Run；本机制不承诺 Exactly-once。
- 客户端恢复只读取父 Session `GET /api/v1/sessions/{sessionId}/derived-state`；active child 来自 provenance + ChatRun，terminal notice 来自 Inbox。
- Session `derived_state_changed` SSE 只作 refresh hint，不是持久状态或恢复源；事件契约见 [`../protocol/event-stream.md`](../protocol/event-stream.md)。
