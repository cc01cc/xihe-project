# Workspace 任务板语义（Task Board Semantics）

> 契约状态：`active`（由 PLAN-0686 M0 T0.3 冻结，2026-11-07）；实现状态：`unimplemented`（M1 实施；建表 V134 在 PLAN-0689 V133 之后）；Profile：`workspace/lifecycle/protocol`；Owner：CP 任务板（durable record + API）；来源：PLAN-0686 决策 D-23~D-27；更新：2026-11-07。
> 消费者：CP 任务板 API/durable record、UI 任务板、Agent workspace 工具（后续）、Security（`WORKSPACE_TASK_READ`/`WORKSPACE_TASK_WRITE` 原子与默认授予集）。

本文件是 workspace 级任务板的唯一权威；PLAN-0686 M1 实施不得自行改语义。

范围：workspace 级 durable task board；不引入 session/run，不接死表 `task_plans`/`task_items`。

## 1. 裁定（D-23~D-27）
- **D-23 owner**：唯一归属键 `workspace_id`；`owner_user_id UUID NULL`，FK `users(id) ON DELETE SET NULL`。unowned 合法；owner 目标只校验 `users(id)`，不额外做 workspace 成员校验；**不得改用 principal**（PLAN-0689 正从会话面移除 principal，workspace 层不重新引入）。
- **D-24 状态机**：落库仅 `todo|in_progress|done`；`blocked` 不落库，由未完成 `blocked_by` 派生（任一依赖非 `done` 即 true），仅用于展示/筛选，不改状态。
- **D-25 冲突/环**：CAS 冲突 → `409 WORKSPACE_TASK_REVISION_CONFLICT`（回 `currentRevision`）；自依赖/成环 → `400 WORKSPACE_TASK_DEP_CYCLE`；依赖必须同 workspace（缺失/跨区 → `400 WORKSPACE_TASK_DEP_INVALID`）。
- **D-26 原子/审计**：`WORKSPACE_TASK_READ` / `WORKSPACE_TASK_WRITE`；默认集见 §5；命中审计落 `audit_logs.action='authorization_atom_hit'`（D-47，0 新表）；动作写 `workspace_task_*`，detail 仅 `actor_user_id/workspace_id/task_id/revision/changed_fields`，**无 session_id/run_id**。
- **D-27 SSE/读回**：事件 `workspace_task.created|updated|deleted`（snake_case 点分）；载荷=完整任务视图+revision；列表 cursor `after`/`limit`（默认 50、上限 200），`snapshot_required` 累计上限 500。

## 2. 表结构
```sql
CREATE TABLE workspace_tasks (
  id            UUID PRIMARY KEY,
  workspace_id  UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  subject       VARCHAR(200) NOT NULL CHECK (length(btrim(subject)) > 0),
  description   TEXT NOT NULL DEFAULT '',
  status        VARCHAR(16) NOT NULL DEFAULT 'todo'
                CHECK (status IN ('todo','in_progress','done')),
  owner_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  write_scopes  TEXT[] NOT NULL DEFAULT '{}',
  revision      INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_workspace_tasks_ws_status ON workspace_tasks (workspace_id, status);
CREATE INDEX idx_workspace_tasks_ws_cursor ON workspace_tasks (workspace_id, created_at DESC, id DESC);

CREATE TABLE workspace_task_deps (
  task_id            UUID NOT NULL REFERENCES workspace_tasks(id) ON DELETE CASCADE,
  blocked_by_task_id UUID NOT NULL REFERENCES workspace_tasks(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, blocked_by_task_id),
  CHECK (task_id <> blocked_by_task_id)
);
CREATE INDEX idx_workspace_task_deps_blocked_by ON workspace_task_deps (blocked_by_task_id);
```

- 同 workspace 仅 service 校验；DB 只保证 FK/PK/自依赖。V134 只建两表；无对死表 FK。
- `revision` 变更（含 `blocked_by` 增删）统一 CAS +1；**迁移（V134）前置 = PLAN-0689 `V133` 已落**，未落不抢号。
- 无 `session_id`/`run_id`；所有新 G6 文件 `rg` 0 命中。

## 3. 状态转移
| from | to | 动作 | 允许 |
|---|---|---|---|
| todo | in_progress | start | ✅ |
| in_progress | todo | pause | ✅ |
| in_progress | done | complete | ✅ |
| done | todo | reopen | ✅ |
| todo | done | — | ❌ 禁止跳级 |
| done | in_progress | — | ❌ 先 reopen |
| 其他 | 其他 | — | ❌ |

- 每次 PATCH/action 必带 `revision`；CAS 成功后 +1。`claim/reassign/release` 只改 owner；status 只经 PATCH 转移；`complete` 仅 `in_progress→done`。
- `blocked` 不参与转移门禁（本版不新增 `WORKSPACE_TASK_BLOCKED`）；若后续要硬门禁，另立裁定。

## 4. 错误码
| HTTP | code | 触发 |
|---|---|---|
| 400 | WORKSPACE_TASK_INVALID | 字段/分页/owner 非法 |
| 400 | WORKSPACE_TASK_STATE | 非法状态转移 |
| 400 | WORKSPACE_TASK_DEP_CYCLE | 自依赖/成环 |
| 400 | WORKSPACE_TASK_DEP_INVALID | 依赖缺失/跨 workspace |
| 403 | WORKSPACE_TASK_FORBIDDEN | 无 atom 或非成员 |
| 404 | WORKSPACE_TASK_NOT_FOUND | 任务不存在/不属于该 workspace |
| 409 | WORKSPACE_TASK_REVISION_CONFLICT | revision 不匹配，带 currentRevision |

## 5. 原子与默认集
| 角色 | READ | WRITE |
|---|---|---|
| SUPER_ADMIN | ✅ | ✅ |
| ADMIN | — | — |
| USER | — | — |
| WS_OWNER | ✅ | ✅ |
| WS_EDITOR | ✅ | ✅ |
| WS_VIEWER | ✅ | — |
| AGENT_DELEGATOR / AGENT_USER | — | — |

- `scope_class=both`；不进 `READ_TOOLS/WRITE_TOOLS`；授权只 `holdsActionAtom` + workspace 上下文，禁止角色名特判。
- 29→31 同批：`builtinActionClasses()`、`ACTION_ATOM_NAMES`、`SkillReadFaceTest:32`、`P0ManagementAtomSeedMigrationTest:174`；新增 `WorkspaceTaskDefaultSetTest` 锁 6 个 workspace 格。
- `authorization_atom_hit` detail：`atom/grant_source/workspace_id/task_id`；动作审计：`workspace_task_created|updated|deleted|claimed|released|reassigned|completed|reopened`；`changed_fields` create/delete=`*`、update=实际字段名。

## 6. API / SSE / 分页
- 路由：`GET/POST /api/v1/workspaces/{workspaceId}/tasks`；`GET/PATCH/DELETE .../{taskId}`；`POST .../{taskId}/claim|release|reassign|complete`；camelCase。
- 视图：`{id, workspaceId, subject, description, status, ownerUserId, writeScopes, blockedBy, blocked, revision, createdAt, updatedAt}`；`ownerUserId` 可空；`blockedBy` 为任务 id 数组；PATCH 只改 subject/description/writeScopes/blockedBy/status（blockedBy 全量替换），owner 只走 action；无 session/run。
- 列表：`?after=<opaque>&limit=<1..200>`，默认 50；排序 `created_at DESC, id DESC`；`after` 为上一页末条的不透明 cursor；响应 `{items, nextCursor}`。
- `snapshot_required`：从空 cursor 逐页拉取，单页 ≤200，累计 ≤500；超过 500 停止并提示截断。
- SSE：`WorkspaceEvent` 增加可空 `payload`；created/updated 载荷=上述完整视图，deleted 载荷=删除前最后视图+revision；`path/changeType` 为 null，source=`control-plane`；三种 kind 均进 `validateKind`。
- 收到事件：created/updated 以 payload upsert；deleted 按 id 移除；`snapshot_required` 走全量 refetch。
