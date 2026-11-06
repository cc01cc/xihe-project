# Session SPEC：用户通道与未读派生（user channel）

> 契约状态：`proposed`  
> 实现状态：`implemented`（M5-A 用户通道 + M5-B 用户问答，2026-11-06 对账）  
> Profile：`cross-boundary`（CP durable + 用户级 SSE + UI + Agent）  
> Owner：CP Notification / UserChannel  
> 消费者：CP、Agent、UI、后续 PLAN（问答组件、未读徽标）  
> 来源：PLAN-0648（并入 PLAN-0660 M5）  
> 更新日期：2026-11-06

## 1 范围与边界

- 本文件冻结**用户级**的「通知可达 + 未读可下降 + 推送只做 hint」三类契约；**不**定义 session/workspace 级 SSE（那两者仍归 `chat-session.md` 与 workspace 事件契约）。
- 不复用既有两条 SSE：Chat SSE 是「一 session 一 emitter、新连接替换旧连接」，Workspace SSE 按 `workspaceId` + kind 白名单；用户通道按 **userId** 订阅，语义不同，必须独立实现。
- 用户通道是**用户级**：连接与鉴权都只依赖用户 Bearer，**不要求** `X-Workspace-Id`；切换 workspace 不重建连接。
- 用户问答（`user_questions`）的四态、路由与错误码在本文件 §6 / §6a 冻结；事件名与转发边界见 `spec/protocol/event-stream.md` §4。

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
4. `session_participant_cursors.mention_count` 列**同批 drop**（裁定 `decisions-2026-11-03.md:281`，理由 V92/DEV-032 已冻结「指针不是计数器」；迁移 `V112__plan0660_derived_unread.sql`）；drop 后 CP 主源码**零写点**，读点只剩派生 SQL。

## 4 用户通道 SSE（事件与路由）

- 路由：`GET /api/v1/user-events`（用户 Bearer，SSE；`Accept: text/event-stream`）。
- **事件名集合封闭为三个**，不得再扩：

| 事件 | data 载荷 | 语义 |
|---|---|---|
| `connected` | `{serverTime}` | 连接建立握手；**不** replay、**不**承诺定序、**不**代表 DB 一致 |
| `participant_notified` | `{sessionId, participantId}` | 「有人 @ 了你 / cc 了你」的 **refresh hint**；接收端据此重读名册投影 |
| `user_question` | `{questionId, sessionId, state}` | **仅在提问落库后推一次**（`state=pending`）的 refresh hint；正文走投影拉取。结算（`answered`/`expired`/`cancelled`）**不重推**，见 §6a.4 |

- hint **只做失效提示**：不得携带计数、正文、答案或任何业务数据（同 `derived_state_changed` 的冻结口径）。
- **通道无 replay**：订阅晚于发送就**永久丢掉那条 hint**（不是延迟送达，也没有补发）；UI 必须以 `GET /api/v1/user-questions` 等投影读面收敛，不得把 hint 当事实源。
- 连接管理：心跳 15s；每 user 订阅者上限 **8**；**同人多 tab 均收到**（不做单连接替换）；达上限的拒绝形态必须显式（明确状态码 + problem `code`），不得静默丢弃。
- 失效：用户被禁用，或 `token_version` / `session_version` 递增后，既有连接在**下一个事件**时不投递并关闭（不在空闲期做额外轮询）。

## 5 安全与最小化

1. **跨用户隔离**：单连接只投递该 `userId` 的 hint；任何他人 session 的 hint 不得串入（断言级要求）。
2. **正文最小化**：问题/回答正文不进日志、审计、problem detail 与 SSE 载荷（只留 `questionId` 与长度）；结算状态变化也不额外推送（hint 携带的是 id 与 state，不是正文）。
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
| `first_delivered_at` | TIMESTAMPTZ NULL | hint 首次交给用户通道；NULL = 尚未投递。**实现现状：CP 的 relay 路径尚无写入点，恒 NULL**（T5.25 对账发现的漂移，见表后说明） |
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

## 6a 用户问答实现现状（PLAN-0660 M5-B；2026-11-06 同批对账）

> §6 的列清单**一字不改**；本节只补已落地的语义、路由与错误码。wire 字段以 `docs/api/openapi.yaml` 为源，清单以 `docs/api/inventory.md` 为源。

### 6a.1 四态与迁移

| 迁移 | 触发者 | 落地语义 |
|---|---|---|
| `pending → answered` | `POST /api/v1/user-questions/{id}/answer`（唯一路径） | 条件更新 `state='pending' AND (expires_at IS NULL OR expires_at > now())`；CAS 成功后**同一事务**内回调 Agent（`POST /internal/v1/agent/user-question/respond`），**只有 2xx 才提交** `answered` + `answer` + `settled_at`；非 2xx/超时/连接失败一律回滚（行留在 `pending`，可重试） |
| `pending → expired` | askTimed 截止 / run 正常终态 / 迟到作答 | 迟到作答：CAS 失败后重读仍为 `pending` ⇒ 先懒结算为 `expired` 再抛 `409 QUESTION_EXPIRED`（结算在事务外，避免 409 把结算一起回滚）；run 终态非取消 ⇒ `expired` |
| `pending → cancelled` | run 终态 `cancelled`/`cancelling` | `cancelPendingForTerminalRun`：终止即取消，与「正常结束 ⇒ expired」区分 |

终态**不回滚**：`settle` 的更新只匹配 `state='pending'`，重复调用返回 0，绝不可能覆盖 `answered` 行。

### 6a.2 公开路由（3 条，均 user Bearer、**无 workspace 上下文**）

| 路由 | 语义要点 |
|---|---|
| `GET /api/v1/user-questions?state=&limit=` | **addressee-only**（`addressee_user_id = 调用者`，不是「我能看到的会话里的全部问题」）。`state` 目前**只接受 `pending`**：其余三态值（`answered`/`expired`/`cancelled`）是 `400 INVALID_REQUEST`，不是被静默忽略 ⇒ 公开面当前只有待答视图。`limit` 缺省 20、`<1` → 400、`>100` 夹到 100。响应 `{items, pendingCount}`，`pendingCount` 与 `items` **同过滤条件**、由行派生、不落计数器 |
| `GET /api/v1/user-questions/{id}` | addressee **或** 会话可见读者（`SessionReadAccess`：session owner / 已启用的受邀 HUMAN 参与者），两者拿同一响应视图；其余（含非 UUID 的 id）一律 `404 QUESTION_NOT_FOUND`，**无 403 分支** |
| `POST /api/v1/user-questions/{id}/answer` | **仅 addressee**；可见性判定**先于**正文校验（非 addressee 即使体为空/非法也恒 404，不能当校验预言机）；addressee 空/纯空白 → `400 INVALID_REQUEST`（上限 2000）；成功 200 + **结案视图**（`state=answered` + `settledAt`），不是 204；冲突码 `409 QUESTION_ALREADY_SETTLED` / `409 QUESTION_EXPIRED`；投递失败 `502 AGENT_QUESTION_DELIVERY_FAILED`（行留 `pending`） |

### 6a.3 CP → Agent 回传（1 条 internal）

`POST /internal/v1/agent/user-question/respond`（service Bearer，浏览器不得直连）：体 `{questionId, sessionId, runId, answer}`；200 = `accepted` 或 `already_delivered`（幂等重放；已投递 id 保留 1h 可重放）；Agent 侧拒绝形态 `400 INVALID_REQUEST`（空答案）/ `409 QUESTION_CONFLICT`（session 或 question 与等待中的提问不匹配）/ `404 QUESTION_NOT_FOUND`（该 run 没有等待中的提问）。CP 侧任何非 2xx、connect 5s / 请求 10s 超时、连接失败，统一 `502 AGENT_QUESTION_DELIVERY_FAILED` 并回滚；答正文**只走这条 wire**。

### 6a.4 relay 门、hint 与已知边界

1. **relay 门**（`UserQuestionService.recordPending`，被拒一律**不破流、不推 hint**）：未知 run / 所有权不符 → `502 AGENT_EVENT_ID_MISMATCH`；**子 run → `409 SUBAGENT_QUESTION_REFUSED`**（只有 root run 可问）；同 run 已有 live approval → `409 QUESTION_APPROVAL_PENDING`；同 run 已有未决问句 → `409 QUESTION_ALREADY_PENDING`。CP 日志事件：`run_question_asked` / `run_question_refused` / `run_question_relay_refused` / `run_question_answered` / `run_question_expired` / `run_question_cancelled`（只带 questionId/runId 与长度）。
2. **Agent 前置门（T5.16，LD-16=A）**：CP 派发子 run 时在 Chat 请求体带 `parentRunId`（root run **不带该键**）；`ask_user` 在发给 CP **之前**看到非空 `parentRunId` 就直接返回 `code=SUBAGENT_QUESTION_REFUSED` 的 error 结果——不产生 `session_question_asked` 事件、不进入等待。CP 侧的同码拒绝仍是兜底。
3. **结算不推送**：`user_question` hint 只在提问落库后推一次（`state=pending`）；`answered`/`expired`/`cancelled` 不改推 hint——作答方从 `POST answer` 的响应收敛，其他标签页/其他设备靠重读投影收敛。
4. **`first_delivered_at` 无写点**：relay 推 hint 时没有回写该列，当前恒 NULL（重试投递也没有落点）。这是实现与 §6 列语义的**已知缺口**，不在本轮文档批次里改代码。
5. **重复 hint 不保证去重**：同一行可能因重投递被再推一次（幂等靠读面，不靠 hint 计数）。

## 7 不扩契约

- 本文件冻结的三类面之外**不新增**事件名、计数维度或路由；用户通道之外若有新面，必须先改本文件再落码。
- 路由总量（M5 批）：**4 条 public**（`user-events` + 3 条问答）+ **1 条 internal**（Agent 回传）；`docs/api/inventory.md` 与 OpenAPI 同批登记。
- `FrozenWakeEventNameScanTest` 守护的是 `wake_*` 事件名集合，**不覆盖** `user-events` 通道；故用户通道事件名在本文件冻结，并由契约测试断言（防止后续静默新增）。

## 8 承接与验证

- 实现任务：PLAN-0660 M5-A `T5.1`（游标端点）/ `T5.2`（未读派生）/ `T5.3`（撤只增写点）/ `T5.4`（SSE 底座）/ `T5.5`（推送接入）/ `T5.6`（UI 回接）；M5-B `T5.8–T5.13`（问答组件 CP 侧）。
- 验收：`verify.md` V14（游标推进与 clamp）/ V15（用户级可见性与跨用户隔离）/ V16–V18（问答与 UI 面，原 0648 迁入）。
- 证据落点：`evidence/m5-g1-gate.md`（M5-A 波次）、`evidence/m5-b-gate.md`（M5-B）。
