# XH 事件流

> 契约状态：`proposed`；实现状态：`partial`；Profile：`protocol`；Owner：CP/Runtime/Agent 跨边界 owner；来源：PLAN-0385，Session 派生状态事件扩展由 PLAN-0408 顺序承接，用户问答事件由 PLAN-0660 M5-B 承接；更新：2026-11-06。
> 消费者：CP、UI、Agent、Runtime

## 1. Chat Session SSE

入口：`GET /api/v1/events?sessionId=`。完整 event payload 以 OpenAPI/代码类型为准，本文冻结生命周期和 ownership：

- 一个 `sessionId` **MUST** 只有一个 active emitter；新连接替换旧连接并递增 generation。
- `POST /api/v1/chat` **MUST** 先通过 SSE subscription 与每会话 run 上限 gate（`maxConcurrentRunsPerSession`，默认 2；cap 满 → 409 `CHAT_IN_PROGRESS`，PLAN-0645），再持久化消息/run。
- `done` **MUST** 只结束当前 ChatRun，不得关闭 Session SSE。
- `heartbeat` 是 transport event，不得进入 UI MessagePart。
- `derived_state_changed` 是 child terminal 提交后的 best-effort refresh hint，发送到**父 Session**的 SSE channel；data JSON 恰好 `{sessionId,runId,state,at}` 四键，其中 `sessionId/runId/state` 标识 child Run，`at` 等于其 durable `chat_runs.terminal_at`。接收端只据此重新读取父 Session derived-state API；Inbox 是通知事实源，SSE 不承诺必达、replay 或与 DB 原子。
- `token`、`tool_call`、`tool_result`、`approval_request`、`error` 和 `done` 的顺序/字段以事件实现和 OpenAPI 为准；重连只能回放被授权 Session 的可恢复事件。
- `requestId`、`runId`、`sessionId`、`workspaceId` 必须贯通日志、durable record 和 UI 本地视图；不得把 raw tool arguments 放入 approval event。
- **`session_question_asked` 不是会话 SSE 事件**：它出现在 CP ↔ Agent 的内部流上，由 CP 消费后转成 durable 行 + 用户通道 hint，**不转发**给 `GET /api/v1/events`（见 §4）。

## Context durable append（PLAN-0416）

- caller 在首次 append 前生成稳定 `eventId`，复用现有 `context_events` UUID 主键；超时或响应丢失后重试沿用同一身份。同 owner/identity/content 返回原 sequence，owner 或内容冲突必须拒绝。
- append 重试不重放 provider 请求或工具 dispatch，不增加第二套事件身份或持久化表。Context projection 和 UI 不应把同一逻辑事件显示两次。

## 2. Workspace SSE

入口：`GET /api/v1/workspaces/{workspaceId}/events`，Runtime ingress：`POST /internal/v1/runtime/workspaces/{workspaceId}/events`。

- Workspace SSE 不要求 Session 存在，按 Workspace membership 鉴权。
- 事件只携带 Workspace-relative path、变更类型和 Workspace-local sequence；不得包含宿主绝对路径、文件正文或完整目录树。
- v1 不持久化 replay log；sequence gap 发送 `snapshot_required`，UI 通过已有 HTTP/MCP 读取重建。
- Workspace 删除提交后关闭订阅；Chat SSE 和 Workspace SSE 不互相注入事件。

## 3. 事件 ownership

| 事件面 | 生产者 | 中继/持久化 owner | 消费者 |
|---|---|---|---|
| ChatRun/Agent event | Agent | CP | UI、durable ChatRun/context projection |
| approval event | CP gate 或 Agent relay | CP | UI、Agent decision path |
| user question event | Agent（内部流 `session_question_asked`） | CP：`user_questions`（V128）是唯一事实源；公开面只有用户通道 hint | CP relay、UI 投影（**不进**会话 SSE） |
| user channel hint | CP（`UserChannelPort`） | 无 durable 副本；推送失败只记日志 | UI（refresh hint，重读投影） |
| derived_state_changed | CP ChatRunTerminalService（child terminal commit 后 best-effort） | Inbox 是 durable source；CP SSE 仅提示 | 父 Session UI → refetch derived-state |
| Workspace file hint | Runtime watcher | CP Workspace event manager | UI |
| Domain history / audit projection | CP domain services/Runtime callback | Owning ChatRun, Workspace Job, MCP invocation or Approval record; CP audit read model | UI audit、内部 trace |

事件 wire schema 不在本文复制；来源和语义冲突必须登记到 PLAN-0385 evidence。

## 4. 用户问答事件（PLAN-0660 M5-B）

> 事件名以代码为准（`grep -n "session_question_asked\|user_question"`）。**没有** `user_question_asked` / `user_question_answered` / `user_question_cancelled` / `user_question_expired` 这四个独立事件名：全链只有**两条 wire 事件**，四态只作为 hint 的 `state` 字段值出现。

| 事件 | 面 | 载荷 | 消费 |
|---|---|---|---|
| `session_question_asked` | CP ↔ Agent 内部流（`POST /internal/v1/agent/chat` 的 SSE 响应，穷举分支见 `ChatController` 的 relay 段） | `{question, expiresAt?, askedByParticipantId?}`；`question` ≤2000 字符，`expiresAt` 仅 `askTimed` 携带 | CP 在 relay 分支 `return`，**不**进入会话 SSE |
| `user_question` | 用户通道 `GET /api/v1/user-events` | `{questionId, sessionId, state}`，`state` 当前恒为 `pending` | UI 收到即重读 `GET /api/v1/user-questions` |

冻结的语义：

1. **顺序 = durable 先、hint 后**：CP 先在同一事务里落 `user_questions` 行，再推 `user_question`。hint 是 fire-and-forget，推送失败只记日志，不回滚、不影响 Agent 的等待。
2. **正文不出 CP**：问答正文只出现在 `session_question_asked`（Agent→CP，内部）与 `POST /internal/v1/agent/user-question/respond`（CP→Agent，内部）两条 wire 上；不写日志/审计/problem detail，不进任何 SSE 公开载荷。会话流里 grep 不到问题/回答正文（T5.11 判定）。
3. **结算不产生事件**：`answered`/`expired`/`cancelled` 不推新事件、也不重推 hint。作答方从 `POST /api/v1/user-questions/{id}/answer` 的响应收敛，其他标签页/其他设备靠重读投影（`spec/session/user-channel.md` §6a.4）。
4. **被拒的提问没有事件**：relay 门拒绝（子 run `SUBAGENT_QUESTION_REFUSED`、`QUESTION_APPROVAL_PENDING`、`QUESTION_ALREADY_PENDING`、`AGENT_EVENT_ID_MISMATCH`）只记 CP 日志，不落行、不推 hint——UI 不会出现「卡片没有对应行」；Agent 侧（T5.16）在子 run 上甚至不会发出该事件。
5. **通道无 replay**：用户通道没有 `Last-Event-ID` 语义，**订阅晚于发送就丢 hint**（不是延迟送达、也没有补发）；重连是全新订阅。因此 hint 永远只是 refresh 提示，事实源是 `GET /api/v1/user-questions` 与派生 `pendingCount`。
6. 事件名集合封闭：用户通道只有 `connected` / `participant_notified` / `user_question` 三个（`spec/session/user-channel.md` §4），内部 `wake_*` 名永不过该通道。
