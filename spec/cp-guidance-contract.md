# CP Guidance 契约（T0.1 冻结，2026-10-18）

> 本文件是 PLAN-0528 的 wire/schema 唯一冻结件（用户裁定 3A：精确字段由本子 PLAN 冻结）。实施者与下游（0529/0530）以本文件为准；变更走 design 决策行。
> 母体契约：`../../../plans/PLAN-0468-xh-chat-run-guidance/spec/target-contract.md`。已裁定：仅 user 来源（1A）、`sequence` 顺序追加（2A）、CP Chat 域新表（4A）、**无 Guidance 专属 SSE 事件**（候选①）。

## 1. 持久模型

表 `chat_run_guidance`（Flyway V77，forward-only）：

| 列 | 类型 | 约束/说明 |
|---|---|---|
| `id` | `uuid` | PK |
| `session_id` | `uuid` | NOT NULL，来自 Run（派生，非客户端传入） |
| `run_id` | `uuid` | NOT NULL，目标 ChatRun |
| `branch_id` | `uuid` | NOT NULL，来自 Run 的当前 branch（派生；仅作 run-scoped 读取对齐，禁客户端传入） |
| `source_kind` | `text` | NOT NULL，**`CHECK (source_kind = 'user')`**（fail-closed；guard 接入须新迁移 + Security 立项） |
| `author_principal_id` | `uuid` | NOT NULL，提交者（=当前认证用户） |
| `body_markdown` | `text` | NOT NULL，长度 ≤ `8000` 字符（DB CHECK） |
| `sequence` | `bigint` | NOT NULL，Run 内单调递增（1 起，取 `max(sequence)+1`，行锁内） |
| `status` | `text` | NOT NULL，`pending` / `consumed` / `terminal_expired`（snake_case，对齐 ChatRun 状态风格） |
| `idempotency_key` | `text` | NOT NULL（`Idempotency-Key` 头）；`(run_id, idempotency_key)` 部分唯一（仅对未 rejected 的落库行） |
| `created_at` / `updated_at` | `timestamptz` | NOT NULL DEFAULT now() |
| `consumed_at` | `timestamptz` | NULL（consumed 时写） |
| `terminal_expired_at` | `timestamptz` | NULL（terminal_expired 时写） |

索引：`(run_id, sequence)` 唯一；`(run_id, status)` 普通（Agent pending 读取）；`(session_id)` 普通。

## 2. 状态机（唯一入口：service transition）

- `pending → consumed`：仅 Agent consume 端点（M3）；写 `consumed_at`。重复 consume = **幂等成功**（同状态 200，不重复写时间）。
- `pending → terminal_expired`：仅 Run 终态收敛路径，**与 Run 终态转换同事务**（先例 `followUpQueueService.settleTerminal`）+ 启动恢复一次性收敛存量；写 `terminal_expired_at`。
- `consumed` 与 `terminal_expired` 互斥终态；迁移后不可再变。
- 无 `rejected` 落库态：提交期校验失败直接 4xx，不入库。

## 3. 公开路由（`/api/v1`，用户 JWT 鉴权）

### 3.1 `POST /api/v1/chat/runs/{runId}/guidance`

- 请求头：`Idempotency-Key`（必填；缺失 400）。
- 请求体：`{ "content": string }`（**不含 sourceKind**；服务端恒置 `user`）。`content` 空白/超 8000 字符 → 422。
- 校验与作者派生：runId 存在 → Run 属调用者可见 session/workspace → Run 状态 ∈ 允许集合 → 派生 author = 当前用户。
- **允许提交的 Run 状态集合（冻结）**：`running`、`streaming`、`awaiting_approval`。显式排除：`accepted`、`queued`（无可达规划边界）、`cancelling`（即将终态，提交会产生立即失效记录）、全部终态。
- 成功 `201`：`{ "id", "runId", "sessionId", "sequence", "status": "pending", "createdAt" }`（**不含正文回显**——快照端点负责）。
- 幂等重放：同 `(runId, Idempotency-Key)` → `200` 返回原记录（不新建）。
- 错误：`404` run 不存在/不可见；`403` 非本工作区/越权；`409 { "errorCode": "GUIDANCE_RUN_NOT_ACTIVE" }` 状态不在允许集合；`400` 缺 Idempotency-Key；`422` content 非法。

### 3.2 `GET /api/v1/chat/runs/{runId}/guidance`

- 返回该 Run 的 Guidance 快照（按 `sequence` 升序）：`{ "items": [ { "id", "sequence", "sourceKind", "status", "createdAt", "consumedAt", "terminalExpiredAt", "authorPrincipalId", "content" } ], "latestSequence" }`。
- 越权 → `403`；run 不可见 → `404`。
- **无 SSE 事件**（候选①）：UI 刷新时机 = 提交后 refetch + Run 终态事件时 refetch。

## 4. 内部路由（服务间，`Authorization: Bearer <service token>`）

### 4.1 `GET /internal/v1/chat/runs/{runId}/guidance/pending`

- 返回 `status=pending` 的条目（`sequence` 升序，全部），体：`{ "runId", "items": [ { "id", "sequence", "sourceKind", "content" } ] }`。
- Agent 侧以 `id` 做注入去重键；`sourceKind` 首版恒 `user`（预留位）。
- run 不存在 → `404`。

### 4.2 `POST /internal/v1/chat/runs/{runId}/guidance/{guidanceId}/consume`

- 语义：`pending → consumed`。请求体：`{ "consumedBy": "agent-runner" }`（预留，便于审计区分消费方）。
- `200`：`{ "id", "status": "consumed", "consumedAt" }`（首次或重复，幂等）。
- `409 { "errorCode": "GUIDANCE_ALREADY_TERMINAL_EXPIRED" }`：条目已 terminal_expired（Agent 收到此码**必须停止重试且不再注入**）。
- `404`：run/guidance 不存在。

## 5. 日志与脱敏

- 任何日志只允许 `id/sequence/sourceKind/status/runId`；**禁止记录 `content`（body_markdown）原文**（不可信请求正文）。

## 6. 与相邻机制边界

- 不复用 EventStore/Operation audit；不复用 Follow-up Queue 状态；不新增 SSE 事件类型（候选①）；不改变取消/审批/续跑端点。
- 续跑（0510）新 Run 读不到源 Run 的 pending Guidance（runId 隔离 + terminal 收敛）；已消费条目**不在**本表迁移。
