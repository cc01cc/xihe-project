---
title: DEV-017 - Session 架构
category: dev-guide
lang: zh-Hans
sidebar_group: "开发指南"
status: active
sidebar_order: 17
created: 2026-09-03
updated: 2026-09-25
---

# DEV-017: Session 架构

> 面向前端与会话逻辑开发者：一页讲清状态归属、同步机制与嵌入约定。UI 实现细节见 DEV-010。
>
> Chat 与 Workspace 可以在同一工作界面协作，但领域依赖方向是 Workspace 独立存在、Session 可选绑定 Workspace。与 DEV-010 以"Session 领域 vs UI 实现"分界：状态归属、同步机制、嵌入约定归本文；路由表、组件树、传输层实现归 DEV-010。

### SPEC 指针

Session、ChatRun/Operation 和 Runtime MCP session 的目标态生命周期边界见根级 proposed SPEC：

- [`spec/session/chat-session.md`](../../../spec/session/chat-session.md)
- [`spec/session/chat-run-operation.md`](../../../spec/session/chat-run-operation.md)
- [`spec/session/mcp-session.md`](../../../spec/session/mcp-session.md)

这些文档不把三类生命周期合并，也不改变本 DEV 文档和 CP/Runtime 代码的当前事实源。

## 1. Session 领域模型

Session 是用户一次连贯工作上下文，独立于视图：

| 归属 | 约定 |
|------|------|
| Session/Message | 以 CP 服务端 API 为 canonical source；不落 localStorage，历史值不恢复 |
| 派生来源（PLAN-0407 M2） | V37 保存 `spawned_from_session_id/run_id/spawned_at`；V40 用 `kind=spawn/fork` 区分权限 lineage。root 为全空 provenance；spawn 沿父 Agent Session 收敛权限/停止，fork 保留来源链接但作为独立权限根；删除父后子转独立 root（T2.5）。生产 `spawn_agent` caller 及 grant 写入仍由 PLAN-0407 T2.10 落地，当前尚未启用 |
| Message | 属于 Session，由 `useChatStore` 按 `sessionId` 索引；生命周期（创建/流式/完成）走 chat store |
| Attachment | Session-scoped；后端 Session 专属空间持久化（`{base}/{sessionId}/` 下按 fileId 存取），`Message.attachments` 存元数据；workspace 对附件只读（文件本身经 workspace store 可写，见 DEV-010 §5） |
| File | 物理文件归 Runtime；Session 经 `fileContext` 存引用（workspaceFiles/activeFilePath） |
| 上下文 | `SessionContext{agents, ragContext?, mcpContext?, fileContext?}`；RAG/MCP 配置源为 `configStore` |

Workspace 是独立资源，可以在没有 Session 时创建、导入、浏览和编辑。Session 创建时可以绑定一个 Workspace；Session 内的 `fileContext` 只是对该 Workspace 文件的引用，不反向决定 Workspace 生命周期。

Chat 用 `sessionId`，Workspace 用 `workspaceId`，禁止互充（PLAN-222）。

状态机：Active（可交互）→ Archived（前端不加载，数据按服务端契约保留/清理）→ 删除（服务端 API）。

Session 的模型绑定 canonical 形态为 `modelProvider + modelName`；`modelId` 不再由 UI 写入或推断。刷新时按服务端 pair rehydrate，provider/model catalog 不可用时不创建本地有效 binding。

ChatRun 通过 `runId` 关联 Message，服务端返回的 `runStatus`、`terminalOutcome`、`errorCode` 和 `partial` 不能在刷新时被当作普通成功 assistant；`ambiguous` 需要人工确认后使用新的幂等键重试。

### 1.1 Agent principal 绑定（PLAN-0374）

- `sessions.agent_principal_id` 与 `agent_permissions_snapshot` 是 Agent 身份与 instance cap 的唯一来源；交互式 `POST /api/v1/sessions` 必须显式携带 `agentPrincipalId`，Chat admission 只接受已绑定 Session，无 lazy-create。
- principal-null 空 Session（附件占位/导入历史）首次 Chat 必须显式提交 principal：无 ChatRun、message、user-direct Operation 或 tool ContextEvent 时由 row CAS 与 ChatRun/Message/Operation 同事务绑定；缺省 403、异 principal 409。
- `user_id` 仅表达 owner/visibility，不参与 Agent 授权；binding 缺失/撤销时 Agent 动作 fail-closed，历史 Session 保留。契约见 [`spec/agent/principal-workspace-binding.md`](../../../spec/agent/principal-workspace-binding.md)，wire 以 OpenAPI 为准。

## 2. Store 职责边界（选项 B：共享 + 视图分离）

- **useSessionStore**（`stores/session.ts`，跨视图）：`sessions`、`currentSessionId`、`searchQuery`、附件投影、`fileContext`；独占创建/删除/重命名 Session；`setFileContext`/`setSessionAgents`/`setRAGContext`/`setMCPContext`。
- **useChatStore**（`stores/chat.ts`，视图层）：按 Session 分组 `messages`、`streamingMessageId`；`getMessages/addMessage/addMarker`；流式三件套 `createStreamingMessage` / `replaceStreamingParts`（整量替换 MessagePart[]，PLAN-230）/ `finalizeStreaming`；不存 Session 元数据与 Agent/RAG/MCP 配置。
- **useWorkspaceStore**（`stores/workspace.ts`，视图层）：`fileTree`、`expandedPaths`、`openFiles`、`activeFilePath`、`uploadQueue`；可选地通过 `syncActiveFileToSession()` 回写当前 Session 的文件上下文；不存 Session 元数据。没有当前 Session 时，Workspace 文件操作和 Workspace 事件订阅仍可工作，不能伪造 Session。文件变更操作（`renameNode/moveNode/duplicateNode/createDirectory`）返回 `Promise<boolean>`，调用方按结果分支 toast（禁假成功，PLAN-262 M1/B-2）；`refreshAfterMutation` 保持展开态；上传按 MIME 分派（文本 `write_file` MCP / 二进制 `POST /api/v1/files/upload`，PLAN-262 M0/B-3）。v1 无导入入口。

## 3. 跨 Store 同步

- **读**：视图组件与两视图 store 直接读 `useSessionStore`（`currentSessionId`、`currentSessionAttachments`、`currentSessionFileContext`），不缓存副本（禁多真相源）。
- **写**：Session 创建/删除/重命名只经 session store；附件上传入口在 `InputArea`（`uploadAttachments` → 后端），`sessionStore.addAttachment` 仅做内存投影；`ChatPanel.handleSend` 只发消息 + 透传 fileIds；文件上下文只经 `syncActiveFileToSession`；Agent/RAG/MCP 上下文经 session store 专门方法。
- **不用事件总线**：Pinia 响应式即同步机制，直接读取即可。

## 4. 视图嵌入与切换约定

- `ChatPanel` 是唯一允许的内嵌对话组件（消息列表 + 输入框 + SSEStream，无全屏布局头）；`ChatView` 与 `WorkspaceView` 共用其消息流逻辑，禁止别处直接嵌入 `ChatView`。
- 视图切换约定：chat→workspace 经 Sidebar Workspace 按钮（`/workspace/:workspaceId`，缺失时不跳转）；Workspace 路由可以没有 Session；workspace→chat 时选择已有 Session 或创建 Session，不把 Workspace 切换误写成 Session 切换；WorkspaceToolbar 的 Session 下拉切换 Session 时保留 workspace route。
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

## 附录：RFC-001 历史设计（已退役）

RFC-001（PLAN-029 产出，PLAN-222 覆盖后 deprecated）定义了统一 Session 的初版领域模型与状态图，核心结论（服务端 canonical source、Session-scoped 附件、fileContext 引用）已并入正文；旧 `modelId` 三字段绑定已由 `modelProvider + modelName` canonical pair 取代。原文见 git 历史。
