---
name: dev-host-verification
description: '[Scope: A03-xihe] 验证 Windows native + Docker dev:host 的 Runtime readiness、M1 Sandbox/WorkspaceStorage、Playwright host profile 和可恢复清理。适用于 Xihe Runtime 调试与 E2E 排查。'
---

# Dev-Host Verification — Xihe M1

`M1`（`M1a/b/c`）在 `dev:host` 的四层验证曾需手工串联 `cargo`/`docker`/`Playwright`。本 skill 固化验证顺序、host/Compose 边界、Runtime readiness 门和可恢复清理要求；它不把日常开发数据库当作隔离的 E2E 数据库。

## 四层

| 层 | 命令 | 判定 |
|----|------|------|
| 纯逻辑 | `cargo test --lib` | Runtime library tests pass; do not hard-code an old count in the skill |
| 挂载 | `cargo test --test m1b_mount_test -- --nocapture` | `sentinel` host/container content and writability agree |
| 隔离 | `cargo test --test m1c_strict_test -- --nocapture` | Strict `network none` and both probes pass |
| 端到端 | `POST /internal/v1/runtime/workspaces` → `docker ps` → read `/workspace/.xihe-sentinel` → delete | Native Runtime, Docker Sandbox and `XIHE_WORKSPACE_HOST_ROOT` are all in the same topology |
| 真机 UI | `mise run test:e2e:host` or a named `@host` Playwright file | Browser evidence is reported separately from Compose and includes readiness/cleanup |

## Host Preconditions

Before running host-only tests:

1. Start PostgreSQL and native CP/Agent/Runtime/UI with `mise run dev:host`.
2. Verify CP `/actuator/health`, Agent `/internal/v1/agent/health`, Runtime `/health`, Runtime `/ready`, and UI root separately. `/health` is liveness; `/ready` means assignment hydrate/reconcile has completed.
3. Build `xihe/workspace:latest` when a test creates a Sandbox container.
4. Use an isolated E2E database or a controlled assignment set. The daily database accumulates assignments, and serial cold hydrate can keep `/ready` at `503` long enough to prevent Playwright from starting.
5. Record profile, ports, assignment count, readiness result, test count, and cleanup result.

## Commands

```toml
[tasks."test:e2e:host"]
run = "node scripts/e2e-host.mjs"
description = "Run host-only real E2E after Runtime readiness"
```

```powershell
cargo test --lib
cargo test --test m1b_mount_test -- --nocapture
cargo test --test m1c_strict_test -- --nocapture
mise run dev:host
mise run test:e2e:host
```

需 Docker Desktop 运行且 `xihe/workspace:latest` 已构建。Compose profile 不提供 Runtime-created Sandbox 所需的 Docker socket 和 host storage 映射，不能用 Compose 结果替代 host evidence。

## Cleanup and Evidence

- `scripts/e2e-host.mjs` 失败时必须保留 readiness、最近 hydrate/reconcile 和 Playwright 是否启动的结果。
- 停止 host 栈使用 `pwsh -File scripts/dev-host.ps1 -Stop`；它可以移除 Sandbox 容器，但必须保留 `XIHE_WORKSPACE_HOST_ROOT` 下的文件。
- 不要清空日常数据库或删除 host workspace 作为隐式测试前置。若需要重置，先创建隔离 DB/volume 或获得明确的数据处置确认。
- 截图 baseline、actual/diff、trace 和日志分别记录来源；baseline 通过不等于人工 UI 审查通过。
