# XH 审批契约

> 契约状态：`proposed`；实现状态：`partial`；Profile：`security`；Owner：CP/Security；来源：PLAN-0386、DEV-014、PLAN-0407 spec §9（ask 清单补录）、PLAN-0464 T1.5；更新：2026-10-06。
> 消费者：CP approval gate、Agent approval relay、UI approval modal、Audit

## 1. 请求身份

Approval request 绑定 `requestId`、`runId`、`sessionId`、`userId`、`workspaceId`、tool、受限长度的 action/details、可选 arguments hash、origin 和 expiry。CP **MUST** 在创建或 replay row 前拒绝身份不匹配。

Origins are `cp_gate` and `agent_relay`; they are not interchangeable audit labels.

审批状态流转的事实源是 `approval_requests` 行；`approval_history`（V51）是 append-only 的 `requested → dispatching → decided / expired / dispatch_unknown` 历史，由 `ApprovalService` 在同一审批域事务内写入。`ApprovalPendingStore` 的隔离事务已改为与调用方同事务（PLAN-0464 T1.5）：approval row、policy summary 与 history 必须一起提交或一起回滚。八处旧 Operation-ledger 写点已全部退役。

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

## 4. 重启后的审批对齐（proposed，task-109 / F-28）

> 本节是 `proposed` 目标态契约，不代表当前实现已完成。来源：task-109；现状证据与时序见 `internal/A03-xihe/evidence/2026-11-19-task109-approval-restart/README.md`。Owner：CP/Security；消费者：CP 恢复/对账服务、Agent approval relay、UI。

### 4.1 三态判据（互斥且穷尽）

CP 启动时对「非终态 run 且存在 pending/dispatching/dispatch_unknown 审批行」的记录逐条对齐。每条记录必须落入且仅落入一态：

| 状态 | 判据（全部满足） | 用户可见结果 | 允许动作 |
|---|---|---|---|
| `resolved` | ① CP 侧该 requestId 有**终态决策**（approved/rejected/expired，含幂等终态回放）；② Agent 侧回执为 `200/accepted`（`already_decided` 仅在 CP 终态与之一致时可接受）；③ runId/sessionId/userId/workspaceId 与审批行一致，且 arguments hash 校验通过 | 恢复展示真实决策；可继续原 run 或按既有规则重新发起 | 不重放决策、不重复 gate、不改写终态行 |
| `orphaned` | ① CP 侧存在审批行或终态决策，但 run 已是终态，**或** Agent `GET /internal/v1/agent/approval/pending` 明确返回 `404/NOT_FOUND`（该 requestId 确实无 waiter）；② 探针本身可达且查询成功（非超时/异常/网关错误） | 「这次审批不会有结果，请重新发起」 | 提示用户重新发起；不得自动批准/拒绝；终态 run 连坐的 pending 行按既有 `expirePendingForTerminalRun` 收敛为 expired，记录 history 与日志 |
| `unrecoverable` | ① run 已死/不可恢复（终态或租约与状态不一致且无活跃进程），且② CP 侧缺失决策或决策无法验证（无终态行、arguments 不匹配、身份漂移、expiry 已过且无有效决策）；Agent 探针不能给出确定结论时也不能降级为 resolved | 「这次审批不会有结果，请重新发起」 | 只允许重新发起或显式拒绝；禁止自动批准/拒绝；写入可审计日志（检查条数、逐条判定、原因码） |

「假已恢复」判据（必须写死）：**仅有 CP 侧的 `awaiting_approval` 状态或 live approval 行不足以判 resolved**。若没有 Agent 回执双证据，或 CP 推送失败仅 WARN 后仍 `markDecided`（`ApprovalService.java:539-559` 的 cp_gate 路径），重启后必须判 `orphaned`/`unrecoverable`，不得恢复成 `awaiting_approval`、不得展示「等待审批」、不得让 UI 认为模型还在等待回执。

### 4.2 对齐探测与失败语义

- CP 恢复路径 **MUST** 在改 run 状态前调用现成探针 `GET /internal/v1/agent/approval/pending`（`ApprovalAgentClient.java:83-93`）核对 requestId 是否在 Agent 侧仍为等待；无此调用即视为现状缺口。
- **探针端点自身不可用**（路由 404、超时、异常、非 2xx 网关错误）一律映射 `AGENT_UNAVAILABLE`，**不得**据此判 `orphaned`；该请求保持 `unrecoverable`（或延迟到下一轮对账重试），并记录探测失败原因。只有探针**可达且查询成功**、返回中明确给出「该 requestId 不在 Agent pending 集合」这一业务事实，才进入 `orphaned` 判定。
- 对具体 requestId 的 `404/APPROVAL_NOT_FOUND` 才可作为「Agent 侧无 waiter」的业务事实；`409/APPROVAL_DECISION_CONFLICT`、`410/APPROVAL_EXPIRED` 按 CP 侧终态行交叉核验，一致才进入 resolved/orphaned。
- `ChatRunReconciliationService.java` 在 600s 宽限 + 300s 周期后把卡住的 `awaiting_approval` 收敛为 `ambiguous/CP_RESTARTED`，这只是**兜底收敛**，不是恢复语义；不得用它替代 4.1 的三态对齐，也不得在宽限期内把不可验证记录展示成真实 `awaiting_approval`。

### 4.3 Hard rules

- **禁止超时自动批准或自动拒绝**：任何超时、不可达、缺证据都只能落入 `unrecoverable` 或延迟重试，不得合成决策。
- 终态 approval row **MUST NOT** 因迟到 decision/event 回退；重复 gate / replay 队列项在行非 `dispatching` 时必须 `skipped`，不重复执行。
- 每次启动对齐必须输出退出读数：检查条数、逐条判定（resolved/orphaned/unrecoverable）、每条原因码；无日志即视为未完成对齐。
- 用户可见文案固定为「这次审批不会有结果，请重新发起」，不伪装成仍在等待。
