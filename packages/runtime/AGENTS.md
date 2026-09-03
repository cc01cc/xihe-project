# Package: xihe-runtime

文件系统、沙盒、进程管理 — Rust 沙盒服务。基于 rmcp + Axum + Tokio + bollard。

## Tech Stack

- **Rust** 1.88（edition 2024，rmcp 3.1.4）— 编译语言
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
- `cargo clippy` — lint
- `cargo fmt` — 格式化

## Project Structure

```
src/
├── main.rs            # 入口（路由注册 + 配置轮询 + WorkspaceExecutionRouter）
├── lib.rs             # 库根
├── executor.rs        # WorkspaceExecutionRouter（per-request Docker exec 封装）
├── gateway.rs         # Runtime Gateway（per-workspace 分发）
├── fs.rs              # 文件系统操作（rustix openat2 helper）
├── sandbox.rs         # 沙盒实现（artifact store，伪 background 已移除）
├── workspace.rs       # 容器 + bridge 生命周期（Strict network-none + per-request exec）
├── container_runtime.rs # 容器内 xihe-container-runtime（oneshot CLI + /tmp/xihe-jobs）
├── inventory.rs       # 启动时 negative fallback 扫描
├── mcp_process.rs     # Gateway 侧 STDIO 管理
├── mcp_bridge.rs      # 容器内 xihe-mcp-bridge binary
├── remote_mcp.rs      # 远程 MCP 出网
├── ws_file_handler.rs # workspace 文件处理
├── config_client.rs   # CP 配置客户端（Rust）
├── fetch.rs           # HTTP 出网
├── log_redact.rs      # 日志脱敏
└── error.rs           # 错误处理
```

## Key Conventions

- `snake_case` 命名（Rust 标准）
- MCP endpoint 通过 rmcp 自动注册
- 配置文件通过 ConfigClient（HTTP）从 CP 获取
- 沙盒隔离依赖 Docker/bollard；新增 `rustix`（`fs` feature）用于 `openat2` 写路径 helper，需走 approval
- Workspace 操作统一经 `WorkspaceExecutionRouter` 的 per-request Docker exec（`create_exec` → `start_exec(attach)` → 写 operation JSON → 读 stdout 到 EOF）；不再使用 `container_addr` HTTP loopback、`instance token`、长驻 worker 或 NDJSON 多路复用。`container_runtime` 提供 `--oneshot` CLI 模式（stdin 单帧 → stdout 单帧，EOF 即边界）。
- 后台 job 通过 `start_exec(detach)` + `/tmp/xihe-jobs/<jobId>/` 状态文件（`meta/pid/stdout/stderr/exit`）实现；`cancel` 为 `kill -- -PGID`，TTL 清理为周期 oneshot exec；容器重建即 `/tmp` 消失，旧 jobId 不复用。
- FS 写路径在容器内经 `rustix::fs::openat2`（`RESOLVE_BENEATH|RESOLVE_NO_SYMLINKS`）包住 create/open/rename/copy；内核不支持时 blocked。
- STDIO MCP 传输按 newline-delimited JSON-RPC 分帧：bridge 转发 HTTP body 时必须补写 `\n` 完成帧，按单行读取响应（不能读到 EOF——STDIO server 调用间不退出），stdout 句柄持久持有供后续调用复用（`take()` 会让第二次调用永久失败）。MCP 2026-07-28（SEP-2567）为无会话协议，上游不返回 `Mcp-Session-Id`，网关侧不得强制要求 session。
- 启动时只完成 Runtime 自身 liveness/readiness；通过 Bearer 按 `workspaceId` 定向获取 `WorkspaceExecutionSpec`，首次文件/命令/MCP 操作时再 materialize Workspace Sandbox。
- Sandbox Container 创建、重建和删除只处理临时执行实体，必须保留 WorkspaceStorage 文件。
- Strict Sandbox 使用 `network_mode=none`，不发布端口，Workspace 操作同样经 per-request exec；Coding/Isolated 的 loopback 端口仅保留用于健康检查，不用于 Workspace 操作。

## Permissions

### Allowed
- 修改 `src/`、`tests/`、`Cargo.toml`

### Require Approval
- 新增外部 crate 依赖
- 沙盒安全策略变更

## Parent Project

详见 `../../AGENTS.md`。
