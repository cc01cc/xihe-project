---
title: DEV-034 - 四类规范契约地图
category: dev-guide
sidebar_order: 34
lang: zh-Hans
sidebar_group: "开发指南"
status: active
created: 2026-11-10
updated: 2026-11-10
description: 跨模块改动开工前的指路页：HTTP 路由 / 事件流 SSE / MCP / 持久化 四类契约各自的单一权威在哪，以及事件流 payload 形状的已知缺口与抽取坐标
tags:
  - contract
  - map
  - sse
---

# DEV-034: 四类规范契约地图

> **定位**：跨模块改动开工前，用一页确认「这类契约的权威正文在哪」。**本页只指路，不复述正文** —— 每格给出的是可点开的权威；本页与权威冲突时**以权威为准**，并改本页。
>
> **不是什么**：不是第五份规范，不是字段手册。本页**禁止**出现字段级正文（见 §6）。范围只覆盖 CP / Agent / Runtime / UI 之间的四类跨边界契约面。

## 1. 四类速查

| # | 契约类 | 单一权威 | 派生 / 辅助 | 状态 |
|---|---|---|---|---|
| ① | HTTP 路由与请求/响应 schema | [`docs/api/openapi.yaml`](../../api/openapi.yaml) | [`docs/api/inventory.md`](../../api/inventory.md)（路由清单与语义基线） | **齐备** |
| ② | 事件流 SSE / AgentEvent | **无单一 schema 正文** | [`spec/protocol/event-stream.md`](../../../spec/protocol/event-stream.md)（生命周期与 ownership，`proposed`·`partial`）+ OpenAPI 描述 + 代码 | **缺口**：见 §3 |
| ③ | MCP 工具面 | `docs/api/mcp-tools.md`（**在建**，research-2） | [DEV-016](DEV-016-mcp-architecture.md) | **在建** |
| ④ | 持久化（表结构 / 迁移） | [`packages/control-plane/src/main/resources/db/migration/`](../../../packages/control-plane/src/main/resources/db/migration/) | [DEV-019](DEV-019-database-schema.md)（表结构速查） | **齐备** |

> 状态口径：**齐备** = 存在单一权威且可据以判断合规；**在建** = 权威文件尚未落地，暂由辅助面兜；**缺口** = 根本不存在能冻结 payload 的正文，只能读代码。

## 2. ① HTTP 路由

- **正文**：`docs/api/openapi.yaml` —— 路由、请求体、响应 schema、错误 `ProblemDetails`、鉴权声明都在这里。契约漂移由 `mise run check:openapi` 拦（已是 `test:cp` 与 `validate` 的依赖）。
- **辅助**：`docs/api/inventory.md` 是**实现基线**（PLAN-222/230），记录规范化后的路由清单与跨面语义（`X-Workspace-Id` 门、错误码、角色投影）。它**不是** schema 正文：字段级判定一律回 OpenAPI。
- **常见误用**：拿 inventory 的行文当接口契约去断言字段 ⇒ 字段不在那儿；反过来说 inventory 的语义段（如「缺 header 落回哪个门」）在 OpenAPI 里也写不全，**两者互补，不互为替代**。

## 3. ② 事件流 SSE / AgentEvent —— 本页最该记住的一格

**结论：payload 形状没有单一正文。** 这不是"没人写"，而是**写了的那份明确把 wire schema 划出去了**，所以不存在可引用的冻结表。

### 3.1 已有的（别重复造）

| 面 | 坐标 | 覆盖什么 |
|---|---|---|
| 生命周期与 ownership | `spec/protocol/event-stream.md`（`proposed`·`partial`；`:8`、`:45`） | 一 session 一 emitter、generation 递增、`done` 只结束 run、`heartbeat` 不进 UI、事件 ownership 表、用户通道封闭事件集 |
| 信封级散文描述 | OpenAPI `GET /api/v1/events` 的 `chatEvents` `description`（`openapi.yaml:2315-2330`） | 事件**顺序**与**部分**事件的字段串：`derived_state_changed`、`run_checkpoint`、`transport_progress`、`participantId`、`runId` |
| 用户通道示例 | OpenAPI `/api/v1/user-events`（`openapi.yaml:2286`，示例 `:2303`） | `text/event-stream` + `schema: {type: string}` + 一段 `event:/data:` 示例（是**示例**，不是 schema） |
| 工作区通道 | OpenAPI `/api/v1/workspaces/{workspaceId}/events`（`:2399`） | 同上，示例级 |

`spec/protocol/event-stream.md:8` 原文：「完整 event payload 以 OpenAPI/代码类型为准，本文冻结生命周期和 ownership」；`:45`：「事件 wire schema 不在本文复制」。⇒ **该文不是 payload 正文，引用它来断言字段是误读。**

### 3.2 缺的是什么

一份**逐字段冻结** `token` / `tool_call` / `tool_result` / `approval_request` / `error` / `done` 六个会话事件的正文档，当前**不存在**。后果：新增或改动事件时无处「查表」，只能读代码；跨模块改事件必须人工对齐三方（见 §3.3）。

> 补这份正文是**另一张卡**的事 —— 本页只登记缺口与抽取坐标，**不在契约地图里现编事件规范**（否则地图会藏着第二份正文，两者必然漂移）。

### 3.3 抽取坐标（按面，缺正文时的唯一办法）

| 面 | 坐标 | 说明 |
|---|---|---|
| wire 类型 | `packages/agent/src/xihe_agent/interfaces/agent_runner.py:23` | `class AgentEvent` —— 事件的真实类型定义 |
| 生产者映射 | `packages/agent/src/xihe_agent/adapters/sse_adapter.py` | 框架原始事件 → `AgentEvent`；`SUPPRESSED_HUMAN_WAIT_TOOLS` 决定哪些工具**不**产 `tool_call`/`tool_result` |
| CP 中继 / 发射 | `.../cp/chat/SseEmitterManager.java`、`.../cp/event/WorkspaceEventManager.java`、`.../cp/event/UserChannelSseManager.java` | 三条通道各自的派发点 |
| UI 消费 | `packages/ui/src/features/workspace/chat/composables/useStreamParser.ts` | 前端把这些信封解析成消息部件 |

**⚠️ 同名不同物（最容易踩）**：`packages/agent/src/xihe_agent/interfaces/event.py` **不是** SSE 事件类型，而是 **context 事件溯源**的 domain events（`EventType = session.created / prompt.admitted / llm.token / ...`），持久化进 CP Event Store 再投影成 `AgentContext`。两个「event」互不替代。

**⚠️ 两个已知反直觉点**（引自 `spec/protocol/event-stream.md`，省一次现场排障）：

1. `session_question_asked` **不是**会话 SSE 事件（`:17`）：它只出现在 CP ↔ Agent 内部流，CP 消费后转成 durable 行 + 用户通道 hint，**不转发**给 `GET /api/v1/events`。在会话流里找它必然找不到。
2. `heartbeat` 是 transport event，**不得**进入 UI MessagePart（`:13`）。

## 4. ③ MCP 工具面

- **正文（在建）**：`docs/api/mcp-tools.md` —— 截至 2026-11-10 该文件**尚不存在**（由 research-2 建）。落地后它是唯一权威。
- **当前兜底**：[DEV-016](DEV-016-mcp-architecture.md)（MCP 架构与边界）+ OpenAPI 的 `/api/v1/mcp/*` 路径。注意二者覆盖不同：DEV-016 讲**协议与信任边界**（为什么没有 `mcp-session-id`、OAuth 归谁），OpenAPI 讲**wire**。工具**清单**与逐工具的入参语义在 mcp-tools.md 落地前没有权威。
- **落地后要做**：把 §1 表格第一列指向它，状态改「齐备」。

## 5. ④ 持久化

- **正文**：`packages/control-plane/src/main/resources/db/migration/` —— Flyway 迁移目录就是 **Schema Source of Truth**（[DEV-019](DEV-019-database-schema.md) `:19` 明写）。当前 `V1..V150`，共 142 个脚本（2026-11-10 实测）。
- **辅助**：DEV-019 是**按域分组的表结构速查**（结论先行、字段约束、索引、本地查看方法），适合"这张表有什么列"，不适合"某个迁移改了啥"。
- **已知漂移**：DEV-019 的迁移对照表覆盖到 `V75` 并补了 `V133/V134` 行；晚于它的迁移（如 `V148__plan0750_create_own_agent_atom.sql`、`V150__message_reasoning.sql`）**只在目录里**，DEV-019 未逐条列 ⇒ 判定"某 schema 何时引入"以**迁移文件名 + 目录**为准。

## 6. 维护规则

1. **先改权威，再改本页一行**：任何契约类新增/改名，权威文件与本页同批更新；只改一边必然漂移。
2. **本页不许出现字段级正文**：只允许「坐标 + 一句它覆盖什么」。想写字段表 ⇒ 说明该写的是那份缺口正文（另开卡），不是地图。
3. **链接必须真实存在**：新增本页链接前先确认文件在；`mise run lint:links` 会抓断链（③ 的 mcp-tools.md 在建，故本页只写路径不写行内链接）。
4. **缺口关闭时改状态**：§1 的「缺口 / 在建」是**待办标记**，修好后同批改成「齐备」并补链接，别让地图长期停在旧状态。
5. **四类的分类不轻易扩**：新增第五类（如 gRPC / WebSocket 专用面）需先确认它确实不与四类重叠。

## 7. 与其他文档的关系

- [DEV-001](DEV-001-system-architecture.md)：全局架构与模块边界（本页是它的**契约入口细化**，不重复架构叙述）。
- [DEV-030](DEV-030-documentation-layout-and-frontmatter.md)：文档归属与 frontmatter 规范（本页遵守它）。
- `spec/README.md`：项目级 SPEC 入口（本页不替代 SPEC，只标注哪类契约的 SPEC/正文在哪）。
- [DEV-018](DEV-018-known-issues.md)：Known Issues 入口；② 的 payload 正文档缺口**不**登记在那里（那是缺陷台账，这是文档缺口），本页 §3.2 就是它的登记处。
