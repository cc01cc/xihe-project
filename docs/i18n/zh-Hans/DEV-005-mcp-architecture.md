---
title: DEV-005 - MCP 三层路由架构设计
description: MCP 请求从 Agent 到 Runtime 的三层路由设计，含 CP 路由、Gateway 分发、容器内 bridge 执行。
category: dev-guide
lang: zh-Hans
sidebar_group: "开发指南"
sidebar_order: 5
status: active
created: 2026-06-03
updated: 2026-06-15
---

# DEV-005: MCP 三层路由架构

## 1. 概述

MCP（Model Context Protocol）请求从 Agent 发出的到工具执行的完整路径经过三层路由：

1. **CP McpProxyController** — 认证 + tool-name-based 路由
2. **Runtime Gateway** — per-workspace 分发
3. **容器内 bridge** — STDIO 子进程管理

## 2. 架构图

```
┌─────────────────────────────────────────────────────────────┐
│  Agent (Python)                                             │
│  StreamableHTTPConnection(session-id, headers)              │
│  └─→ POST /mcp { jsonrpc, method, params }                 │
└────────────────────────┬────────────────────────────────────┘
                         │
┌────────────────────────▼────────────────────────────────────┐
│  CP McpProxyController (Java)                               │
│                                                             │
│  1. 验证 session-id 签名 + 提取 ws_id                      │
│  2. tools/list: 合并系统工具 + 各 STDIO server 工具        │
│     记录 tool_name → server_id 映射（缓存 5min TTL）        │
│  3. tools/call: 按 tool name 查表路由                      │
│  4. 系统工具优先（同名用户工具被跳过 + 告警）               │
│                                                             │
│  路由规则：                                                  │
│  ├─ 系统工具 → POST /workspace/{ws_id}/mcp                  │
│  └─ 用户工具 → POST /workspace/{ws_id}/mcp/stdio/{sid}     │
└────────────────────────┬────────────────────────────────────┘
                         │
┌────────────────────────▼────────────────────────────────────┐
│  Runtime Gateway (Rust / Axum, 由 XIHE_RUNTIME_PORT 配置)   │
│                                                             │
│  ├─ /workspace/{ws_id}/mcp          → XiheRuntime 工厂      │
│  ├─ /workspace/{ws_id}/mcp/spawn    → docker exec bridge    │
│  ├─ /workspace/{ws_id}/mcp/spawn/{id}→ docker exec kill     │
│  ├─ /workspace/{ws_id}/mcp/spawn    → 列出活跃 server       │
│  └─ /workspace/{ws_id}/mcp/stdio/{id}→ 转发到容器内 bridge  │
│                                                             │
│  配置轮询：每 30s 从 CP 读取 mcpServers JSON，diff 后管理   │
└────────────────────────┬────────────────────────────────────┘
                         │
┌────────────────────────▼────────────────────────────────────┐
│  Per-workspace Docker Container (xihe/workspace 镜像)        │
│  xihe-workspace-ws_{ws_id}                                  │
│                                                             │
│  xihe-container-runtime (Rust binary, 镜像内预装)            │
│  ├─ POST /fs/* → 文件操作 (read/write/glob/grep/etc)        │
│  ├─ POST /exec → 一次性命令执行                             │
│  └─ GET  /health → 健康检查                                 │
│                                                             │
│  xihe-mcp-bridge (Rust binary, 镜像内预装)                   │
│  ├─ POST /{server_id} → STDIN → STDOUT → streaming resp    │
│  ├─ health check (每 5s)                                    │
│  ├─ auto-restart (max 3 次)                                 │
│  └─ 30s 超时 / 1MB 缓冲区                                   │
│                                                             │
│  STDIO 子进程（npx, docker, python 等）                     │
└─────────────────────────────────────────────────────────────┘
```

## 3. 数据传输流

### 3.1. 工具发现（tools/list）

```
Agent → CP /mcp
  CP: 验证 session-id → 读 DB mcpServers JSON
  CP → Runtime: GET /workspace/{ws_id}/mcp (系统 tools/list)
  CP → Runtime: POST /workspace/{ws_id}/mcp/stdio/{sid} (各 STDIO tools/list)
  CP: 合并工具列表 + 构建 tool_name → server_id 映射（缓存）
  CP → Agent: 返回合并后的工具列表
```

### 3.2. 工具调用（tools/call）

```
Agent → CP /mcp (tool_name, args)
  CP: 查 tool_name → server_id 映射
  ├─ 系统工具 → Runtime: POST /workspace/{ws_id}/mcp
  │               → XiheRuntime 执行 Rust 函数
  └─ 用户工具 → Runtime: POST /workspace/{ws_id}/mcp/stdio/{sid}
                  → xihe-mcp-bridge: STDIN → STDOUT → 结果返回
  CP → Agent: 透传结果
```

## 4. 关键技术决策

| 决策 | 选择 | 理由 |
|------|------|------|
| MCP transport | Streamable HTTP | MCP 社区已废弃 SSE |
| STDIO 桥接方式 | Rust bridge binary | shell 无法处理 JSON-RPC streaming |
| Bridge 部署 | host bind mount | 开发期迭代快；生产可切 multi-stage build |
| 路由策略 | tool-name based | Agent 无需感知 server_id |
| 工具冲突 | 系统优先 + 告警 | 保证平台工具可用性 |
| 配置格式 | Claude Desktop JSON textarea | 业界标准，用户直接复制粘贴 |
| 配置存储 | PostgreSQL JSONB | 类型校验 + 索引支持 |
| workspace 隔离 | task-local（非 env var） | 支持多 workspace 单进程 |
| 向后兼容 | 无 | 所有组件同步升级 |
| LLM 可见性 | workspace_id 透明 | 基础设施关注点不泄漏到 LLM 层 |

## 5. bridge binary 设计要点

`xihe-mcp-bridge` 是容器内的轻量 HTTP 服务器，负责将 STDIO 子进程暴露为 HTTP 端点。

- 每个子进程由一个 `Mutex` 保护，串行化 STDIO 访问
- 响应为 streaming（`tokio::sync::mpsc` + `Body::from_stream`），逐行 flush
- 30s 读取超时（超时后丢弃 reader，pipe 关闭后子进程收到 SIGPIPE）
- 1MB 缓冲区上限
- 管理端点：`/_spawn`、`/_kill/{id}`、`/_health`
- 用户端点：`POST /{server_id}`

## 6. 配置同步

```
用户 → UI textarea → PUT /api/v1/workspaces/{wsId}/mcp-config
  → CP: 校验 JSON → 写入 config 表 (JSONB)
  → Runtime 每 30s: GET /api/v1/workspaces/{ws_id}/mcp-config
  → Runtime: diff 当前 bridge 列表 → spawn/stop
```

## 7. 测试策略

| 层级 | 内容 | 命令 |
|------|------|------|
| Unit | bridge spawn/conflict/kill | `cargo test --bin xihe-mcp-bridge` |
| Unit | Gateway 路由转发 | `cargo test --lib` (83 tests) |
| Unit | CP McpProxyController | `mvn test -Dtest=McpProxyTest` (8 tests) |
| Unit | MCPSettings Vue | `pnpm vitest run` (206 tests) |
| Integration | 真实 bridge 进程 | `cargo test --test bridge_integration_test` |
| E2E | Settings 页截图 | `npx playwright test e2e/real/settings-visual.spec.ts` |

## 8. 相关文件

| 文件 | 说明 |
|------|------|
| `packages/agent/.../mcp_client.py` | Agent MCP client（StreamableHttpConnection） |
| `packages/runtime/src/mcp_bridge.rs` | 容器内 xihe-mcp-bridge binary |
| `packages/runtime/src/container_runtime.rs` | 容器内 xihe-container-runtime binary（文件操作 + 命令执行） |
| `docker/images/workspace/Dockerfile` | xihe/workspace 容器镜像多阶段构建 |
| `packages/runtime/src/mcp_process.rs` | Gateway 侧 STDIO 管理 |
| `packages/runtime/src/workspace.rs` | 容器 + bridge 生命周期 |
| `packages/runtime/src/main.rs` | 路由注册 + 配置轮询 |
| `packages/control-plane/.../McpProxyController.java` | CP 层路由代理 |
| `packages/control-plane/.../ConfigController.java` | MCP 配置 API |
| `packages/ui/.../MCPSettings.vue` | MCP 配置 UI |
