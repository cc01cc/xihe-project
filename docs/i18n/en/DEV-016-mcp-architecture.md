---
title: DEV-016 - MCP Three-Layer Routing Architecture
description: Three-layer routing design for MCP requests from Agent to Runtime, including CP routing, Gateway dispatch, and in-container bridge execution.
category: dev-guide
lang: en
sidebar_group: "Developer Guide"
sidebar_order: 16
status: active
created: 2026-06-03
updated: 2026-10-27
---

# DEV-016: MCP Three-Layer Routing Architecture

## 0.1 Workspace context (PLAN-0559)

- User-facing MCP resolves the workspace from X-Workspace-Id; VIEWER may call read-only `tools/call` (`read_file` / `read_file_range` / `list_directory` / `get_file_info` / `glob` / `grep` / `watch_directory` / `extract_pdf_text`); mutating `tools/call` returns `403 WORKSPACE_READ_ONLY`; `initialize`/`tools/list`/`resources/read` are allowed.
- The service path still uses InternalTokenFilter + explicit X-Workspace-Id + session-owner checks.
- Shared workspaces have no file/directory locks in v1; use fork/branch, declare-before-edit, checkpoints, and avoid workspace-wide revert.


## 1. Overview

MCP (Model Context Protocol) requests from Agent to tool execution pass through three routing layers:

1. **CP McpProxyController** — Authentication + tool-name-based routing
2. **Runtime Gateway** — Per-workspace dispatch
3. **In-container bridge** — STDIO subprocess management

> **Protocol version note (2026-11-10 erratum: read it as two layers)**
>
> - **① CP wire contract = `2026-07-28`**: the logical endpoint serves `MCP-Protocol-Version: 2026-07-28` (rmcp 3.7.0's stateless protocol face, SEP-2567); the header and `params.protocolVersion` **must agree**, otherwise the CP answers `-32600` (measured text: `Invalid Request: MCP-Protocol-Version header (2026-07-28) does not match initialize params.protocolVersion (…)`).
> - **② rmcp's own negotiated value = `2025-11-25`**: the Runtime `initialize` result advertises `protocolVersion: "2025-11-25"` (rmcp 3.7.0's supported version). The previous wording ("the current MCP `Protocol-Version: 2026-07-28` (rmcp 3.7.0)") implied the negotiated value was the same — it is not; both facts hold at once.
> - **Sessionless (stateless) holds only with the `2026-07-28` header**: call the Runtime endpoint without it and the request is treated as sessionful (`400 Session ID is required`); with it, every request must also carry `params._meta` with `io.modelcontextprotocol/protocolVersion` and `io.modelcontextprotocol/clientCapabilities` (the CP fills these in `normalizeRuntimeBody`).
>
> Everything else is unchanged: CP must carry the `Mcp-Method` and `Mcp-Name` HTTP headers when forwarding `tools/list` / `tools/call` to Runtime (see commit `a9923e3`); omitting them yields an empty system tool list and `UNKNOWN_TOOL`. CP neither issues nor accepts `mcp-session-id`: any inbound value returns 403 `MCP_SESSION_INVALID` (PLAN-0537). Measured snapshot and the tool catalog: [`docs/api/mcp-tools.md`](../../api/mcp-tools.md).

## 2. Architecture Diagram

```
┌─────────────────────────────────────────────────────────────┐
│  Agent (Python)                                             │
│  StreamableHTTPConnection(Bearer headers)                   │
│  └─→ POST /mcp { jsonrpc, method, params }                 │
└────────────────────────┬────────────────────────────────────┘
                         │
┌────────────────────────▼────────────────────────────────────┐
│  CP McpProxyController (Java)                               │
│                                                             │
│  1. Verify Bearer + resolve workspace claim (403 on sid)    │
│  2. tools/list: Merge system tools + STDIO server tools     │
│     Record tool_name → server_id mapping (5min TTL cache)   │
│     Only tools/list writes it; a tools/call miss rebuilds   │
│     once per workspace (single-flight)                      │
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
│  ├─ /internal/v1/runtime/workspaces/{workspaceId}/mcp             │  POST system tool call
│  ├─ /internal/v1/runtime/workspaces/{workspaceId}/mcp/spawn       │  POST spawn bridge (no serverId)
│  ├─ /internal/v1/runtime/workspaces/{workspaceId}/mcp/spawn/{serverId} │  DELETE stop bridge (kill, with serverId)
│  └─ /internal/v1/runtime/workspaces/{workspaceId}/mcp/stdio/{serverId} │  POST user STDIO tool call
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
  CP: Verify Bearer + workspace claim → Read DB mcpServers JSON
  CP → Runtime: GET /internal/v1/runtime/workspaces/{workspaceId}/mcp (system tools/list)
  CP → Runtime: POST /internal/v1/runtime/workspaces/{workspaceId}/mcp/stdio/{serverId} (each STDIO tools/list)
  CP: Merge tool lists + Build tool_name → server_id mapping (cached)
  CP → Agent: Return merged tool list
```

### 3.2. Tool Invocation (tools/call)

```
Agent → CP /mcp (tool_name, args)
  CP: Lookup tool_name → server_id mapping
  CP: Miss (mapping cleared by the 5min TTL or never filled) → refill __system__
      → still missing → rebuild the stdio/remote catalog once per workspace
      (single-flight, same merge routine as tools/list)
  ├─ System tools → Runtime: POST /internal/v1/runtime/workspaces/{workspaceId}/mcp
  │               → XiheRuntime executes Rust function
  └─ User tools → Runtime: POST /internal/v1/runtime/workspaces/{workspaceId}/mcp/stdio/{serverId}
                  → xihe-mcp-bridge: STDIN → STDOUT → Result returned
  CP → Agent: Passthrough result
```

### 3.2.1. CP-owned read-only git tools (PLAN-0686 G8)

`git_status`/`git_diff`/`git_log` are **CP-owned tools**: they are not forwarded through the Runtime `/mcp` system catalog; the CP dispatches them locally after authorization and returns a normal MCP tool-result.

- **Registration and dispatch**: tool-name constants `McpProxyController.java:94-96`; the `tools/list` catalog injection and `inputSchema` live in `populateSystemTools`; `tools/call` goes through `dispatchCpOwnedGit` (`:1536-1590`).
- **Face and authorization**: all three are in `ToolFaceRegistry.READ_TOOLS` (`:91-104`) ⇒ `read` atom + `STRUCTURED`; no new action atom, no `extraFaces` ([`spec/protocol/mcp.md`](../../../spec/protocol/mcp.md) §3.1). The gate is the §3.2 chain (`loadContext → allowsByGrant → faceOf`); an unauthorized caller gets a `TOOL_GRANT_DENIED` tool-result plus an audit record, never a bare 403.
- **Data source**: `git_status` **reuses** the public read face's one path `RuntimeCheckpointClient.workspaceGitStatus` → `/internal/v1/runtime/workspaces/{workspaceId}/git-status` (the CP keeps no second git implementation); `git_diff`/`git_log` call the Runtime read-only endpoints `git-diff`/`git-log` (wire contract in [`docs/api/inventory.md`](../../api/inventory.md)).
- **Read-only constraints (Runtime side)**: the user repository is used as `GIT_DIR`/`GIT_WORK_TREE`, `GIT_INDEX_FILE` is **never** set, `GIT_DIR` never points at the shadow repository, `GIT_OPTIONAL_LOCKS=0`, and diff runs with `--no-ext-diff --no-textconv`; `ShadowGit` is not called and index/refs are not written, so these reads can run lock-free alongside checkpoint capture/restore.
- **Failure shape**: Runtime unreachable/timeout → 503 `RUNTIME_UNAVAILABLE` (`dependency=runtime`, `retryable=true`) and **never** an empty diff/log; a Runtime refusal → an `isError=true` tool-result carrying the Runtime `reason`; invalid arguments → `INVALID_ARGUMENTS`. Audit lands in the AUDIT JSONL (`allow`/`tool_error`/`dependency_unavailable`) with shape facts only — no patch body, no commit subject.

True-chain evidence (allow/deny probes + audit read-back) belongs to PLAN-0686 T2.3 and is not claimed here; write tools (commit/branch) are out of v1.

### 3.3. Tool mapping lifecycle (PLAN-0583 / BL-124)

The `tool_name → server_id` mapping is an in-process cache with exactly three rules:

1. **Write**: the `tools/list` merge routine (system catalog + every STDIO server + every remote server + sticky aliases) persists the whole table once, at the end.
2. **One single-flight rebuild per workspace on a miss**: `tools/call` first tops up the `__system__`/CP-owned catalog; only if the name is **still** missing does it rebuild the stdio/remote catalog, reusing the **same** merge routine as `tools/list` (alias stickiness and `generation` semantics unchanged, issued names never drift). Rebuilds are serialized per workspace (in-process per-workspace lock + double check) so concurrent misses fan out once; a repeated true absence within one mapping epoch does not rebuild again and answers 400 directly — this bounds the fan-out caused by hallucinated tool names.
3. **5-minute expiry**: the next read (run dispatch / `tools/list` / `tools/call`) clears the whole table and stamps a fresh timestamp. A `tools/call` therefore never observes an "expired" flag — the trigger must be the **miss**, never "expired".

Error semantics stay as established by PLAN-0557: rebuilt but still absent → `400 UNKNOWN_TOOL` (audit reason `after_refresh`); dependency unavailable during the rebuild → dependency problem body (503 family), never `UNKNOWN_TOOL`.
Evidence logs: `event=tool_map_miss` and `event=tool_map_refresh` (`rebuilt` / `outcome` / `durationMs` / fan-out counts).
The TTL defaults to 300s; `cp.mcp.toolmap.ttl-seconds` is a test/stack override channel only — not a business config key, not surfaced in the UI.

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
## 9. Runtime MCP tool catalog (snapshot; the handshake is authoritative)

The tool catalog is a **runtime property**, not a static contract: it is decided by the `#[tool(...)]` registration sites in `packages/runtime/src/main.rs` and declared to callers by the `tools/list` handshake. The catalog itself lives in [`docs/api/mcp-tools.md`](../../api/mcp-tools.md).

**Read it this way**: that document is a **snapshot**; the **authoritative** value is always a live `tools/list` answer. When they disagree, the handshake wins and the document is what gets corrected. The snapshot carries per-tool `name` / `description` / `inputSchema` summary, side effects, the CP policy face (`ToolFaceRegistry`), and the commands to regenerate and re-verify it.

**Three faces, one catalog** (measured 2026-11-11 on dev stack `stack-2`, base `4b5a7a3d44ab`; the first measurement on `stack-1`, 2026-11-10, gave the same numbers):

| Face | Caller | Tools | Note |
|---|---|---|---|
| Runtime MCP server | CP only (`/internal/v1/runtime/workspaces/{id}/mcp`) | **23** | the full "system tools" set |
| CP logical entry, user/agent token | Agent, user-facing MCP clients | **23** | plus workspace-configured STDIO/remote tools (none on a fresh workspace) |
| CP logical entry, internal service token | CP-internal faces (sub-agent / credential / skill / git) | **29** | 23 + **6 CP-owned tools** |

The CP-owned tools (`spawn_agent`, `acquire_credential`, `skill_read`, `git_status`, `git_diff`, `git_log`) are injected by `populateSystemTools` only when `access.internalService()` is true (`McpProxyController.java:605-622`) — **a user/agent face never sees them** (which is also why the three git tools in §3.2.1 are service-face capabilities, not model-face ones).

**Re-verification (run both, then align line by line)**:

1. source side — `#[tool(` count in `packages/runtime/src/main.rs` is 23 and the method-name set equals the handshake `name` set;
2. runtime side — send `tools/list` to `/api/v1/mcp` (stateless; an `mcp-session-id` is rejected with 403) and read `result.tools`. Two traps worth recording: **a freshly started stack has an empty database — create a workspace first**, otherwise the tenant filter answers `401` (that is missing workspace context, not an auth or endpoint problem); for the service face (29) repeat the same request with `.env.dev`'s `XIHE_AGENT_API_TOKEN` as the bearer.

The runnable script and acceptance criteria are in [`docs/api/mcp-tools.md`](../../api/mcp-tools.md) §6, together with the six discrepancies/clarifications of the moment (the entry where `start_background_process` advertised a `truncate_limit` it ignored is now fixed by dropping the parameter: the background path returns no output, so output is read page-wise through `read_command_output` and truncated by the per-stream 1 MiB retention budget).

**Re-verification log**:

- **2026-11-11** (base `4b5a7a3d44ab`, dev stack `stack-2`, live handshake succeeded): `tools/list` measured on both faces — user face **23**, internal-service face **29** (= 23 + 6 CP-owned). The 23 registration sites (`:455`–`:806`) re-extracted and aligned line by line against the handshake: `name` set, `description` (23/23 byte-identical), `inputSchema` property names/required/leaf types and the 13/10 `outputSchema` split were all **0-diff** (compared after resolving `$defs`; the handshake serializes nested objects as `$ref` while the static extractor inlines them — a serialization difference, not a schema difference). Same run re-checked §5's protocol claims: inbound `mcp-session-id` → `403 MCP_SESSION_INVALID`; `GET`/`DELETE` with a workspace context → `405`; `MCP-Protocol-Version: 2026-07-28` disagreeing with `params.protocolVersion=2025-11-25` → `400 -32600`; `initialize` echoes `2025-11-25`; the `tools/list` result carries only `tools`/`resultType`/`cacheScope`/`ttlMs` (no `nextCursor`). No true `inputSchema` bug surfaced — the only apparent "diff" was the `$ref` shape of `apply_patch.patches.items`. Evidence and re-runnable script: `plans/PLAN-0763-XH-api-contract-docs/evidence/m3-tools-snapshot/` and `docs/api/mcp-tools.md` §6.
- **2026-11-11 (earlier round, superseded by the entry above)** (base `84ec2462618f`, dev stack down): the 23 `#[tool(` registration sites (`:455`–`:806`) were re-extracted — name set, required params and return types (13 `Json` / 10 `String`) all match this section and the catalog 0-mismatch (alignment table: `plans/PLAN-0763-XH-api-contract-docs/evidence/m3-tools-snapshot/alignment.md`). The 14:2x re-probe still found no candidate port listening (12631/12633/12640–44), so the byte-level source↔handshake description diff remains blocked-on-stack (probe record in the same dir). Once a stack is back, run `mcp-tools-verify.mjs` from that directory for the handshake side. §7#1 (`truncate_limit`) confirmed fixed by task-241 (removed + three Rust tests pinning the behavior, `main.rs:7382-7450`).

**Change rule**: adding/removing a tool, or changing a `description` or `inputSchema`, is a tool-surface change — update the catalog in the same batch and re-run the §6 check. Code without the catalog update is documentation debt.

**Three easy-to-misread points**:

- **Two protocol-version layers** (CP wire contract `2026-07-28` vs rmcp negotiated `2025-11-25`) and **the condition for sessionless mode** (`MCP-Protocol-Version: 2026-07-28` + `params._meta`): see the erratum in §1; not repeated here.
- **Do not document `X-Workspace-Id` as optional**: a single-workspace dev stack returns the same catalog without it, but multi-workspace behavior is unverified, so the user face must send it.
