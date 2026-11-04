---
title: DEV-017 - Session 架构
category: dev-guide
lang: zh-Hans
sidebar_group: "开发指南"
status: active
sidebar_order: 17
created: 2026-09-03
updated: 2026-11-04
---

# DEV-017: Session 架构

> 面向前端与会话逻辑开发者：一页讲清状态归属、同步机制与嵌入约定。UI 实现细节见 DEV-010。
>
> Chat 与 Workspace 可以在同一工作界面协作，但领域依赖方向是 Workspace 独立存在、Session 可选绑定 Workspace。与 DEV-010 以"Session 领域 vs UI 实现"分界：状态归属、同步机制、嵌入约定归本文；路由表、组件树、传输层实现归 DEV-010。

### SPEC 指针

Session、ChatRun、MCP invocation 与 Runtime MCP session 的目标态生命周期边界见根级 SPEC：

- [`spec/session/chat-session.md`](../../../spec/session/chat-session.md)
- [`spec/session/chat-run-operation.md`](../../../spec/session/chat-run-operation.md)（Operation 部分已由 PLAN-0467 supersede，历史模型仅作迁移背景）
- [`spec/session/mcp-session.md`](../../../spec/session/mcp-session.md)
- [`spec/session/branch-context-isolation.md`](../../../spec/session/branch-context-isolation.md)（同一 Session 内的分支可见性与 cursor；PLAN-0410）
- [`spec/session/fork-and-branch-actions.md`](../../../spec/session/fork-and-branch-actions.md)（跨 Session fork、child seed 与幂等恢复；PLAN-0409）
- [`spec/session/derived-collaboration-inbox.md`](../../../spec/session/derived-collaboration-inbox.md)（parent Inbox terminal notice 生命周期；PLAN-0408）

这些文档不把三类生命周期合并，也不改变本 DEV 文档和 CP/Runtime 代码的当前事实源。

## 1. Session 领域模型

Session 是用户一次连贯工作上下文，独立于视图：

| 归属 | 约定 |
|------|------|
| Session/Message | 以 CP 服务端 API 为 canonical source；不落 localStorage，历史值不恢复 |
| 派生来源（PLAN-0407 M2 / PLAN-0630） | V37 保存 `spawned_from_session_id/run_id/spawned_at`；V40 用 `kind=spawn/fork` 区分权限 lineage。root 为全空 provenance；spawn 沿父 Agent Session 收敛权限/停止，fork 保留来源链接但作为独立权限根；**父会话删除后子会话不转独立 root**——spawn 链祖先缺失一律 fail-closed（`ancestor_missing`，PLAN-0630 D30-08），避免静默放大预算。PLAN-0407 T2.10 通过 CP-owned logical MCP `spawn_agent` caller 接入独立 grant/approval、waiting link 与 child dispatch；Agent 不直调 `/internal/v1/agents/spawn`。PLAN-0630 委派边仍只用上述既有列（不新增同义列，D30-01）；唤醒边另落 `chat_runs.parent_run_id`（V105），委托深度与唤醒深度由 `DelegationChainWalker` 在同一 walk 中现算、不落库 |
| Fork context seed（PLAN-0409/0410） | `session.forked` child root event 携带 selected branch/terminal anchor 前的 seed 消息与可选 SUM；child EventStore sequence 是 child-local cursor，parent 来源字段仅作 lineage，不参与 child 授权；Workspace L1 在 child Run 前刷新 |
| 派生协作通知（PLAN-0408） | child terminal 写入 parent Inbox 为 durable source；父 ChatRun 可在创建事务领取；UI 从 derived-state API 恢复，SSE 仅作 refresh hint；parent 删除不级联 child |
| 委派投影（UI，PLAN-0655/0659） | 会话树与委派 DAG 只消费既有投影：`sessions` 列表的 `kind=SPAWN` + `spawnedFromSessionId`（list 投影必须在 `normalizeSession` 透传 `kind`/`spawnedFromSessionId`/`spawnedAt`，`d880d705` 修复过丢失）、父会话 derived-state（子节点状态）、根会话 delegation-usage（预算/深度）。不新建持久化面、不改 wire；节点上限/截断/孤儿/环在 UI 显式化（DEV-010 §4.2） |
| 消息投递语义（UI，PLAN-0659） | `Message.delivery` 是 composer 发送态的**本地视图**（TO/CC 无持久载体，**BL-239**）：会话重载后丢失，`@` 由正文 + 花名册重建；不落 localStorage、不进 wire |
| Message | 属于 Session，由 `useChatStore` 按 `sessionId` 索引；生命周期（创建/流式/完成）走 chat store |
| Attachment | Session-scoped；后端 Session 专属空间持久化（`{base}/{sessionId}/` 下按 fileId 存取），`Message.attachments` 存元数据；workspace 对附件只读（文件本身经 workspace store 可写，见 DEV-010 §5） |
| File | 物理文件归 Runtime；Session 经 `fileContext` 存引用（workspaceFiles/activeFilePath） |
| 上下文 | `SessionContext{agents, ragContext?, mcpContext?, fileContext?}`；RAG/MCP 配置源为 `configStore` |

Workspace 是独立资源，可以在没有 Session 时创建、导入、浏览和编辑。Session 创建时可以绑定一个 Workspace；Session 内的 `fileContext` 只是对该 Workspace 文件的引用，不反向决定 Workspace 生命周期。

Chat 用 `sessionId`，Workspace 用 `workspaceId`，禁止互充（PLAN-222）。

状态机：Active（可交互）→ Archived（前端不加载，数据按服务端契约保留/清理）→ 删除（服务端 API）。

删除采用持久意图栅栏（V47 `sessions.delete_requested_at`，PLAN-0409 design #22）：DELETE 第一段在短锁 `copying` 预检同事务内落删除意图，其后的取消/job-close 副作用在锁外执行；意图在册期间，fork claim 与变更面（`lockCurrentForMutation`，含消息删除入口）返回 `409 SESSION_DELETING`，直至行物理删除。意图不可撤销（无 undo），中断后重试 DELETE 从该点续跑（可重入），无自动清扫；list/get/读消息等只读路径不受影响。

Session 的模型绑定 canonical 形态为 `modelProvider + modelName`；`modelId` 不再由 UI 写入或推断。刷新时按服务端 pair rehydrate，provider/model catalog 不可用时不创建本地有效 binding。

ChatRun 通过 `runId` 关联 Message，服务端返回的 `runStatus`、`terminalOutcome`、`errorCode` 和 `partial` 不能在刷新时被当作普通成功 assistant；`ambiguous` 需要人工确认后使用新的幂等键重试。

### 1.1 Agent principal 绑定（PLAN-0374）

- `sessions.agent_principal_id` 与 `agent_permissions_snapshot` 是 Agent 身份与 instance cap 的唯一来源；交互式 `POST /api/v1/sessions` 必须显式携带 `agentPrincipalId`，Chat admission 只接受已绑定 Session，无 lazy-create。
- `sessions.context_template_layer/id/version`（V48，PLAN-0414）是上下文模板的 Session 级钉住绑定：创建时解析或显式选择，`PATCH /api/v1/sessions/{sessionId}/context-template` 只改后续 Run；模型/Agent 字段更新不得扰动该绑定；admission 时整修订复制进 `chat_runs.context_template_snapshot`（在途不变）。配置域与解析优先级见 [DEV-014 §8f](DEV-014-control-plane-architecture.md)。
- principal-null 空 Session（附件占位/导入历史）首次 Chat 必须显式提交 principal：无 ChatRun、message、user-direct MCP invocation 或 tool ContextEvent 时由 row CAS 与 ChatRun/Message 同事务绑定；缺省 403、异 principal 409。
- `user_id` 仅表达 owner/visibility，不参与 Agent 授权；binding 缺失/撤销时 Agent 动作 fail-closed，历史 Session 保留。契约见 [`spec/agent/principal-workspace-binding.md`](../../../spec/agent/principal-workspace-binding.md)，wire 以 OpenAPI 为准。

### 1.2 Session 分支（PLAN-0410 / V43）

- 每个 Session 恰有一个 root `session_branches` 行（partial unique）；非 root 分支携带 `parent_branch_id` + `fork_point_message_id/run_id/sequence`（同 Session、同 parent branch 由 anchor composite FK 保证）。`messages`/`chat_runs`/`context_projections.branch_id NOT NULL`、`context_events.branch_id NULL`；读模型唯一键 `(session_id, projection_type, branch_id)`。
- 每个 ChatRun/Message 创建时由 CP 固化 branchId 且 Run 分支不可变；可见集 = Session/global 事件 ∪ 每层祖先段至 child `fork_point_sequence` ∪ 当前分支（cursor 仍是 Session 全局 sequence，不引入 per-branch 计数）。
- anchor 必须属于 terminal Run：`'USER'` 锚取该 Run 唯一 `prompt.admitted` sequence、`'ASSISTANT'` 锚取 Run 最大 correlated sequence；不可锚定（legacy 无 correlation/无 cursor）一律 409 fail-closed，不用 wall-clock 猜测。
- 同 Session **并发上限**（PLAN-0645 M0/M1）：非终态 run 达 `maxConcurrentRunsPerSession`（默认 2）才 `409 CHAT_IN_PROGRESS`，cap 内可并发；把该键设回 `1` 即回滚为原单飞行为；公开 `GET/POST /api/v1/sessions/{sessionId}/branches`、`GET /messages?branchId=`、`ChatRequest.branchId`、manual compact `branchId` 与 `409 BRANCH_LOCK` 归 **PLAN-0409**。UI path 选择按 Session 隔离；服务器仍按 V43/0410 可见性解析，不信任客户端 parent/anchor 推断。契约见 [`spec/session/branch-context-isolation.md`](../../../spec/session/branch-context-isolation.md)，内部 API 见 DEV-014 §8d。

### 1.3 Session Follow-up 队列（PLAN-0442 / V49）

- 队列是 Session 级 CP-owned durable 投影（V49 `session_follow_up_items`，FIFO 硬上限 5、计入 queued/paused/admitted 全部未结束项），item 行为唯一事实源；入队 API 返回 202 仅表示 durable 入队，child Run 在父 Run 终态后才 admission。
- 队列未清空时普通 `POST /api/v1/chat` 一律 `409 FOLLOW_UP_QUEUE_NOT_EMPTY`；Run 中排队必须走 UI 显式 Queue 动作，`CHAT_IN_PROGRESS` 不再是唯一出口。Session 删除意图期间队列变更与普通 Chat 均 `409 SESSION_DELETING`。
- 每 Session 至多一个 active child：admission 与 QueueItem 状态转换同事务原子落库；父/child Run 终态由 settlement 同事务推进（succeeded/partial/failed → 下一项自动接续，cancelled/ambiguous → 整队 `paused`），已 admission 的 cancelled/ambiguous child 不重放，`continue` 只放行其后项目。
- admission 前重验附件所有权、branch 可见性与 binding，失败即 `paused`（fail-closed）；CP 启动恢复暂停 admitted-without-child 并唤醒 queued head（幂等）。API/OpenAPI 见 DEV-014 与 `docs/api/openapi.yaml`；UI 面板见 [DEV-010](DEV-010-ui-architecture.md)。

## 2. Store 职责边界（选项 B：共享 + 视图分离）

- **useSessionStore**（`stores/session.ts`，跨 feature）：`sessions`、`currentSessionId`、`searchQuery`、附件本地视图、`fileContext`；独占 Session 的 UI-side 创建/删除/重命名与当前选择；`setFileContext`/`setSessionAgents`/`setRAGContext`/`setMCPContext`。CP 仍拥有 canonical Session/Message/ChatRun lifecycle 与 durable records。
- **useChatStore**（`features/workspace/chat/stores/chat.ts`，Workspace Chat UI 视图层）：按 Session 分组 `messages`、branch list/selected branch 与 `streamingMessageId`；`getMessages/addMessage/addMarker`；branch selector 是 UI path 状态，不是授权事实；流式三件套 `createStreamingMessage` / `replaceStreamingParts`（整量替换 MessagePart[]，PLAN-230）/ `finalizeStreaming`；不存 Session 元数据与 Agent/RAG/MCP 配置，也不拥有 CP durable lifecycle。
- **useWorkspaceStore**（`features/workspace/stores/workspace.ts`，Workspace feature 视图层）：`fileTree`、`expandedPaths`、`openFiles`、`activeFilePath`、`uploadQueue`；可选地通过 `syncActiveFileToSession()` 回写当前 Session 的文件上下文；不存 Session 元数据。没有当前 Session 时，Workspace 文件操作和 Workspace 事件订阅仍可工作，不能伪造 Session。文件变更操作（`renameNode/moveNode/duplicateNode/createDirectory`）返回 `Promise<boolean>`，调用方按结果分支 toast（禁假成功，PLAN-262 M1/B-2）；`refreshAfterMutation` 保持展开态；上传按 MIME 分派（文本 `write_file` MCP / 二进制 `POST /api/v1/files/upload`，PLAN-262 M0/B-3）。v1 无导入入口。

## 3. 跨 Store 同步

- **读**：视图组件与两视图 store 直接读 `useSessionStore`（`currentSessionId`、`currentSessionAttachments`、`currentSessionFileContext`），不缓存副本（禁多真相源）。
- **写**：Session 创建/删除/重命名只经 session store；附件上传入口在 `InputArea`（`uploadAttachments` → 后端），`sessionStore.addAttachment` 仅做内存本地视图（非权威）；`ChatPanel.handleSend` 只发消息 + 透传 fileIds；文件上下文只经 `syncActiveFileToSession`；Agent/RAG/MCP 上下文经 session store 专门方法。
- **不用事件总线**：Pinia 响应式即同步机制，直接读取即可。

## 4. 视图嵌入与切换约定

- `ChatPanel`（`features/workspace/chat/components/ChatPanel.vue`）是 Workspace Chat 的内嵌对话组件（消息列表 + 输入框 + SSEStream，无全屏布局头）；全屏 `ChatView` 已移除，不从其他 feature 直接嵌入 Chat UI。
- 视图切换约定：Workspace 是默认入口；Sidebar「New Chat」在当前 Workspace 通过 Agent principal picker 创建 Session；Workspace 路由可以没有 Session，选中后 route 为 `/workspace/:workspaceId/chat/:sessionId`。WorkspaceToolbar 的 Session 下拉切换 Session 时保留 Workspace route，不把 Workspace 切换误写成 Session 切换。
- 消息历史一律经 `chatStore.getMessages(sessionId)` 读取，跨视图一致；附件经 `currentSessionAttachments` 共享。
- 路由表与组件分层见 DEV-010 §1-2；SSE 传输层见 DEV-010 §4。

### 4.1 Workspace 级事件订阅

- Workspace 文件/状态事件按 `workspaceId` 订阅，不依赖 `sessionId`。
- Chat SSE 继续按 Session 承载 ChatRun；Workspace SSE 只承载状态和文件变化摘要。
- 文件内容、目录树和大数据继续走 HTTP；事件丢失通过 sequence gap 与 Workspace snapshot 补偿。
- 详细传输分层和 Runtime WebSocket 控制面见 PLAN-0350 / BL-43。

## 5. 开发约定与扩展

- 新增视图优先读 `useSessionStore`，不直接操作 chat store 的 Session 状态；文件上下文写入统一走 `syncActiveFileToSession`。
- 后续扩展（右侧面板拖拽宽、统一 `/session/:id` 路由评估、文件拖拽入 chat、多 Session 并列）另行 PLAN。
- **Checkpoint slice 不变量（PLAN-0653 P3）**：回滚句柄始终是 `sliceRef`（`refs/xihe/slices/<epoch>-<40hex>`），其中不携带任何文件内容；self 模式下 store 是读写主路径、shadow 仅作 best-effort 回切备份，Session/ChatRun 语义不感知存储模式（存储细节见 `DEV-015` §6.1）。

## 6. 会话多类型测试矩阵（PLAN-0658）

会话面涉及**多主体（人类/Agent）、多账户、多角色、投递与失败语义**，单元测试证明不了"组合起来还对"。本节是这套矩阵的**唯一入口**：跑什么、看什么、怎么判、哪些缺口以 `fixme` 挂账。

### 6.1 通道与文件

| 通道 | 文件 | 起栈 | 说明 |
|------|------|------|------|
| mock 交互矩阵（M1–M8） | `packages/ui/e2e/mock/session-matrix-*.spec.ts` | 仅 UI dev server | 交互 affordance + wire 形状；**不能**当真实链路证据 |
| real 数据面矩阵（R1–R3、R5–R9） | `packages/ui/e2e/real/session-matrix-*.spec.ts` | 隔离栈（e2e-host，27xxx 段） | 真 CP/Agent/Runtime + 隔离 PG + fake LLM |
| headed 走查（R4 等交互键位） | `packages/ui/e2e/headed/session-participants.spec.ts` | 隔离栈 + `--first-run=local --bootstrap-user=register` | Chrome Beta 有头、单窗口串行 |

一次跑完整 real 矩阵（`session-matrix` batch，8 个 spec）：

```powershell
node scripts/e2e-host.mjs --persistent --batch=session-matrix
$env:XIHE_E2E_EXTERNAL_SERVER='1'; node scripts/e2e-host.mjs --batch=session-matrix --retries=0
node scripts/e2e-host.mjs --teardown
```

**强制纪律**：跑 real spec 必须带 `--batch=<name>`（或 `--llm-mode=success`）。裸跑会把默认 llm-mode 导进实例 `llm-provider` 配置，栈会长期停在 `llmReady=model_unavailable`，`POST /chat` 恒 503 且不自愈（只能 teardown 重起）。

### 6.2 矩阵与判据（2026-11-04 实测）

| # | 维度 / 判据 | 断言面 | 文件 | 结果 |
|---|-------------|--------|------|------|
| R1 | 多人类账户（双账户互见 / 旁观者 / 外部账户） | wire + durable + UI | `session-matrix-multi-account.spec.ts` | 3 通 + **3 fixme**（BL-237 ×2、BL-238 ×1） |
| R2 | 发送与主体身份（selfOwned / 默认归属 / `as` / 越权 / 停用 / 发送→徽标） | wire + durable + UI | `session-matrix-to.spec.ts` | 6 通 |
| R3 | 三角色会话可见性（OWNER / EDITOR / VIEWER） | wire + UI | `session-matrix-roles.spec.ts` | 4 通 |
| R4 | `@` 提及候选面键盘（↑↓ / Enter / Tab / Esc + 真栈发送） | UI + wire | `headed/session-participants.spec.ts`（`R4@host`） | 1 通（headed） |
| R5 | 停用主体后的候选 / 成员行过滤 | UI | `session-matrix-disabled.spec.ts` | 3 通 |
| R6 | 并发排队（durable queue + 幂等重放 + 排水） | durable | `session-matrix-concurrency.spec.ts` | 2 通 |
| R7 | 失败终态（`ambiguous` + 稳定 `errorCode` + attempts 行 + 不产出正文） | durable | `session-matrix-failures.spec.ts` | 3 通 |
| R8 | 刷新恢复（BL-228 守护：消息恰好一条、run 终态、cc 草稿不复活） | durable + UI | `session-matrix-refresh.spec.ts` | 2 通 + 1 fixme（BL-237） |
| R9 | reasoning 三段同值（durable + UI 折叠 + 刷新后同值） | durable + UI | `session-matrix-reasoning.spec.ts` | 3 通 + 1 fixme（BL-197 ①，见 6.4） |

整批基线（e2e-host 干净库，merge `develop` 后）：**26 passed / 4 skipped / 0 failed**；同一批在常驻 stack-2（`xihe_2` 有历史数据）逐组一致 ⇒ 矩阵**不依赖干净库**。

### 6.3 渲染契约断言（与 PLAN-0659 共用，real 段回填）

身份一律认 `data-*`（`participantId` / `runId` / `depth`），**不认文案短码、不依赖时钟**。

| 断言 | real 段 | 状态 |
|------|---------|------|
| `process-row` 的 `data-process-kind` | 1/1 | ✅ |
| 单主体线程**不出现** `process-row-actor` | 1/1 | ✅（**但见 6.5：恒真，不构成正向证据**） |
| 单 run 会话**无** `run-header` | 1/1 | ✅ |
| `message-delivery-to` = `发送→<显示名>` | 1/1 | ✅（R2-6，真 composer 发送） |
| `message-delivery-mention` / `-cc`（R1） | 0 | ⏸ 不可达：R1 发送走 API，TO/CC 无持久载体（BL-239） |
| 混主体 `process-row-actor` **正例** | 0/1 | ⏸ **不成立**：`SessionMessage` 缺 `participantId`（BL-197 ①）⇒ `fixme` 挂账 |
| `delegation-node` / `delegation-edge` | — | N/A（本矩阵不触发委派） |

### 6.4 已挂账的产品缺口（不因"跑绿"而消失）

| 缺口 | 现象 | 矩阵里的处理 |
|------|------|--------------|
| BL-237 | 会话本体读面 owner-only（`SessionService.requireCurrent`），受邀人类参与者读不到 | R1-a2 / R1-e / R8-3 `fixme` |
| BL-238 | wake 用 owner 身份授权 → 人类参与者恒 `refused`，且内层事务 rollback-only | R1-b `fixme`（BL-214 `mention_count=0` 是其症状，不是独立缺陷） |
| BL-239 | TO/CC 是 composer 本地发送态视图，无持久载体 ⇒ 刷新后投递徽标消失 | 投递徽标断言只在发送后立刻做；R8-2 反向验证"刷新后不复活" |
| BL-197 ① | `SessionMessage` 无 `participantId` ⇒ 历史线程无法派生 actor 归因 | R9-4 正例 `fixme`，字段补齐后去 `.fixme` 即验收 |

### 6.5 判定纪律：负例通过必须自问"是不是恒真"

**这次实测的教训**：R9-2 的负例（单主体线程不出 `process-row-actor`）一直是绿的 —— 但在 `SessionMessage` 缺 `participantId` 期间它**恒真**（任何线程都不会渲染徽标），所以它当时的绿**不证明"单主体不刷身份"这个能力**。只有混主体**正例**（R9-4）才把这个缺口暴露出来。

因此：**负例通过必须能指出"正向能力在别处被证过"**，否则按"未验证"记录；涉及归因/角色的断言，正例与负例同批写、同批跑。

## 附录：RFC-001 历史设计（已退役）

RFC-001（PLAN-029 产出，PLAN-222 覆盖后 deprecated）定义了统一 Session 的初版领域模型与状态图，核心结论（服务端 canonical source、Session-scoped 附件、fileContext 引用）已并入正文；旧 `modelId` 三字段绑定已由 `modelProvider + modelName` canonical pair 取代。原文见 git 历史。
