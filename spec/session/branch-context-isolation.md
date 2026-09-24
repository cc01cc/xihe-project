# Session 分支上下文隔离

> 契约状态：`proposed`  
> 实现状态：`unimplemented`  
> Profile：`protocol`  
> Owner：CP Context + Agent Context owners（PLAN-0410）  
> 消费者：CP Chat/EventStore/Context、Agent Context、PLAN-0407、PLAN-0409  
> 来源：PLAN-0410  
> 更新日期：2026-09-24

## 范围

本规范定义同一 Chat Session 中分支路径对 CP 持久化事件、Context 投影、摘要/压缩及 Agent prompt 的可见性。Session 生命周期与 ChatRun/Operation 终态仍由 PLAN-0387 对应 SPEC 负责；User/Agent principal 与授权由 Security 负责；公开 fork/branch API、UI 和唯一真实浏览器验收由 PLAN-0409 负责。

## 核心不变式

1. 每个 Session 恰有一个 root branch；每个非 root branch 只属于一个 Session，且其 parent 必须属于同一 Session。
2. ChatRun 创建时由 CP 将 branchId 固化到 durable Run；Run 的 branchId 不可变。Message、run-scoped ContextEvent 和 ContextProjection 的 branch 归属必须与 Session 一致。
3. 给定 branch 的 Agent 输入只包含 Session/global facts、祖先路径中未被子 branch fork cursor 截断的 facts，以及当前 branch facts。兄弟 branch 与 cursor 之后的消息、工具结果、摘要、usage、prune tombstone 和 recovery/circuit 状态不可见。
4. Branch 只过滤上下文，不授予读取 Session、Workspace、Message、Attachment 或 Run 的权限；CP 必须继续执行既有 principal、owner 和 Workspace 授权。
5. Session-wide EventStore sequence 保持唯一事实源；branch path 通过 parent 与 cursor 过滤，不创建 per-branch sequence 或第二套 EventStore。

## Anchor 与 cursor

- Anchor 必须是当前 source branch path 中属于 terminal ChatRun 的 User 或 Assistant Message。未知、跨 Session、兄弟路径、legacy 无法映射或 active Run 的 Message 不得作为 anchor。
- User Message 的 cursor 是所属 Run 唯一的 `prompt.admitted` event sequence；Assistant Message 的 cursor 是所属 Run 最后一个 correlated ContextEvent sequence。CP 在同一持久化事务中校验并保存 Message、Run 与 cursor；缺少可信 cursor 时 fail-closed，不按时间猜测。
- 同 Session 的回退/编辑若需创建 branch，且存在 active ChatRun，返回 `409 BRANCH_LOCK`。跨 Session fork 由 PLAN-0409 执行：source Session 存在另一个 active Run 不阻止对更早 terminal anchor 的 fork，但 active Run 本身不是合法 anchor；快照不得包含 anchor cursor 之后写入的事件。

## EventStore 与投影

- Session/global events 的 `correlation_id` 与 `branch_id` 均为空，并按既定 taxonomy 对该 Session 所有 branch 可见。
- Run-scoped Agent events 必须携带 canonical `correlation_id=ChatRun.id`。CP 校验 Run 所属 Session 后派生 branchId；请求体不得覆盖 Session、Workspace、principal 或 branch 权威。未知 EventType 在登记分类前不得被默认视为 global。
- User-triggered manual compaction 经 CP 校验 branch 后写入 branch-scoped event，不伪造 ChatRun correlation；Run-triggered compaction 从 durable ChatRun.branchId 派生。
- ContextProjection 按 Session 和 branch 独立缓存及重建；`latestCompaction`、manual/automatic/overflow compaction、preflight、UsageAggregator、recovery-band、circuit 与 prune replay 必须使用同一 branch path。Session/global L1 与环境事实仅按明确 taxonomy 共享。
- Agent 只消费 CP 为当前 durable Run 解析的 snapshot。不得按 sessionId 重新读取整段历史覆盖 path filter。必需 ContextEvent append 或 snapshot 失败时必须可观测并使 Run 显式失败，禁止静默继续或回退到完整 Session history。

## 存量数据

- Fresh 与 upgrade migration 均须为每个 Session 创建唯一 root branch，并将既有 Message、ChatRun、ContextEvent 和 ContextProjection 归入 root；迁移前后数量、外键和唯一性必须可对账。
- 旧 Event 只有在 payload `runId` 与同 Session durable ChatRun 双验通过时才可补写关联。无法验证的 Event 仅作为 root baseline，不得充当 branch cursor；`Message.run_id=NULL` 的 legacy content 保留为共同 root baseline，不得作为 anchor。
- Session 的 create、import、attachment placeholder、User ledger、spawn 与 fork 等入口必须在 CP 中建立 root branch 或按契约完成绑定；实现前须由 PLAN-0410 M0 核实完整调用面。

## 实现映射

具体表字段、复合外键、索引、迁移版本、EventType taxonomy、internal payload、测试与验收命令以 PLAN-0410 `spec/branch-aware-context.md`、tasks 和 verify 为准。公开 route、branchId 请求契约及真实 UI 验收以 PLAN-0409 为准；本规范不替代 OpenAPI 或 Flyway。
