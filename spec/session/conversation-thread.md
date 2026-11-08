# Session conversation thread (MVP)

> Status: `active` (MVP contract, PLAN-0646 / D-671, 2026-11-08)  
> Implementation: `partial` — user/agent scopes implemented; workspace audience (`workspace:message:receive`) is deferred (V4/V5).  
> Owner: CP/Session owner  
> Consumers: UI composer/sidebar (later), CP thread API, PLAN-0647 (session without workspace).

## 1. 术语与边界

- **对话线（thread）**：跨 session 延续的一段对话；`1 thread : N sessions`，session 仍是工作现场（文件/checkpoint/run 隔离）。
- **通信作用域（message scope）**：线按哪一层寻址 —— 三档 `user` / `agent` / `workspace`（用户 2026-11-03 冻结）。
- 本契约**不**引入消息表、群组概念、新授权原子；消息仍归 session，作用域只存线实体。

## 2. 数据形状（V144）

- `conversation_threads(id uuid pk, scope_type varchar(16), scope_id uuid, created_by_user_id uuid, title varchar(255), created_at, updated_at)`。
- `scope_type` 由 DB CHECK 约束为 `user|agent|workspace`；`scope_id` 是多态 UUID（无 FK；与 `session_participants(principal_kind, principal_id)` 同形状）。
- `sessions.conversation_thread_id uuid NULL` + FK `ON DELETE SET NULL` + 部分索引 `WHERE conversation_thread_id IS NOT NULL`。
- **MVP 有意可空**（V1/V6）：存量 session 保持 `NULL`、行为逐项不变；clean-slate 的 `NOT NULL`/`RESTRICT` 变体对本 MVP 记为 `superseded`。

## 3. 可见性与写入（MVP）

| scope | 读 | 写（attach） | 证据 |
|---|---|---|---|
| `user` | `created_by_user_id == 当前用户`；其他用户 → `404 THREAD_NOT_FOUND` | session owner（`sessions.user_id == 当前用户`） | `ThreadAccessService`、`ConversationThreadMvpIntegrationTest` |
| `agent` | `scope_id` 指向的 agent principal 的 owner（`owner_user_id`，缺省 `created_by_user_id`）可读；其他用户 → 404 | 同上，且创建时 `scope_id` 必须是自己的主体 | 同上 |
| `workspace` | **fail-closed** `403 THREAD_SCOPE_UNRESOLVED`（V4 延后） | 创建与 attach 同样 403 | 同上 |

- attach 语义（D-671 #3）：同 thread 重复 attach ⇒ **200 幂等**（`changed=false`）；attach 到另一 thread ⇒ **覆盖**（旧关系只解绑、不级联删除）；非 owner ⇒ `403 THREAD_WRITE_FORBIDDEN`。
- 读取路径**不得**读角色名/`isInstanceAdmin`/capability 字符串特判；`ThreadScopeResolutionScanTest` 静态钉死。

## 4. API（最小面）

- `POST /api/v1/conversation-threads` body `{scopeType, scopeId, title?}` → `201` thread；`400 THREAD_SCOPE_INVALID`（形状/枚举）、`403 THREAD_SCOPE_UNRESOLVED`（workspace）、`403 THREAD_WRITE_FORBIDDEN`（scope 不属自己）。
- `GET /api/v1/conversation-threads/{threadId}` → `200` thread（含 `sessions[]`）；`404 THREAD_NOT_FOUND`（不存在或不可见）、`403 THREAD_SCOPE_UNRESOLVED`（workspace）。
- `POST /api/v1/conversation-threads/{threadId}/sessions` body `{sessionId}` → `200` thread + `{attachedSessionId, changed}`；`403 THREAD_WRITE_FORBIDDEN`、`404 SESSION_NOT_FOUND`/`THREAD_NOT_FOUND`。

## 5. 不变式

- session 创建路径（`SessionCreateRequest`/`POST /api/v1/sessions`）**不变**；thread 只能通过 attach 建立，存量会话零变更。
- 不放大既有授权：thread scope 不是授权作用域，不替代 `GrantAuthorizationService`；workspace 档不接 `workspace:message:receive`（V4 延后，`superseded` 到全量 thread 语义）。
- 交叉范围（0645/0648/0676）本 MVP 冻结，不实施。
