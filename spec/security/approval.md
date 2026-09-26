# XH 审批契约

> 契约状态：`proposed`；实现状态：`partial`；Profile：`security`；Owner：CP/Security；来源：PLAN-0386、DEV-014、PLAN-0407 spec §9（ask 清单补录）；更新：2026-09-27。

## 1. 请求身份

Approval request 绑定 `requestId`、`runId`、`sessionId`、`userId`、`workspaceId`、tool、受限长度的 action/details、可选 arguments hash、origin 和 expiry。CP **MUST** 在创建或 replay row 前拒绝身份不匹配。

Origins are `cp_gate` and `agent_relay`; they are not interchangeable audit labels.

## 2. 状态与决策

**触发源（PLAN-0407 [d19]）**：approval 的问 = approval-policy 的 `askActionClasses[]` 要问清单——actionClass 在册且 `mode=manual` → 建 pending 进入审批；在册且 `mode=auto` → 放行并记 `allowed_by`；不在册 → 授权（grants 查表）过后直过。未分类工具仍须显式分类。policy rules 分层裁决已退役，不再触发或抑制审批（PLAN-0407 T2.8）。

Pending/replayable 状态包括 `pending`、`dispatching` 和 `dispatch_unknown`；终态决策按当前 entity state machine 包括 approved/rejected/expired。只有 tool face 和 policy 允许时，决策才能使用 `once`、`session`、`saved` 或 `reject_always` 复用等级。

- `once` grants one exact operation.
- `session` requires exact arguments hash, mode, policy revision and sandbox generation.
- `saved` materializes a persistent allow rule in an authorized layer.
- `reject_always` materializes a persistent deny rule where permitted.

`saved`/`reject_always` 物化的规则行仍由审批复用存储写入并推进 `policy_revision`（失效源保留）；该行**不再参与授权裁决**——粘性 allow/deny 不改判后续门禁（PLAN-0407 T2.8 行为翻转，见 `evidence/t2-8-rules-retirement.md` §5）。

## 3. 规则

- Approval 对 expired、unknown、身份不匹配、未分类或 capability 不支持的请求 **MUST** fail-closed。
- `dispatch_unknown` 表示可重试的不确定状态，绝不表示静默批准。
- 终态 approval row **MUST NOT** 因迟到 decision/event 回退。
- Raw arguments、credentials 和 file content **MUST NOT** 进入 approval payload 或 audit log；只能保留受限 details 和 hash。
- Approval 与 authorization、capability policy 分离；正向决策不能覆盖其中任何一层。
