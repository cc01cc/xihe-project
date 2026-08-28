# Package: xihe-runtime

文件系统、沙盒、进程管理 — Rust 沙盒服务。基于 rmcp + Axum + Tokio + bollard。

## Tech Stack

- **Rust** 1.97（edition 2024，rmcp 3.1.4）— 编译语言
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
├── main.rs          # 入口
├── sandbox/         # 沙盒实现
├── filesystem/      # 文件系统操作
├── process/         # 进程管理
├── config_client.rs # CP 配置客户端（Rust）
└── mcp_server.rs    # MCP 协议实现
```

## Key Conventions

- `snake_case` 命名（Rust 标准）
- MCP endpoint 通过 rmcp 自动注册
- 配置文件通过 ConfigClient（HTTP）从 CP 获取
- 沙盒隔离依赖 Docker/bollard

## Permissions

### Allowed
- 修改 `src/`、`tests/`、`Cargo.toml`

### Require Approval
- 新增外部 crate 依赖
- 沙盒安全策略变更

## Parent Project

详见 `../../AGENTS.md`。
