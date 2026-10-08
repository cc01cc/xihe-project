# Agent Run 护栏总览

> 契约状态：`proposed`  
> 实现状态：`partial`  
> Profile：`architecture`  
> Owner：Agent owner（总览索引 owner；各领域规则仍由对应 canonical owner 唯一拥有）  
> 消费者：Agent、CP、Runtime、Security、UI、后续 XH PLAN  
> 来源：PLAN-0429、DEV-013  
> 更新日期：2026-10-08

## 范围

本文提供一次 Agent Run 相关护栏的分类、执行层、canonical owner、当前实现状态与停止/接管边界的跨域导航。领域细则以各 owner SPEC 与当前代码为准：本文不复制 Context、Security、ChatRun 或 Sandbox 的规则正文，不引入策略引擎、状态机或配置面，不创建新的策略裁决点。

状态沿用 `spec/README.md` 的两轴（契约状态、实现状态）。「已证实缺口」「触发式后置」等盘点结论只作为说明文字记录，不是状态枚举值，也不与本文件的注册状态混淆。

## 非目标

- 不确定任何具体运行阈值（最大迭代次数、token/费用上限、重复判定窗口、重规划次数）。
- 不修改 LangGraph 执行代码、CP/Runtime 数据模型、API、审批状态机或沙盒策略。
- 不替代或改写 `agent/execution.md`、`agent/context-tool.md`、`session/chat-run-operation.md`、`security/approval.md`、`workspace/sandbox-backend.md`、`workspace/execution-job.md` 的条款。

## 护栏分类与现状

| 风险/目标 | 执行层 | canonical owner | 实现状态（2026-10-03 M0 实证） | 必须区分 |
|---|---|---|---|---|
| 上下文超窗、历史与工具结果增长 | CP Context + Agent consumer | [Agent Context/Tool](./context-tool.md)、[Session 分支上下文隔离](../session/branch-context-isolation.md)；未来契约归 PLAN-0416（BL-50） | implemented（装配熔断、prune+tombstone、overflow 一次性重试、auto-compaction 均已接线） | 输入窗口预算 ≠ Agent Run 累计预算 |
| 单次工具超时与输出过大 | CP policy 下发 + Agent 执行 + Runtime Job | [Agent Context/Tool](./context-tool.md)、[Execution Job](../workspace/execution-job.md)、[Sandbox](../workspace/sandbox-backend.md)、[DEV-013](../../docs/i18n/zh-Hans/DEV-013-agent-architecture.md) | implemented（per-call timeout、bounded result、回传中段省略） | per-tool wait/output bound ≠ 轮数或累计预算 |
| Agent Run 循环持续、语义重复、无进展 | Agent Runner；副作用前仍须过授权/审批/幂等 | [Agent execution](./execution.md)（本文不新建 owner） | unimplemented（M0 证实：循环预算未接线、语义重复/无进展检测不存在；`toolCallId` 事件去重已实现但不阻止相同语义再次执行）；缺口登记见下节 | `toolCallId` 事件去重与历史消音 ≠ 语义重复执行防护 |
| 取消、失败、partial/ambiguous 与恢复 | CP ChatRun + MCP invocation + Agent stream | [Agent execution](./execution.md)、DEV-014 ChatRun lifecycle | implemented（cancel 全链路、幂等 409、recovery/reconciliation） | Agent 本地 `done` ≠ CP durable 终态；ChatRun 状态恢复 ≠ LangGraph 图状态恢复 |
| ChatRun 内 LangGraph 图状态 checkpoint/恢复 | Agent Runner | CP ChatRun terminal semantics（DEV-014；ambiguous + 人工新 key 重试） | unimplemented（无 checkpointer/thread_id，每 run 由全量历史重建）；触发式后置，登记为观察态条目 | ≠ Workspace Job 进程续跑；≠ 进程 Job 挂起/恢复（已裁定不做，见 backlog BL-24） |
| 授权、能力与人工审批 | CP/Security + Runtime capability | [Authorization](../security/authorization.md)、[Approval](../security/approval.md)、[Capability Boundary](../security/capability-boundary.md) | implemented（每个 MCP 工具调用过 gate，含 grant 复用与 user-direct 例外分支） | 模型计划不得扩大权限；允许执行 ≠ 本次操作已获批准 |
| 进程资源、隔离和清理 | Runtime backend | [Sandbox](../workspace/sandbox-backend.md)、[Execution Job](../workspace/execution-job.md) | partial（job 运行时限配置已交付；Docker 后端能力线后置） | 进程时限、请求等待、job 时限三者分开 |
| 事件、操作审计与敏感信息 | CP owner-domain history + Agent event adapter | [Audit](../security/audit.md)、[Event Stream](../protocol/event-stream.md) | implemented（owner-domain durable history、allowlisted event fields、paired audit projections） | 审计留痕 ≠ 把敏感原文当普通模型上下文 |
| 人类停止与运行中接管 | UI → CP → Agent cancel | stop 归 [Agent execution](./execution.md) 与 CP ChatRun terminal semantics（DEV-014）；排队 Follow-up 归 [ChatRun lifecycle](../session/chat-run-operation.md)；steering/Guidance 归 backlog BL-63 | partial（停止已接线；Run 中排队 Follow-up 经显式 Queue 动作入 durable 队列、Run 终态后 admission，队列未清空时普通发送按 409 `FOLLOW_UP_QUEUE_NOT_EMPTY` 拒绝；运行中纠偏 steering 未实现） | stop ≠ steering；预算耗尽/反复失败时的接管处置语义未定义 |
| 显式规划器的步数、进度与重规划预算 | 无生产者（计划工具未落地） | 计划工具目标态见归档 PLAN-0330 `spec/task-plan.md`；生产者缺口 = backlog P0-2 | unimplemented（`taskplan.*` 事件、表与投影为脚手架，无真实生产者与 UI 消费者） | 计划记录 ≠ 执行编排器（TaskPlan 不驱动调度） |

## 规范条款与不变式

1. Agent Run 限额 MUST NOT 替代授权、审批、沙盒、单次工具超时或 CP 的 ChatRun durable 终态；达到限额、反复失败或到达接管点时的停止/失败/接管语义由未来实现 PLAN 定义，本文 MUST NOT 预设阈值或新增 wire 状态。
2. 按 `toolCallId` 的事件去重/配对 MUST NOT 被表述为阻止相同语义操作再次执行；两者 MUST 分开陈述各自状态。
3. Context 输入窗口预算与 Agent Run 累计模型/工具/时间/费用预算是不同契约，MUST NOT 由同一 backlog 条目或同一 owner 条款承载。
4. ChatRun 内图状态 checkpoint/恢复、ExecutionJob 进程续跑、已裁定不做的进程 Job 挂起/恢复（BL-24）是三种不同语义，MUST 分别表述，MUST NOT 合并登记。
5. 只有产品真实存在显式规划器与持久计划生产者时，计划步数、计划进度与重规划限制才登记为实现债务；在此之前 MUST 只作为触发式候选说明。
6. 本文 MUST 只链接既有 owner 规则与实现状态；新增跨域策略条款 MUST 经对应 owner SPEC 的 PLAN 流程生效，MUST NOT 在本文直接产生裁决效力。

## 缺口与去向（2026-10-03 M0 盘点）

以下为盘点结论说明，不是状态枚举；backlog 条目以 XH 台账唯一登记点为准。

| 候选 | 结论 | 去向 |
|---|---|---|
| Agent Run 累计/循环预算 | 已证实缺口 | backlog BL-89（待立项；阈值与耗尽处置留立项裁定） |
| 语义重复/无进展检测 | 已证实缺口 | backlog BL-90（待立项；判定窗口与触发行为留立项裁定） |
| ChatRun 内 LangGraph 图状态 checkpoint/恢复 | 未接线已证实、需求未证实 → 触发式后置 | backlog BL-91（观察；与 ExecutionJob 续跑、BL-24 区分） |
| 计划执行预算/重规划上限 | 无生产者 → 触发式候选 | 已有登记 P0-2（PLAN-0330 后置），不新建 |
| 人类接管 | cancel 已接线；follow-up queue 已交付（PLAN-0442，2026-10-06，BL-63 仅关闭该子项）；steering/Guidance 仍归 BL-63；风险动作审批归 approval SPEC | 不新建；预算耗尽/反复失败的处置并入 BL-89 范围 |

以上编号以 XH backlog 台账唯一登记点为权威；本文只引用 ID，不复制条目正文。

## 验证映射

- 现状矩阵、搜索范围与归档去重证据：PLAN-0429 `evidence/m0-guardrail-matrix.md`。
- Agent/Session 域既有事实：PLAN-0387 `evidence/current-state.md`。
- 本文件与 `spec/README.md` 登记、`agent/execution.md` 导航同批维护；链接可解析性由 PLAN-0429 T3.1 链接检查验收。
