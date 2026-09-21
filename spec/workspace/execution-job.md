# XH Execution Job scope 与 durable continuation

> 契约状态：`proposed`；实现状态：`unimplemented`；Profile：`workspace/data/security`；Owner：CP durable-record + Runtime Job owners；来源：PLAN-0390；更新：2026-09-21。

## 1. 对象边界

`ExecutionJob` 是 Workspace 级可追踪执行事实，不等同于 ChatRun、Session、Operation root 或 Runtime backend handle。

| 对象 | 关系 |
|---|---|
| `ledger_operations` | Job 的审计根，`kind=job`，`workspace_id` 必填，`session_id/run_id` 可空 |
| `operation_items` | Job 的 canonical durable item，`kind=job` |
| `job_state` extension | Job 状态/后端/输出游标/错误载荷，挂在 Job item 上 |
| `JobHandle` | Runtime backend 的 opaque handle；不作为 CP 业务 identity |
| ChatRun/Session | 可选 initiator/provenance；不决定所有 Job 的生命周期 |

`operationItemId` 是 canonical Job identity。历史 Docker `jobId`、MXC wrapper PID、Host process handle 只作为 backend diagnostics。

## 2. Scope

`scope` 是 Job 的存活边界：

| scope | 存活边界 | 收口事件 |
|---|---|---|
| `run` | 不跨 ChatRun | run 五态终态 |
| `session` | 跨 run、不跨 Session | session 中止/硬删；重新激活不恢复 Job |
| `workspace` | 跨 Session、不跨 Workspace | Workspace destroy；release 由 Workspace lifecycle contract 处理 |

`workspaceId` 是资源归属与 access check，不等于 scope。Workspace access 成员均可查看/控制该 Workspace Job；本契约不新增 Job-specific owner/admin 角色。

## 3. 状态与终态

```text
pending -> running
running -> completed | failed | timed_out | cancelled | interrupted
```

`cleanupStatus` 独立记录 `not_started/running/completed/failed`。清理失败不伪造成功，也不触发自动 replay。

历史映射：`succeeded -> completed`、`timeout -> timed_out`、`orphaned -> interrupted`；v1 缺少 scope 时按 `session` 读取并登记兼容状态。

## 4. Authority 与通道

- CP durable ledger 是 Job 业务事实源和唯一 durable writer。
- Runtime 返回执行事实、输出、backend diagnostics 和 cleanup 结果；不写 CP DB。
- HTTP/SSE 是命令、查询和通知通道，不是状态真相。
- Client/SSE 断线不改变 Job 状态；Runtime 重启未确认终态时标记 `interrupted`，不自动重放。

## 5. Canonical API

- Workspace Job 创建/列表使用 Workspace public projection 和 `Idempotency-Key`。
- Job detail/output/cancel 继续复用 `operationItemId` 既有 operation 子资源。
- 所有 public route 使用 `/api/v1`、Bearer、Workspace access check 和 RFC 9457 Problem Details。

完整字段、OpenAPI、Flyway 和 adapter 细节由 PLAN-0390 与 PLAN-0392–0395 落地后同步。
