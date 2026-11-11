# Runtime MCP Tools Catalog

The MCP tool surface that the **Runtime** exposes as an MCP server, plus the two CP-side views of it.

> **Authority**: the tool catalog is a *runtime property*. The authoritative value is always what the
> server answers to a live `tools/list` handshake — this document is a **snapshot** of that answer,
> cross-checked line by line against the registration site in source. If they disagree, the handshake
> wins and this file is the thing that is wrong. Regeneration and re-verification: §6.
>
> Snapshot: **2026-11-10**, dev stack `stack-1` (CP :12631, Runtime :12633), Runtime `rmcp 3.7.0`,
> `A03-xihe` develop. Probe: 23 tools on the Runtime surface, 23 on the CP user face,
> 29 on the CP internal-service face (§2).
>
> Last static re-verification: **2026-11-11**, base `84221184d` — 23 registration sites re-extracted,
> name set and required-params aligned 0-mismatch against this table (§2). The byte-level
> source↔handshake description diff is **blocked-on-stack** (no dev stack listening); re-run recipe §6.

## 1. Three faces, one catalog

```text
Runtime MCP server (23 tools)                    ← §3, this is "the Runtime tool surface"
   ├─ CP user face      POST /api/v1/mcp         23 = the 23 Runtime tools
   └─ CP service face   POST /api/v1/mcp  (+6)   29 = 23 + CP-owned tools (§4)
```

| Face | Caller | Tool count | What is added |
|---|---|---|---|
| Runtime MCP server | CP only (`/internal/v1/runtime/workspaces/{id}/mcp`) | 23 | — |
| CP logical entry, user/agent token | Agent, user-facing MCP clients | 23 | Workspace-configured STDIO/remote MCP tools (none on a fresh workspace) |
| CP logical entry, internal service token | CP-internal callers (sub-agent, credential, skill, git faces) | 29 | 6 CP-owned tools (§4) |

The CP-owned tools are gated on `access.internalService()` in `populateSystemTools`
(`McpProxyController.java:601-622`), so **a normal agent/user token never sees them**.

## 2. Measured evidence

| Check | Result |
|---|---|
| `#[tool(...)]` registration sites in `packages/runtime/src/main.rs` | **23** (`:455`–`:806`, `#[tool_router] impl` at `:439`, base `84221184d`) |
| Runtime `tools/list` (direct, stateless mode) | **23** tools |
| CP user face `tools/list` (`admin@xihe.local`) | **23** tools |
| CP internal-service face `tools/list` | **29** tools = 23 + 6 CP-owned |
| Name set source ↔ handshake | identical (0 only-in-source, 0 only-in-handshake) |
| `description` string source ↔ handshake | identical for all 23 (0 diffs, as of 2026-11-10 snapshot) |
| Static re-extraction ↔ this table (2026-11-11, stack down) | names 23/23; required-params 0 mismatch |

## 3. The 23 Runtime tools

Every tool advertises `name`, `description` and `inputSchema` (JSON Schema draft 2020-12, `$defs` for
nested objects). **13 of the 23 also advertise `outputSchema`** (structured JSON results); the other 10
(`read_file`, `write_file`, `delete_file`, `delete_directory`, `move_file`, `copy_file`, `mkdir`,
`extract_pdf_text`, `start_background_process`, `cancel_background_process`) return plain text and carry
no `outputSchema` — callers must not expect a structured result from those. Required parameters are
marked **bold** below. "Face" is the CP policy face from `ToolFaceRegistry`
(`actionClass`/`shape`), which is what decides read-vs-write authorization and approval gating.

### 3.1 Read (face `read` / `STRUCTURED`)

| Tool | What it does | Parameters | Side effect |
|---|---|---|---|
| `read_file` | Read file content from the workspace | **path** | none |
| `read_file_range` | Read with line range, binary detection, line numbers (binary → base64 `is_binary=true`, capped 16 MiB) | **path**, offset, limit | none |
| `list_directory` | List directory contents with file metadata | **path** | none |
| `get_file_info` | File or directory metadata | **path** | none |
| `glob` | Match files using a glob pattern | **pattern**, **path** | none |
| `grep` | Search files using a regular expression | **pattern**, **path** | none |
| `watch_directory` | Watch a directory for fs events (2s poll) | **path** | none (bounded snapshot read) |
| `extract_pdf_text` | Extract text content from a PDF | **path** | none |
| `read_command_output` | Read one page of retained command output by `artifact_id` (`stream=stdout\|stderr`, byte offset/limit; `available=false` + reason when expired/missing) | **artifact_id**, stream, offset, limit | none |
| `list_background_processes` | List all background processes for this workspace | — | none |
| `get_background_process` | Status of one background process | **jobId** | none |

### 3.2 Write (face `write` / `STRUCTURED`)

| Tool | What it does | Parameters | Side effect |
|---|---|---|---|
| `write_file` | Write file (creates parent directories) | **path**, **content** | creates/overwrites file |
| `edit_file` | Search and replace in a file (single by default, `replace_all=true` for all) | **file_path**, **old_string**, **new_string**, replace_all | in-place edit |
| `apply_patch` | Atomic multi-file patch with expected content hashes (`patches[]: {path, expectedHash, hunks[{before, after}]}`) | **patches** | multi-file write, rollback on failure |
| `delete_file` | Delete a file | **path** | destructive |
| `delete_directory` | Delete a directory (non-empty needs `recursive=true`) | **path**, recursive | destructive |
| `move_file` | Move or rename file/directory | **from**, **to** | destructive |
| `copy_file` | Copy a file | **from**, **to** | creates file |
| `mkdir` | Create directory (recursive) | **path** | creates directory |

### 3.3 Exec (face `exec` / `INTERPRETER`)

| Tool | What it does | Parameters | Side effect |
|---|---|---|---|
| `execute_command` | Execute a shell command inside a sandboxed container | **command**, args, timeout, truncate_limit | runs code in the sandbox |
| `start_background_process` | Long-running command in background, returns `jobId`; `timeout` in seconds, clamped to the configured maximum (omitted = default, explicit 0 = clamped to max, max 0 = no limit). Returns **no output** — read it page-wise with `read_command_output` (each stream is retained up to 1 MiB and `truncated=true` marks that cap) | **command**, args, timeout | spawns a detached job |
| `cancel_background_process` | Cancel a background process by `jobId` | **jobId** | kills the job |

> `INTERPRETER` shape is why `execute_command` arguments are not path-listed for policy matching —
> the command body is opaque to the structured face.

### 3.4 Network (face `network` / `STRUCTURED`)

| Tool | What it does | Parameters | Side effect |
|---|---|---|---|
| `web_fetch` | Fetch a URL; returns text or markdown | **url**, format, timeout | outbound HTTP (allowlist / private-network guarded by the CP policy and the Runtime host connector) |

## 4. CP-owned tools (service face only, +6)

Registered in `McpProxyController.populateSystemTools` (`:605-622`) with their schemas built in
`gitStatusToolDefinition` / `gitDiffToolDefinition` / `gitLogToolDefinition` (`:844-897`) and the
sub-agent / credential / skill definitions alongside. They never reach the user face.

| Tool | Parameters | Policy face | Notes |
|---|---|---|---|
| `spawn_agent` | **prompt** | `spawn_agent` / `STRUCTURED` | creates a child Agent Session with a narrowed permission snapshot; delegation budget enforced by CP |
| `acquire_credential` | **credentialId** | `credential_use` / `STRUCTURED` | returns the lease value once (single-use, 5 min TTL); must never be logged/persisted/echoed |
| `skill_read` | **skill** (uuid shown in the run's skill listing) | `read` / `STRUCTURED` | returns body + version + content hash; invisible and non-existent skills are reported identically |
| `git_status` | — | `read` / `STRUCTURED` | uncommitted changes of the workspace repo; `isRepository=false` when not a repo (PLAN-0686 G8) |
| `git_diff` | paths[] | `read` / `STRUCTURED` | bounded unified diff; `truncated=true` means cut, not complete |
| `git_log` | range, limit (1–200, default 20), paths[] | `read` / `STRUCTURED` | newest first; `truncated=true` when more commits matched than `limit` |

These are **CP-owned**: the three git tools call Runtime's read-only `/internal/v1` endpoints and the
model can only reach them through the CP face (`DEV-016` §3.2.1).

## 5. Schema and protocol notes worth knowing

- **`outputSchema` is not universal.** 13 of 23 tools have it; the 10 listed in §3 return plain text.
- **Optional ≠ absent.** Optional parameters are `type: ["T","null"]` (e.g. `timeout: ["integer","null"]`),
  not missing keys. `execute_command.args` additionally carries `"default": []`.
- **camelCase where the wire says so**: `jobId` (not `job_id`) and `expectedHash` (not `expected_hash`)
  are the advertised names; the Rust structs rename them with `#[serde(rename)]`.
- **Extra arguments**: Runtime tools do **not** set `additionalProperties:false` (serde ignores unknown
  fields); CP-owned tools **do** (unknown fields are rejected). Do not rely on either — send exactly
  the documented keys.
- **`args` accepts a JSON-encoded string.** The schema says array, but the deserializer also accepts
  `"[\"-c\", \"date\"]"` and `"[]"` (compat shim for models that stringify arrays). Array form is the
  documented one.
- **Stateless inbound.** The CP logical endpoint `/api/v1/mcp` is stateless: it does not issue, echo or
  forward `mcp-session-id`, and any inbound `mcp-session-id` is rejected with
  `403 MCP_SESSION_INVALID` (verified). `GET`/`DELETE` are not supported (`405`).
- **Wire protocol version.** The CP pins `2026-07-28`: the `MCP-Protocol-Version` header and
  `params.protocolVersion` must agree, otherwise the CP answers `-32600 Invalid Request`. The Runtime's
  `initialize` result, however, advertises `protocolVersion: "2025-11-25"` (that is rmcp 3.7.0's own
  supported version).
- **`tools/list` result extras**: `cacheScope: "private"`, `ttlMs: 0`, `resultType: "complete"`, and no
  `nextCursor` (the catalog fits in a single page).
- **Runtime direct calls need stateless `_meta`.** `/internal/v1/runtime/workspaces/{id}/mcp` is
  sessionful by default ("Session ID is required"); it becomes stateless only when the request carries
  `MCP-Protocol-Version: 2026-07-28`, and then `params._meta` must contain
  `io.modelcontextprotocol/protocolVersion` and `io.modelcontextprotocol/clientCapabilities`
  (the CP injects these in `normalizeRuntimeBody`). Re-verify through the CP face (§6), not by hand.

## 6. How to regenerate / re-verify this catalog

**Source side** (must be 23; names are the `async fn` after each `#[tool(...)]`):

```pwsh
cd A03-xihe/packages/runtime
(Select-String -Path src/main.rs -Pattern '#\[tool\(' | Measure-Object).Count          # expect 23
Select-String -Path src/main.rs -Pattern '#\[tool\(|^\s*async fn \w+\(' | ForEach-Object { $_.Line.Trim() }
```

**Runtime side** — handshake through the CP logical entry (the recipe that needs no `_meta` surgery).
Run this as a one-off script; it logs in with the dev admin password from `.env.local` and prints the
tool names. Nothing secret is printed.

```js
// node mcp-tools-verify.mjs   (Node 24; run from the A03 checkout)
import { readFileSync } from "node:fs";
const A03 = process.cwd();                       // A03-xihe checkout
const CP = "http://localhost:12631";             // stack-1 CP
const pw = readFileSync(A03 + "/.env.local", "utf8")
    .split(/\r?\n/).map((l) => l.match(/^\s*XIHE_DEV_ADMIN_PASSWORD\s*=\s*(.*)$/))
    .filter(Boolean)[0][1].trim();
const login = await (await fetch(CP + "/api/v1/auth/login", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ identifier: "admin@xihe.local", password: pw }),
})).json();
const ws = (await (await fetch(CP + "/api/v1/workspaces", {
    headers: { authorization: "Bearer " + login.accessToken },
})).json())[0].id;
const res = await (await fetch(CP + "/api/v1/mcp", {
    method: "POST",
    headers: {
        authorization: "Bearer " + login.accessToken,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "X-Workspace-Id": ws,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
})).json();
console.log(res.result.tools.length, res.result.tools.map((t) => t.name).sort().join(","));
// user face: expect 23. For the 29-tool service face, repeat with the internal service token
// (Bearer cp.agent-api-token) instead of the user token.
```

**Diff the two sides.** Name sets must be identical; `description` must be byte-identical; a mismatch
means either the source registration and the running binary are out of sync (stale build — check
`mise run dev:host:status`) or someone edited one side only. The 2026-11-11 re-verification artifacts (static extractor,
handshake script, port probe, alignment table) live in
`plans/PLAN-0763-XH-api-contract-docs/evidence/m3-tools-snapshot/`.

## 7. Known discrepancies (as of the snapshot)

| # | Observation | Severity | Status |
|---|---|---|---|
| 1 | `start_background_process` used to advertise `truncate_limit` while its handler ignored it. | low | **fixed (task-241), re-verified 2026-11-11 on `84221184d`**: the field was removed from `StartBackgroundProcessRequest` (inert on the background path — output is retained per stream up to 1 MiB, `job_engine/mod.rs:33 STREAM_CAP_BYTES`, read back via `read_command_output` which reports `truncated`); `execute_command` keeps the parameter because there it sizes the inline wire preview (`container_runtime.rs:744-748`); Rust tests pin both (`main.rs:7382-7446`); historical callers still passing the field are tolerated (serde ignores unknown fields). |
| 2 | `DEV-016` §1 states the protocol is `2026-07-28`; the Runtime `initialize` result advertises `2025-11-25` (rmcp 3.7.0). The CP *enforces* `2026-07-28` on the wire, so this is a doc-vs-negotiation wording gap, not a broken handshake. | doc | clarified in this file; DEV-016 now points here |
| 3 | `DEV-016` §3.2.1 can read as "the git tools are in every `tools/list`". They are injected only when `access.internalService()` is true, i.e. the user face never sees them. | doc | clarified in DEV-016 §10 |
| 4 | `DEV-016` §1 note "Runtime 侧按该协议全程无会话" holds only with `MCP-Protocol-Version: 2026-07-28` + `_meta`; without the header the endpoint is sessionful (`400 Session ID is required`). | doc | clarified in DEV-016 §10 |
| 5 | Omitting `X-Workspace-Id` still returned the same 23 tools in the single-workspace dev stack; whether that is a fallback or a single-owner shortcut is unverified for multi-workspace instances. | unverified | do not document the header as optional |
| 6 | Runtime tool schemas omit `additionalProperties:false`; CP-owned schemas set it. Unknown arguments are therefore tolerated in one place and rejected in the other. | low | open question for the tool-surface owner |

## 8. Related documents

- Protocol/transport details (headers, SSE unwrapping, failure classification, tool-map lifecycle):
  [`DEV-016`](../i18n/zh-Hans/DEV-016-mcp-architecture.md), [`mcp-protocol-matrix.md`](mcp-protocol-matrix.md)
- Wire contracts for the HTTP endpoints behind the tools: [`openapi.yaml`](openapi.yaml),
  [`inventory.md`](inventory.md)
- Policy faces and approval gating: `ToolFaceRegistry.java`, `spec/protocol/mcp.md`
