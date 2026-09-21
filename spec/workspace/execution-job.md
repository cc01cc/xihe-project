# XH Execution Job scope 与 durable continuation

> 契约状态：`proposed`；实现状态：`partial`（start/list projection、scope/幂等与 `interrupted` 对账已落地；backend JobHandle/adapter、release/resume 未完成）；Profile：`workspace/data/security`；Owner：CP durable-record + Runtime Job owners；来源：PLAN-0390；更新：2026-09-21。

## 1. 对象边界

`ExecutionJob` 是 Workspace 级可追踪执行事实，不等同于 ChatRun、Session、Operation root 或 Runtime backend handle。

| 对象 | 关系 |
|---|---|
| `ledger_operations` | Job 的审计根，`kind=job`，`workspace_id` 必填，`session_id/run_id` 可空 |
| `operation_items` | Job 的 canonical durable item，`kind=job` |
| `job_state` extension | Job 状态/后端/输出游标/错误载荷，`schema_version=1`，由 CP 独占写入 |
| `JobHandle` | Runtime backend 的 opaque handle；不作为 CP 业务 identity（契约见 [`../../../plans/PLAN-0390-XH-execution-job-backends/spec/job-handle-contract.md`](../../../plans/PLAN-0390-XH-execution-job-backends/spec/job-handle-contract.md)） |
| ChatRun/Session | 可选 initiator/provenance；不决定所有 Job 的生命周期 |

`operationItemId` 是 canonical Job identity。历史 Docker `jobId`、MXC wrapper PID、Host process handle 只作为 backend diagnostics。

## 2. Scope 与收口

`scope` 取 `run | session | workspace`，缺省 `session`，是 Job 的存活边界：

| scope | 存活边界 | 收口触发 | `cancelReason` |
|---|---|---|---|
| `run` | 不跨 ChatRun | run 进入终态 | `scope_run_end` |
| `session` | 跨 run、不跨 Session | session 硬删 | `scope_session_stop` |
| `workspace` | 跨 Session、不跨 Workspace | Workspace 逻辑删除（销毁路径） | `destroy_orphan` |

收口一律 best-effort 调 Runtime cancel；无法确认时保留显式未确认状态，不静默成功、不跨 scope 越界。`workspaceId` 是资源归属与 access check，不等于 scope。Workspace access 成员均可查看/控制该 Workspace Job；本契约不新增 Job-specific owner/admin 角色。

## 3. 状态与终态

```text
pending -> running
running -> succeeded | cancelled | timeout | orphaned | interrupted
```

- 本批 Docker backend 保持字面量 `succeeded` / `timeout` / `orphaned`；归一化为 `completed` / `failed` / `timed_out` 由后续 adapter 批次承接。
- `interrupted` 是 CP durable 终态：Runtime 重启或派发未确认；**不自动重放**。
- `cleanupStatus` 独立记录 `not_started/running/completed/failed`。清理失败不伪造成功，也不触发自动 replay。
- `cancelReason` 取值：`user_cancel` / `scope_run_end` / `scope_session_stop` / `workspace_destroy` / `runtime_restart` / `destroy_orphan` / `job_missing`。

## 4. Authority 与恢复

- CP durable ledger 是 Job 业务事实源和唯一 durable writer；`backendKind`/`executionMode` 支持 `docker | windows-mxc | windows-host`。
- Runtime 返回执行事实、输出、backend diagnostics 和 cleanup 结果；不写 CP DB。
- HTTP/SSE 是命令、查询和通知通道，不是状态真相。
- Client/SSE 断线不改变 Job 状态；Runtime 重启未确认终态时标记 `interrupted`，不自动重放。
- 对账判据：Runtime `bootId`（`GET /internal/v1/runtime/diagnostics`）与档案 `runtimeBootId` 不一致 → 该 Job 落 `interrupted`（`cancelReason=runtime_restart`）。

## 5. Canonical API

- **Start**：`POST /api/v1/workspaces/{workspaceId}/jobs`，header `Idempotency-Key` 必填，body `{command, args, cwd, timeoutSecs, scope, sessionId, runId, source, env}`（仅 `command` 必填）。同 key 重放返回既有 projection（`200`，不产生第二个进程）；同 key 不同 `command/args/cwd/timeoutSecs` → `409 JOB_IDEMPOTENCY_CONFLICT`；缺 header → `400 IDEMPOTENCY_KEY_REQUIRED`；无 access/不存在 → `404 WORKSPACE_NOT_FOUND`；无 launcher 的 backend → `501 JOB_BACKEND_LAUNCH_PENDING`（不建 durable Job）；派发未确认 → `502 RUNTIME_UNAVAILABLE`（档案落 `interrupted`）。
- **List**：`GET /api/v1/workspaces/{workspaceId}/jobs` 返回 Workspace-scoped Job projection（start 响应同形）；projection 字段为 `operationId, operationItemId, workspaceId, sessionId, runId, source, scope, status, jobId, startedAt, endedAt, exitCode, timeoutSecs, cancelReason, backendKind, executionMode, actorType, createdAt, cleanupStatus, errorCode`，与 `job_state` payload 的区别仅是后者多 `runtimeBootId`。
- **续看/取消**：`GET /api/v1/operations/items/{itemId}/job-output`、`POST /api/v1/operations/items/{itemId}/cancel` 复用既有 operation 子资源（`operationItemId` 为键），不新增 `/api/v1/jobs/{jobId}` 平行 identity。
- 所有 public route 使用 `/api/v1`、Bearer、Workspace access check 和 RFC 9457 Problem Details。

完整字段与 OpenAPI 以 [`docs/api/openapi.yaml`](../../docs/api/openapi.yaml) 与 [`docs/api/inventory.md`](../../docs/api/inventory.md) 为准；Flyway 与 adapter 细节由 PLAN-0390 与 PLAN-0392–0395 落地后同步。
