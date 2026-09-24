# Package: xihe-runtime

文件系统、沙盒、进程管理 — Rust 沙盒服务。基于 rmcp + Axum + Tokio + bollard。

## Tech Stack

- **Rust** 1.97.1（edition 2024，rmcp 3.1.4；`rust-toolchain.toml` 固定）— 编译语言
- **Cargo** — 构建/测试
- **rmcp** — MCP 服务器框架
- **Axum** — HTTP 服务器
- **Tokio** — 异步运行时
- **bollard** — Docker API 客户端
- **rustix** — `openat2` FS 安全 helper（`fs` feature，仅 Linux 容器内）
- **cargo test + clippy** — 测试/lint

## Commands

### File-Scoped
- Unit test: `cargo test --lib test_name`
- Lint single file: `cargo clippy -- -W clippy::pedantic`

### Full Suite
- `cargo build` — 编译
- `cargo test` — 全部测试（lib + integration）
- `cargo clippy --all-targets -- -D warnings` — lint（门禁口径；`mise run lint:runtime` = fmt check + 本条）
- `cargo fmt` — 格式化；校验用 `cargo fmt --check`
- 工具链由 `rust-toolchain.toml` 固定 1.97.1（与 `mise.toml` `[tools].rust` 一致）

## Project Structure

```
src/
├── main.rs            # 入口（路由注册 + 配置轮询 + WorkspaceExecutionRouter）
├── lib.rs             # 库根
├── executor.rs        # WorkspaceExecutionRouter（per-request Docker exec 封装）
├── gateway.rs         # Runtime Gateway（per-workspace 分发）
├── fs.rs              # 文件系统操作（rustix openat2 helper）
├── sandbox.rs         # 沙盒实现（artifact store，BackgroundProcess frozen v1 schema）
├── workspace.rs       # 容器 + bridge 生命周期（Strict network-none + per-request exec）
├── container_runtime.rs # 容器内 xihe-container-runtime（oneshot CLI + /tmp/xihe-jobs；HTTP daemon 已退役）
├── inventory.rs       # 启动时 negative fallback 扫描
├── job_engine/        # PLAN-0393 Windows 进程 Job 引擎（Job Object 归属/有界输出/取消与清理；FFI 单点 unsafe）
├── backend.rs         # SandboxBackend 接缝（ensure/destroy/execute/capabilities；Docker 单实现）
├── mcp_session.rs     # stdio MCP 会话（exec attach 直连；状态机/预算/kill 回收）
├── remote_mcp.rs      # 远程 MCP 出网
├── ws_file_handler.rs # workspace 文件处理
├── workspace_events.rs # host notify watcher（materialize/direct-attach 后安装，有界队列 + 防抖合并；overflow → `snapshot_required`/`reason=overflow`；销毁/eviction 时停止）
├── fetch.rs           # HTTP 出网
├── log_redact.rs      # 日志脱敏
└── error.rs           # 错误处理
```

Runtime MCP session 的项目级 proposed 生命周期边界见 `../../spec/session/mcp-session.md`；当前实现以代码及 [DEV-015](../../docs/i18n/zh-Hans/DEV-015-runtime-architecture.md)/DEV-016 为准。

## Key Conventions

- `snake_case` 命名（Rust 标准）
- MCP endpoint 通过 rmcp 自动注册
- 配置文件通过 ConfigClient（HTTP）从 CP 获取
- Sandbox backend、Workspace execution、Job、MCP transport 与 checkpoint 的当前实现细节见 [DEV-015](../../docs/i18n/zh-Hans/DEV-015-runtime-architecture.md)；backend 语义边界见 [DEV-031](../../docs/i18n/zh-Hans/DEV-031-sandbox-backend-contract.md)。
- `apply_patch` 多文件写入失败时必须 best-effort rollback 已写文件。
- Checkpoint 使用 host-side shadow Git；不得读写用户仓库的 `.git/index` 或 branch。Workspace 不明、host Git 不可用或版本不适用时显式失败，不得静默回退。
- Linux container FS 写路径使用 `rustix::fs::openat2` 限制在 workspace 内并拒绝 symlink；内核不支持或路径校验失败时 fail-closed。其他 backend 的路径语义见 DEV-031。
- 不得自动从 Docker/MXC 失败回退到 host；Host execution 仅能作为明确选择的模式。
- 启动时只报告 Runtime 自身 liveness/readiness；按 workspace 获取 `WorkspaceExecutionSpec`，首次操作才 materialize Sandbox。
- Sandbox 执行实体的创建、重建或删除不得删除 WorkspaceStorage 文件。
- 仅 Strict profile 使用 `network_mode=none`；不得推广为所有 backend 共用的网络策略。Workspace 操作与 stdio MCP 不发布端口。
- Runtime 内部的进程 ID、policy 路径、MXC tier、secret 及宿主绝对路径不得透传到公共响应或 Agent/UI 契约。
- 沙盒容器资源默认值、env override、非法值回退和生效值记录见 [`DEV-003 §3`](../../docs/i18n/zh-Hans/DEV-003-config-management.md)；策略调整不得绕过配置校验。
- Handler 级 Fake 门：`main.rs` 内 `#[cfg(test)]` 模块直调 handler，stub CP（execution-spec）+ stub Fake MCP（127.0.0.1 随机端口，需 `XIHE_REMOTE_MCP_ALLOW_INSECURE_LOCAL=true`），断言结果 + 注册表无容器 + `list_workspaces()` 为空；无 Docker 下最强的完成证据（见 `remote_handler_tests`）。

## Permissions

### Allowed
- 修改 `src/`、`tests/`、`Cargo.toml`

### Require Approval
- 新增外部 crate 依赖
- 沙盒安全策略变更

## Parent Project

详见 `../../AGENTS.md`。
