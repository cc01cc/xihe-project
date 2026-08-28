---
title: DEV-005 - MCP Three-Layer Routing Architecture
description: Three-layer routing design for MCP requests from Agent to Runtime, including CP routing, Gateway dispatch, and in-container bridge execution.
category: dev-guide
lang: en
sidebar_group: "Developer Guide"
sidebar_order: 5
status: active
created: 2026-06-03
updated: 2026-06-15
---

# DEV-005: MCP Three-Layer Routing Architecture

## 1. Overview

MCP (Model Context Protocol) requests from Agent to tool execution pass through three routing layers:

1. **CP McpProxyController** — Authentication + tool-name-based routing
2. **Runtime Gateway** — Per-workspace dispatch
3. **In-container bridge** — STDIO subprocess management

## 2. Architecture Diagram

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
│  1. Verify session-id signature + extract ws_id             │
│  2. tools/list: Merge system tools + STDIO server tools     │
│     Record tool_name → server_id mapping (5min TTL cache)   │
│  3. tools/call: Lookup table routing by tool name           │
│  4. System tools take priority (same-name user tools skipped + warned) │
│                                                             │
│  Routing rules:                                             │
│  ├─ System tools → POST /api/v1/mcp (CP logical endpoint)   │
│  └─ User tools → POST /api/v1/mcp (CP tool routing)         │
└────────────────────────┬────────────────────────────────────┘
                         │
┌────────────────────────▼────────────────────────────────────┐
│  Runtime Gateway (Rust / Axum, configured by XIHE_RUNTIME_PORT) │
│                                                             │
│  ├─ /internal/v1/runtime/workspaces/{workspaceId}/mcp      │
│  ├─ /internal/v1/runtime/workspaces/{workspaceId}/mcp/spawn │
│  ├─ /internal/v1/runtime/workspaces/{workspaceId}/mcp/spawn/{serverId} │
│  └─ /internal/v1/runtime/workspaces/{workspaceId}/mcp/stdio/{serverId} │
│                                                             │
│  Config polling: Reads mcpServers JSON from CP every 30s,   │
│  diff then manage                                           │
└────────────────────────┬────────────────────────────────────┘
                         │
┌────────────────────────▼────────────────────────────────────┐
│  Per-workspace Docker Container (xihe/workspace image)      │
│  xihe-workspace-ws_{ws_id}                                  │
│                                                             │
│  xihe-container-runtime (Rust binary, pre-installed in image)│
│  ├─ POST /fs/* → File operations (read/write/glob/grep/etc) │
│  ├─ POST /exec → One-shot command execution                 │
│  └─ GET  /health → Health check                             │
│                                                             │
│  xihe-mcp-bridge (Rust binary, pre-installed in image)      │
│  ├─ POST /{server_id} → STDIN → STDOUT → streaming resp    │
│  ├─ Health check (every 5s)                                 │
│  ├─ Auto-restart (max 3 times)                              │
│  └─ 30s timeout / 1MB buffer                                │
│                                                             │
│  STDIO subprocesses (npx, docker, python, etc.)             │
└─────────────────────────────────────────────────────────────┘
```

## 3. Data Transfer Flow

### 3.1. Tool Discovery (tools/list)

```
Agent → CP /mcp
  CP: Verify session-id → Read DB mcpServers JSON
  CP → Runtime: GET /internal/v1/runtime/workspaces/{workspaceId}/mcp (system tools/list)
  CP → Runtime: POST /internal/v1/runtime/workspaces/{workspaceId}/mcp/stdio/{serverId} (each STDIO tools/list)
  CP: Merge tool lists + Build tool_name → server_id mapping (cached)
  CP → Agent: Return merged tool list
```

### 3.2. Tool Invocation (tools/call)

```
Agent → CP /mcp (tool_name, args)
  CP: Lookup tool_name → server_id mapping
  ├─ System tools → Runtime: POST /internal/v1/runtime/workspaces/{workspaceId}/mcp
  │               → XiheRuntime executes Rust function
  └─ User tools → Runtime: POST /internal/v1/runtime/workspaces/{workspaceId}/mcp/stdio/{serverId}
                  → xihe-mcp-bridge: STDIN → STDOUT → Result returned
  CP → Agent: Passthrough result
```

## 4. Key Technical Decisions

| Decision | Choice | Reason |
|----------|--------|--------|
| MCP transport | Streamable HTTP | MCP community has deprecated SSE |
| STDIO bridging method | Rust bridge binary | Shell cannot handle JSON-RPC streaming |
| Bridge deployment | Host bind mount | Fast iteration during development; production can switch to multi-stage build |
| Routing strategy | Tool-name based | Agent doesn't need to know server_id |
| Tool conflict | System priority + warning | Ensure platform tool availability |
| Config format | Claude Desktop JSON textarea | Industry standard, users can copy-paste directly |
| Config storage | PostgreSQL JSONB | Type validation + index support |
| Workspace isolation | Task-local (not env var) | Supports multiple workspaces in single process |
| Backward compatibility | None | All components upgrade simultaneously |
| LLM visibility | workspace_id transparent | Infrastructure concerns don't leak to LLM layer |

## 5. Bridge Binary Design Points

`xihe-mcp-bridge` is a lightweight HTTP server inside the container, responsible for exposing STDIO subprocesses as HTTP endpoints.

- Each subprocess is protected by a `Mutex`, serializing STDIO access
- Responses are streaming (`tokio::sync::mpsc` + `Body::from_stream`), flushing line by line
- 30s read timeout (after timeout, reader is discarded; after pipe closes, subprocess receives SIGPIPE)
- 1MB buffer limit
- Management endpoints: `/_spawn`, `/_kill/{id}`, `/_health`
- User endpoints: `POST /{server_id}`

## 6. Configuration Synchronization

```
User → UI textarea → PUT /api/v1/workspaces/{wsId}/mcp-config
  → CP: Validate JSON → Write to config table (JSONB)
  → Runtime every 30s: GET /internal/v1/config/workspaces/{workspaceId}/mcp-config (Bearer service token)
  → Runtime: Diff current bridge list → spawn/stop
```

## 7. Test Strategy

| Layer | Content | Command |
|-------|---------|---------|
| Unit | bridge spawn/conflict/kill | `cargo test --bin xihe-mcp-bridge` |
| Unit | Gateway route forwarding | `cargo test --lib` (83 tests) |
| Unit | CP McpProxyController | `mvn test -Dtest=McpProxyTest` (8 tests) |
| Unit | MCPSettings Vue | `pnpm vitest run` (206 tests) |
| Integration | Real bridge process | `cargo test --test bridge_integration_test` |
| E2E | Settings page screenshot | `npx playwright test e2e/real/settings-visual.spec.ts` |

## 8. Related Files

| File | Description |
|------|-------------|
| `packages/agent/.../mcp_client.py` | Agent MCP client (StreamableHttpConnection) |
| `packages/runtime/src/mcp_bridge.rs` | In-container xihe-mcp-bridge binary |
| `packages/runtime/src/container_runtime.rs` | In-container xihe-container-runtime binary (file ops + command execution) |
| `docker/images/workspace/Dockerfile` | xihe/workspace container image multi-stage build |
| `packages/runtime/src/mcp_process.rs` | Gateway-side STDIO management |
| `packages/runtime/src/workspace.rs` | Container + bridge lifecycle |
| `packages/runtime/src/main.rs` | Route registration + config polling |
| `packages/control-plane/.../McpProxyController.java` | CP layer routing proxy |
| `packages/control-plane/.../ConfigController.java` | MCP config API |
| `packages/ui/.../MCPSettings.vue` | MCP config UI |
