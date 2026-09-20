# XH 审批契约

> 契约状态：`proposed`；实现状态：`partial`；Profile：`security`；Owner：CP/Security；来源：PLAN-0386、DEV-014；更新：2026-09-20。

## 1. 请求身份

Approval request 绑定 `requestId`、`runId`、`sessionId`、`userId`、`workspaceId`、tool、受限长度的 action/details、可选 arguments hash、origin 和 expiry。CP **MUST** 在创建或 replay row 前拒绝身份不匹配。

Origins are `cp_gate` and `agent_relay`; they are not interchangeable audit labels.

## 2. 状态与决策

Pending/replayable 状态包括 `pending`、`dispatching` 和 `dispatch_unknown`；终态决策按当前 entity state machine 包括 approved/rejected/expired。只有 tool face 和 policy 允许时，决策才能使用 `once`、`session`、`saved` 或 `reject_always` 复用等级。

- `once` grants one exact operation.
- `session` requires exact arguments hash, mode, policy revision and sandbox generation.
- `saved` materializes a persistent allow rule in an authorized layer.
- `reject_always` materializes a persistent deny rule where permitted.

## 3. 规则

- Approval 对 expired、unknown、身份不匹配、未分类或 capability 不支持的请求 **MUST** fail-closed。
- `dispatch_unknown` 表示可重试的不确定状态，绝不表示静默批准。
- 终态 approval row **MUST NOT** 因迟到 decision/event 回退。
- Raw arguments、credentials 和 file content **MUST NOT** 进入 approval payload 或 audit log；只能保留受限 details 和 hash。
- Approval 与 authorization、capability policy 分离；正向决策不能覆盖其中任何一层。
