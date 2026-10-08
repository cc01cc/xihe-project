# XH Execution Job scope 与 durable continuation

> 契约状态：`proposed`；实现状态：`partial`（start/list 响应、scope/幂等与 `interrupted` 对账已落地；Windows 进程引擎（PLAN-0393）已提供 Job Object 归属/有界输出/取消确认/cleanup 与 internal `jobs/cleanup`+`jobs/capabilities` 入口，`windows-host` job 已通；`windows-mxc` policy 组装（0394）、`windows-host` adapter（0395）、能力透出（0396）与 one-shot 并入引擎（0397）已落地；release/resume 与 Docker adapter（0392）未完成）；Profile：`workspace/data/security`；Owner：CP durable-record + Runtime Job owners；来源：PLAN-0390；更新：2026-09-21。
> 消费者：CP Job API/durable record、Runtime Job backend、UI Job 状态/输出/取消、Agent Workspace Job 启动

## 1. 对象边界

`ExecutionJob` 是 Workspace 级可追踪执行事实，不等同于 ChatRun、Session 或 Runtime backend handle。

| 对象 | 关系 |
|---|---|
| `workspace_jobs` | Job 的 canonical durable row；`id` 是 domain `jobId`，保存 Workspace/Session/Run scope、幂等与状态 |
| `workspace_job_history` | 单 Job 的 append-only 状态变化 |
| `state` JSONB | CP 管理的 Job state/error/output metadata；不是跨域 Operation extension |
| `JobHandle` | Runtime backend 的 opaque handle；不作为 CP 业务 identity（契约见 [`../../../plans/PLAN-0390-XH-execution-job-backends/spec/job-handle-contract.md`](../../../plans/PLAN-0390-XH-execution-job-backends/spec/job-handle-contract.md)） |
| ChatRun/Session | 可选 initiator/provenance；不决定所有 Job 的生命周期 |

`jobId` 是唯一 canonical domain identity（`workspace_jobs.id`）。Runtime backend handle 用 `runtimeJobId` 表示，不可与 domain ID 混用。V52 的 `operation_item_id` transition anchor 已由 V55 删除；旧 Ledger 历史不回填。

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

- 本批 Docker backend 保持字面量 `succeeded` / `timeout` / `orphaned`；归一化为 `completed` / `failed` / `timed_out` 由后续 adapter 批次承接。PLAN-0393 引擎内部产 `timed_out`，**HTTP 响应折回 wire 的 `timeout`**（CP 状态机暂只认后者），durable 归一化待 CP 批次。
- `interrupted` 是 CP durable 终态：Runtime 重启或派发未确认；**不自动重放**。
- `cleanupStatus` 独立记录 `not_started/running/completed/failed`。清理失败不伪造成功，也不触发自动 replay。
- `cancelReason` 取值：`user_cancel` / `scope_run_end` / `scope_session_stop` / `workspace_destroy` / `runtime_restart` / `destroy_orphan` / `job_missing`。

## 4. Authority 与恢复

- CP 的 `workspace_jobs`/`workspace_job_history` 是 Job 业务事实源和唯一 durable writer；`backendKind`/`executionMode` 支持 `docker | windows-mxc | windows-host`。
- Runtime 返回执行事实、输出、backend diagnostics 和 cleanup 结果；不写 CP DB。
- HTTP/SSE 是命令、查询和通知通道，不是状态真相。
- Client/SSE 断线不改变 Job 状态；Runtime 重启未确认终态时标记 `interrupted`，不自动重放。
- 对账判据：Runtime `bootId`（`GET /internal/v1/runtime/diagnostics`）与档案 `runtimeBootId` 不一致 → 该 Job 落 `interrupted`（`cancelReason=runtime_restart`）。

## 5. Canonical API

- **Start**：`POST /api/v1/workspaces/{workspaceId}/jobs`，header `Idempotency-Key` 必填，body `{command, args, cwd, timeoutSecs, scope, sessionId, runId, source, env}`（仅 `command` 必填）。同 key 重放返回既有 Job 响应（`200`，不产生第二个进程）；同 key 不同 `command/args/cwd/timeoutSecs` → `409 JOB_IDEMPOTENCY_CONFLICT`；缺 header → `400 IDEMPOTENCY_KEY_REQUIRED`；无 access/不存在 → `404 WORKSPACE_NOT_FOUND`；无 launcher 的 backend → `501 JOB_BACKEND_LAUNCH_PENDING`（不建 durable Job）；派发未确认 → `502 RUNTIME_UNAVAILABLE`（档案落 `interrupted`）。响应中的 `jobId` 是 domain ID，`runtimeJobId` 是 Runtime backend handle。
- **Runtime start contract**：CP→Runtime request 用 `{jobId, command, args, cwd, timeoutSecs, env}`；Runtime response 回显同一 `jobId`，另返回 `runtimeJobId` backend handle、`status` 与 `bootId`。CP 拒绝 jobId 回显不匹配的响应。
- **List**：`GET /api/v1/workspaces/{workspaceId}/jobs` 返回 Workspace-scoped Job 响应（start 响应同形），字段 `jobId, runtimeJobId, workspaceId, sessionId, runId, source, scope, status, startedAt, endedAt, exitCode, timeoutSecs, cancelReason, backendKind, executionMode, actorType, createdAt, cleanupStatus, errorCode`。
- **续看/取消**：`GET /api/v1/workspaces/{workspaceId}/jobs/{jobId}/output` 与 `POST /api/v1/workspaces/{workspaceId}/jobs/{jobId}/cancel` 以 domain `jobId` 为 public route key；CP 根据 row 内的 `runtimeJobId` 调用 Runtime。所有状态变更仅记入 `workspace_job_history`。
- 引擎入口（internal，PLAN-0393）：`.../jobs/cleanup`（`CleanupResult`：outcome/reason/processes）与 `.../jobs/capabilities`（0390 形能力，含 `unavailableReason`）；进程 Job 的 handle 与有界输出**不跨 Runtime 重启**（重启后 404/`available=false`，不重放）。
- 所有 public route 使用 `/api/v1`、Bearer、Workspace access check 和 RFC 9457 Problem Details。

完整字段与 OpenAPI 以 [`docs/api/openapi.yaml`](../../docs/api/openapi.yaml) 与 [`docs/api/inventory.md`](../../docs/api/inventory.md) 为准；Flyway 与 adapter 细节由 PLAN-0390 与 PLAN-0392–0395 落地后同步。
