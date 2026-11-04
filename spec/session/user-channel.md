# Session SPEC：用户通道与未读派生（user channel）

> 契约状态：`proposed`  
> 实现状态：`not-implemented`  
> Profile：`cross-boundary`（CP durable + 用户级 SSE + UI + Agent）  
> Owner：CP Notification / UserChannel  
> 消费者：CP、Agent、UI、后续 PLAN（问答组件、未读徽标）  
> 来源：PLAN-0648（并入 PLAN-0660 M5）  
> 更新日期：2026-11-04

## 1 范围与边界

- 本文件冻结**用户级**的「通知可达 + 未读可下降 + 推送只做 hint」三类契约；**不**定义 session/workspace 级 SSE（那两者仍归 `chat-session.md` 与 workspace 事件契约）。
- 不复用既有两条 SSE：Chat SSE 是「一 session 一 emitter、新连接替换旧连接」，Workspace SSE 按 `workspaceId` + kind 白名单；用户通道按 **userId** 订阅，语义不同，必须独立实现。
- 用户通道是**用户级**：连接与鉴权都只依赖用户 Bearer，**不要求** `X-Workspace-Id`；切换 workspace 不重建连接。

## 2 已读游标语义

1. 游标落点**复用既有表** `session_participant_cursors`（一行一 participant），**不新增表、不新增计数器**（裁定 `decisions-2026-11-03.md:282`）。
2. 推进端点：`PATCH /api/v1/sessions/{sessionId}/participants/{participantId}/cursor`，体 `{lastReadEventSeq}`。
3. **advance-only**：新值 = `max(现值, 请求值)`；请求值小于现值时**不降级**、返回当前值（幂等）。
4. **clamp**：请求值必须被夹取到该 session 当前最大 `sequence`；越界值按上限处理而非报错。
5. **self-only**：仅当参与者 `principal_kind = HUMAN` 且 `actorId == participant.principal_id` 时允许；其余一律 `403 CURSOR_SELF_ONLY`（AGENT 行、他人行都走这条）。
6. 推进写 `updated_at`，但**不写任何计数列**。

## 3 未读派生口径

1. 未读**不是**持久计数器，而是**派生值**：`mentionCount(participant) = count(events where event_type='wake_dispatch' and payload->>'outcome'='notify' and sequence > cursor.last_read_event_seq)`，范围限定该 participant 所属 session。
2. 计算必须是**单条 SQL 聚合**（禁 N+1、禁逐 participant 查询）；wire 字段名与结构**不变**：`participant.readCursor.mentionCount`。
3. 因此：推进游标后该值**单调不增**；新增 notify 行后严格 `+1`；不存在第二事实源。
4. `session_participant_cursors.mention_count` 列**同批 drop**（裁定 `decisions-2026-11-03.md:281`，理由 V92/DEV-032 已冻结「指针不是计数器」）；drop 后 CP 主源码**零写点**，读点只剩派生 SQL。

## 4 用户通道 SSE（事件与路由）

- 路由：`GET /api/v1/user-events`（用户 Bearer，SSE；`Accept: text/event-stream`）。
- **事件名集合封闭为三个**，不得再扩：

| 事件 | data 载荷 | 语义 |
|---|---|---|
| `connected` | `{serverTime}` | 连接建立握手；**不** replay、**不**承诺定序、**不**代表 DB 一致 |
| `participant_notified` | `{sessionId, participantId}` | 「有人 @ 了你 / cc 了你」的 **refresh hint**；接收端据此重读名册投影 |
| `user_question` | `{questionId, sessionId, state}` | 问答状态变化的 refresh hint；正文走投影拉取 |

- hint **只做失效提示**：不得携带计数、正文、答案或任何业务数据（同 `derived_state_changed` 的冻结口径）。
- 连接管理：心跳 15s；每 user 订阅者上限 **8**；**同人多 tab 均收到**（不做单连接替换）；达上限的拒绝形态必须显式（明确状态码 + problem `code`），不得静默丢弃。
- 失效：用户被禁用，或 `token_version` / `session_version` 递增后，既有连接在**下一个事件**时不投递并关闭（不在空闲期做额外轮询）。

## 5 安全与最小化

1. **跨用户隔离**：单连接只投递该 `userId` 的 hint；任何他人 session 的 hint 不得串入（断言级要求）。
2. **正文最小化**：问题/回答正文不进日志、审计、problem detail 与 SSE 载荷（只留 `questionId` 与长度）。
3. **不泄露存在性**：问答读面对外统一 `404`（非 addressee 的 `GET`/`answer` 同样 404，不区分「不存在」与「无权」）。
4. **端口可空注入**：`UserChannelPort` 无实现时（单测/无 SSE 场景）投递为 no-op，业务行为不变。

## 6 不扩契约

- 本文件冻结的三类面之外**不新增**事件名、计数维度或路由；用户通道之外若有新面，必须先改本文件再落码。
- 路由总量（M5 批）：**4 条 public**（`user-events` + 3 条问答）+ **1 条 internal**（Agent 回传）；`docs/api/inventory.md` 与 OpenAPI 同批登记。
- `FrozenWakeEventNameScanTest` 守护的是 `wake_*` 事件名集合，**不覆盖** `user-events` 通道；故用户通道事件名在本文件冻结，并由契约测试断言（防止后续静默新增）。

## 7 承接与验证

- 实现任务：PLAN-0660 M5-A `T5.1`（游标端点）/ `T5.2`（未读派生）/ `T5.3`（撤只增写点）/ `T5.4`（SSE 底座）/ `T5.5`（推送接入）/ `T5.6`（UI 回接）；M5-B `T5.8–T5.13`（问答组件 CP 侧）。
- 验收：`verify.md` V14（游标推进与 clamp）/ V15（用户级可见性与跨用户隔离）/ V16–V18（问答与 UI 面，原 0648 迁入）。
- 证据落点：`evidence/m5-g1-gate.md`（M5-A 波次）、`evidence/m5-b-gate.md`（M5-B）。
