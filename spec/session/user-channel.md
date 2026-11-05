# Session SPEC：用户通道与未读派生（user channel）

> 契约状态：`proposed`  
> 实现状态：`not-implemented`  
> Profile：`cross-boundary`（CP durable + 用户级 SSE + UI + Agent）  
> Owner：CP Notification / UserChannel  
> 消费者：CP、Agent、UI、后续 PLAN（问答组件、未读徽标）  
> 来源：PLAN-0648（并入 PLAN-0660 M5）  
> 更新日期：2026-11-05

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
5. **会话可见者与 addressee 拿同一投影**（裁定 D-197，2026-11-05 Lead）：读面字段集不按角色裁剪，差异只在作答权。理由是一致性——问题与回答最终都会作为消息进入会话流（relay 落地后），投影若对非 addressee 屏蔽 `answer` 会与消息流自相矛盾。若将来要按角色屏蔽字段，**先改本节再落码**。

## 6 数据模型（user_questions，V128）

> 本节就是 T5.8 要求「表结构在本 SPEC 内重建一份可核对清单」的落点：PLAN-0648 已归档，冻结清单不能只靠归档文档的节号。
> 下表逐项对应 `V128__user_questions.sql`；**任何列/约束/索引的增删，先改本节再改迁移**。

**新表只一张**；不新建 `read_cursors`（mention 已读复用 §2 的 `session_participant_cursors`，问题待答数由 `state` 派生，与 §3 同口径）。不落 `workspace_id`：0647 后 session 可无 workspace，join 即可得，冗余列会是第二事实源。

| 列 | 类型/约束 | 说明 |
|---|---|---|
| `id` | UUID PK | — |
| `session_id` | UUID NOT NULL → `sessions(id)` `ON DELETE CASCADE` | 发起上下文 |
| `run_id` | UUID NOT NULL → `chat_runs(id)` `ON DELETE CASCADE` | 与 `approval_requests.run_id` 同口径（`V1:409`） |
| `asked_by_participant_id` | UUID NULL → `session_participants(id)` `ON DELETE SET NULL` | 代问者（agent 参与者行）；无则为 NULL |
| `addressee_user_id` | UUID NOT NULL → `users(id)`（默认 NO ACTION） | 唯一有作答权的人，也是唯一可能收到 hint 的人 |
| `prompt` | TEXT NOT NULL | 问题正文；**不建任何索引**（禁 trigram/全文），不进日志/审计/problem detail |
| `state` | TEXT NOT NULL，`CHECK ∈ pending/answered/expired/cancelled` | 唯一状态真相 |
| `expires_at` | TIMESTAMPTZ NULL | NULL = `ask`（阻塞等，deadline 归 Agent）；非空 = `askTimed` |
| `answer` | TEXT NULL | 仅 `pending → answered` 写；不建索引；出 wire 前按不可信文本处理 |
| `created_at` | TIMESTAMPTZ NOT NULL DEFAULT NOW() | 提问时间 |
| `first_delivered_at` | TIMESTAMPTZ NULL | hint 首次交给用户通道；NULL = 尚未投递 |
| `settled_at` | TIMESTAMPTZ NULL | 到达终态的时间 |

索引（3 条，全部在 V128 内建）：

| 索引 | 定义 | 用途 |
|---|---|---|
| `idx_user_questions_addressee_pending` | `(addressee_user_id, created_at DESC) WHERE state='pending'` | 投影主查询与 `pendingCount` |
| `idx_user_questions_session_created` | `(session_id, created_at)` | 会话可见者读投影（非 addressee，无作答权） |
| `uq_user_questions_run_pending` | UNIQUE `(run_id) WHERE state='pending'` | 一 run 至多一个未决问句；已结算行不阻塞下一次提问 |

**刻意不落 DDL 的三条**（不是遗漏，写明由谁保证）：

1. 「一 run 至多一个未决 human interaction」（问答 ∩ 审批）跨两张表，约束无法表达 ⇒ 服务层 CAS + 409（T5.9），并发断言见 T5.13。
2. 正文长度上限（写侧 ≤2000 字符）是 writer 规则，不进 CHECK —— schema 不替模型决定能问多长。
3. `answer` 仅 `answered` 非空这一配对由 `pending → answered` 单一路径保证（T5.9）。**裁定不加 DB CHECK（2026-11-05 Lead）**：冻结清单是 1:1 契约，额外加 CHECK 会让 schema 比本节多一条（实现漂移），而它只能强一个方向。真实保证 = T5.9 的单一路径 + T5.13 的断言「任何非 `answered` 终态的行 `answer IS NULL`」（expired/cancelled 路径）。

**回滚**：`DROP TABLE user_questions;`（3 索引与 4 个 FK 随表，无其它对象依赖）。

## 7 不扩契约

- 本文件冻结的三类面之外**不新增**事件名、计数维度或路由；用户通道之外若有新面，必须先改本文件再落码。
- 路由总量（M5 批）：**4 条 public**（`user-events` + 3 条问答）+ **1 条 internal**（Agent 回传）；`docs/api/inventory.md` 与 OpenAPI 同批登记。
- `FrozenWakeEventNameScanTest` 守护的是 `wake_*` 事件名集合，**不覆盖** `user-events` 通道；故用户通道事件名在本文件冻结，并由契约测试断言（防止后续静默新增）。

## 8 承接与验证

- 实现任务：PLAN-0660 M5-A `T5.1`（游标端点）/ `T5.2`（未读派生）/ `T5.3`（撤只增写点）/ `T5.4`（SSE 底座）/ `T5.5`（推送接入）/ `T5.6`（UI 回接）；M5-B `T5.8–T5.13`（问答组件 CP 侧）。
- 验收：`verify.md` V14（游标推进与 clamp）/ V15（用户级可见性与跨用户隔离）/ V16–V18（问答与 UI 面，原 0648 迁入）。
- 证据落点：`evidence/m5-g1-gate.md`（M5-A 波次）、`evidence/m5-b-gate.md`（M5-B）。
