# Package: xihe-runtime

文件系统、沙盒、进程管理 — Rust 沙盒服务。基于 rmcp + Axum + Tokio + bollard。

## Tech Stack

- **Rust** 1.88（edition 2024，rmcp 3.1.4）— 编译语言
- **Cargo** — 构建/测试
- **rmcp** — MCP 服务器框架
- **Axum** — HTTP 服务器
- **Tokio** — 异步运行时
- **bollard** — Docker API 客户端
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
├── main.rs            # 入口（路由注册 + 配置轮询）
├── lib.rs             # 库根
├── gateway.rs         # Runtime Gateway（per-workspace 分发）
├── fs.rs              # 文件系统操作
├── sandbox.rs         # 沙盒实现
├── workspace.rs       # 容器 + bridge 生命周期
├── mcp_process.rs     # Gateway 侧 STDIO 管理
├── mcp_bridge.rs      # 容器内 xihe-mcp-bridge binary
├── container_runtime.rs # 容器内 xihe-container-runtime binary（文件 + 命令执行）
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
- 沙盒隔离依赖 Docker/bollard
- 启动时只完成 Runtime 自身 liveness/readiness；通过 Bearer 按 `workspaceId` 定向获取 `WorkspaceExecutionSpec`，首次文件/命令/MCP 操作时再 materialize Workspace Sandbox。
- Sandbox Container 创建、重建和删除只处理临时执行实体，必须保留 WorkspaceStorage 文件。
- Coding/Isolated Sandbox 的 container-runtime 绑定容器内所有接口，但只通过 Docker 分配的 `127.0.0.1` host port 供 native Runtime 访问；不要假设 Docker Desktop Linux bridge IP 从 Windows host 可达。Strict Sandbox 不发布该端口。

## Permissions

### Allowed
- 修改 `src/`、`tests/`、`Cargo.toml`

### Require Approval
- 新增外部 crate 依赖
- 沙盒安全策略变更

## Parent Project

详见 `../../AGENTS.md`。
