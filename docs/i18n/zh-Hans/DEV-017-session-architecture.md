---
title: DEV-017 - Session 架构
category: dev-guide
lang: zh-Hans
sidebar_group: "开发指南"
status: active
sidebar_order: 17
created: 2026-09-03
updated: 2026-09-03
---

# DEV-017: Session 架构

> 面向前端与会话逻辑开发者：一页讲清状态归属、同步机制与嵌入约定。UI 实现细节见 DEV-010。
>
> chat 与 workspace 是同一 Session 的不同视图。与 DEV-010 以"Session 领域 vs UI 实现"分界：状态归属、同步机制、嵌入约定归本文；路由表、组件树、传输层实现归 DEV-010。

## 1. Session 领域模型

Session 是用户一次连贯工作上下文，独立于视图：

| 归属 | 约定 |
|------|------|
| Session/Message | 以 CP 服务端 API 为 canonical source；不落 localStorage，历史值不恢复 |
| Message | 属于 Session，由 `useChatStore` 按 `sessionId` 索引；生命周期（创建/流式/完成）走 chat store |
| Attachment | Session-scoped；后端 Session 专属空间持久化（`{base}/{sessionId}/` 下按 fileId 存取），`Message.attachments` 存元数据；workspace 对附件只读（文件本身经 workspace store 可写，见 DEV-010 §5） |
| File | 物理文件归 Runtime；Session 经 `fileContext` 存引用（workspaceFiles/activeFilePath） |
| 上下文 | `SessionContext{agents, ragContext?, mcpContext?, fileContext?}`；RAG/MCP 配置源为 `configStore` |

Chat 用 `sessionId`，Workspace 用 `workspaceId`，禁止互充（PLAN-222）。状态机：Active（可交互）→ Archived（前端不加载，数据按服务端契约保留/清理）→ 删除（服务端 API）。`modelId` 字段读路径仍保留（`@deprecated` 转 `configStore` session-model，双轨并存，非已删除）。

## 2. Store 职责边界（选项 B：共享 + 视图分离）

- **useSessionStore**（`stores/session.ts`，跨视图）：`sessions`、`currentSessionId`、`searchQuery`、附件投影、`fileContext`；独占创建/删除/重命名 Session；`setFileContext`/`setSessionAgents`/`setRAGContext`/`setMCPContext`。
- **useChatStore**（`stores/chat.ts`，视图层）：按 Session 分组 `messages`、`streamingMessageId`；`getMessages/addMessage/addMarker`；流式三件套 `createStreamingMessage` / `replaceStreamingParts`（整量替换 MessagePart[]，PLAN-230）/ `finalizeStreaming`；不存 Session 元数据与 Agent/RAG/MCP 配置。
- **useWorkspaceStore**（`stores/workspace.ts`，视图层）：`fileTree`、`expandedPaths`、`openFiles`、`activeFilePath`、`uploadQueue`；`syncActiveFileToSession()` 回写文件上下文；不存 Session 元数据。v1 无导入入口。

## 3. 跨 Store 同步

- **读**：视图组件与两视图 store 直接读 `useSessionStore`（`currentSessionId`、`currentSessionAttachments`、`currentSessionFileContext`），不缓存副本（禁多真相源）。
- **写**：Session 创建/删除/重命名只经 session store；附件上传入口在 `InputArea`（`uploadAttachments` → 后端），`sessionStore.addAttachment` 仅做内存投影；`ChatPanel.handleSend` 只发消息 + 透传 fileIds；文件上下文只经 `syncActiveFileToSession`；Agent/RAG/MCP 上下文经 session store 专门方法。
- **不用事件总线**：Pinia 响应式即同步机制，直接读取即可。

## 4. 视图嵌入与切换约定

- `ChatPanel` 是唯一允许的内嵌对话组件（消息列表 + 输入框 + SSEStream，无全屏布局头）；`ChatView` 与 `WorkspaceView` 共用其消息流逻辑，禁止别处直接嵌入 `ChatView`。
- 同一 Session 切换（约定）：chat→workspace 经 Sidebar Workspace 按钮（`/workspace/:workspaceId`，缺失时不跳转）；workspace→chat 回到 `/chat/:currentSessionId`；WorkspaceToolbar 的 Session 下拉切换 Session 时保留 workspace route。
- 消息历史一律经 `chatStore.getMessages(sessionId)` 读取，跨视图一致；附件经 `currentSessionAttachments` 共享。
- 路由表与组件分层见 DEV-010 §1-2；SSE 传输层见 DEV-010 §4。

## 5. 开发约定与扩展

- 新增视图优先读 `useSessionStore`，不直接操作 chat store 的 Session 状态；文件上下文写入统一走 `syncActiveFileToSession`。
- 后续扩展（右侧面板拖拽宽、统一 `/session/:id` 路由评估、文件拖拽入 chat、多 Session 并列）另行 PLAN。

## 附录：RFC-001 历史设计（已退役）

RFC-001（PLAN-029 产出，PLAN-222 覆盖后 deprecated）定义了统一 Session 的初版领域模型与状态图，核心结论（服务端 canonical source、Session-scoped 附件、fileContext 引用）已并入正文；`modelId` 字段废弃（由 `configStore` session-model 绑定接管）。原文见 git 历史。
