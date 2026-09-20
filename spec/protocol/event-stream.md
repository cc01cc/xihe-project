# XH 事件流

> 契约状态：`proposed`；实现状态：`partial`；Profile：`protocol`；Owner：CP/Runtime/Agent 跨边界 owner；来源：PLAN-0385；更新：2026-09-20。

## 1. Chat Session SSE

入口：`GET /api/v1/events?sessionId=`。完整 event payload 以 OpenAPI/代码类型为准，本文冻结生命周期和 ownership：

- 一个 `sessionId` **MUST** 只有一个 active emitter；新连接替换旧连接并递增 generation。
- `POST /api/v1/chat` **MUST** 先通过 SSE subscription 和 single-flight gate，再持久化消息/run。
- `done` **MUST** 只结束当前 ChatRun，不得关闭 Session SSE。
- `heartbeat` 是 transport event，不得进入 UI MessagePart。
- `token`、`tool_call`、`tool_result`、`approval_request`、`error` 和 `done` 的顺序/字段以事件实现和 OpenAPI 为准；重连只能回放被授权 Session 的可恢复事件。
- `requestId`、`runId`、`sessionId`、`workspaceId` 必须贯通日志、durable record 和 UI 投影；不得把 raw tool arguments 放入 approval event。

## 2. Workspace SSE

入口：`GET /api/v1/workspaces/{workspaceId}/events`，Runtime ingress：`POST /internal/v1/runtime/workspaces/{workspaceId}/events`。

- Workspace SSE 不要求 Session 存在，按 Workspace membership 鉴权。
- 事件只携带 Workspace-relative path、变更类型和 Workspace-local sequence；不得包含宿主绝对路径、文件正文或完整目录树。
- v1 不持久化 replay log；sequence gap 发送 `snapshot_required`，UI 通过已有 HTTP/MCP 读取重建。
- Workspace 删除提交后关闭订阅；Chat SSE 和 Workspace SSE 不互相注入事件。

## 3. 事件 ownership

| 事件面 | 生产者 | 中继/持久化 owner | 消费者 |
|---|---|---|---|
| ChatRun/Agent event | Agent | CP | UI、durable ledger/context |
| approval event | CP gate 或 Agent relay | CP | UI、Agent decision path |
| Workspace file hint | Runtime watcher | CP Workspace event manager | UI |
| Operation event | CP services/Runtime callback | CP ledger | UI audit、内部 trace |

事件 wire schema 不在本文复制；来源和语义冲突必须登记到 PLAN-0385 evidence。
