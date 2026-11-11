# Runtime MCP Tools Catalog

The MCP tool surface that the **Runtime** exposes as an MCP server, plus the two CP-side views of it.

> **Authority**: the tool catalog is a *runtime property*. The authoritative value is always what the
> server answers to a live `tools/list` handshake — this document is a **snapshot** of that answer,
> cross-checked line by line against the registration site in source. If they disagree, the handshake
> wins and this file is the thing that is wrong. Regeneration and re-verification: §6.
>
> Snapshot (live handshake): **2026-11-11**, dev stack `stack-2` (CP :12641, Runtime :12643), Runtime
> `rmcp 3.7.0`, base `4b5a7a3d44ab` (`dev-stack status`: `verdict=fresh`, `runningCommit == headCommit`).
> Probe: 23 tools on the Runtime surface, 23 on the CP user face, 29 on the CP internal-service face
> (§2).
>
> Last static re-extraction: **2026-11-11**, same base — 23 `#[tool(` sites; names, `description`
> strings (byte-identical), `inputSchema` property keys, required params and the 13/10
> structured-vs-text split all matched this table 0-diff (§2, §3). §5's handshake-only claims were
> re-checked in the same run (protocol echo, session-id rejection, method semantics, `tools/list`
> extras); the one thing **not** re-run is the Runtime-direct `_meta` path (§5, §6).
> Provenance: stack-1 was another lane's verify window, so this snapshot was taken on stack-2.

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
| `#[tool(...)]` registration sites in `packages/runtime/src/main.rs` | **23** (`:455`–`:806`, `#[tool_router] impl` at `:439`, base `4b5a7a3d44ab`) |
| Runtime `tools/list` (direct to `/internal/v1/runtime/workspaces/{id}/mcp`, stateless `_meta` path) | **23** tools — 2026-11-10 measurement, **not** re-run on 2026-11-11 (see §6) |
| CP user face `tools/list` (`admin@xihe.local`, stack-2 :12641) | **23** tools (2026-11-11) |
| CP internal-service face `tools/list` (`XIHE_AGENT_API_TOKEN` bearer) | **29** tools = 23 + 6 CP-owned (2026-11-11) |
| Name set source ↔ handshake | identical (0 only-in-source, 0 only-in-handshake) (2026-11-11) |
| `description` string source ↔ handshake | identical for all 23, byte-level (2026-11-11) |
| `inputSchema` property keys / required / leaf types source ↔ handshake | 0 diff after resolving `$defs` (2026-11-11) |
| `outputSchema` split source ↔ handshake | 13 structured / 10 text, identical list (§3) (2026-11-11) |
| `tools/list` result extras | `cacheScope: "private"`, `ttlMs: 0`, `resultType: "complete"`, no `nextCursor` (2026-11-11) |

## 3. The 23 Runtime tools

Every tool advertises `name`, `description` and `inputSchema` (JSON Schema draft 2020-12, `$defs` for
nested objects). **13 of the 23 also advertise `outputSchema`** (structured JSON results); the other 10
(`read_file`, `write_file`, `delete_file`, `delete_directory`, `move_file`, `copy_file`, `mkdir`,
`extract_pdf_text`, `start_background_process`, `cancel_background_process`) return plain text and carry
no `outputSchema` — callers must not expect a structured result from those. The static side agrees with
this split: 13 handlers return `Json<…>`, the other 10 return a plain `String`. Required parameters are
marked **bold** below. "Face" is the CP policy face from `ToolFaceRegistry`
(`actionClass`/`shape`), which is what decides read-vs-write authorization and approval gating.

The handshake serializes nested objects into `$defs` and references them (`apply_patch.patches.items`
is `$ref: "#/$defs/ApplyPatchEntry"`, and its `hunks.items` is `$ref` to `ApplyPatchHunk`), so a byte
comparison against a static extractor must resolve `$defs` first — inlined vs `$ref` is a
serialization difference, not a schema difference.

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

Registered in `McpProxyController.populateSystemTools` (`:601`, the `internalService()` gate block at
`:605-622`) with their schemas built in `gitStatusToolDefinition` (`:842-852`) /
`gitDiffToolDefinition` (`:861-875`) / `gitLogToolDefinition` (`:884-906`) and
`spawnAgentToolDefinition` (`:779`) / `acquireCredentialToolDefinition` (`:796`) /
`skillReadToolDefinition` (`:816-834`) alongside. They never reach the user face.

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
  `403 MCP_SESSION_INVALID` (verified 2026-11-11; the check runs before identity resolution, so it
  answers 403 even without a workspace context). `GET`/`DELETE` answer
  `405 MCP_STREAM_NOT_SUPPORTED` / `405 MCP_SESSION_NOT_SUPPORTED` **once the caller has a workspace
  context**; without one the tenant filter answers `401 AUTHORIZATION_REQUIRED` first — do not read
  that 401 as "endpoint missing".
- **Wire protocol version.** The CP pins `2026-07-28` for the logical entry: when the
  `MCP-Protocol-Version` header is present it must agree with `params.protocolVersion`, otherwise the
  CP answers `400` + `-32600 Invalid Request` (verified 2026-11-11: header `2026-07-28` + params
  `2025-11-25` ⇒ `-32600`; header `2026-07-28` + params `2026-07-28` ⇒ `200`). Omitting the header with
  `params.protocolVersion` = `2026-07-28` also succeeds, so the header is a disagreement check, not a
  hard requirement. The Runtime's `initialize` result advertises `protocolVersion: "2025-11-25"`
  (rmcp 3.7.0's own supported version) — re-confirmed 2026-11-11 through the CP face.
- **`tools/list` result extras**: `cacheScope: "private"`, `ttlMs: 0`, `resultType: "complete"`, and no
  `nextCursor` (the catalog fits in a single page) — verified 2026-11-11; the result carries exactly
  `tools`, `resultType`, `cacheScope`, `ttlMs` and nothing else.
- **Runtime direct calls need stateless `_meta`.** `/internal/v1/runtime/workspaces/{id}/mcp` is
  sessionful by default ("Session ID is required"); it becomes stateless only when the request carries
  `MCP-Protocol-Version: 2026-07-28`, and then `params._meta` must contain
  `io.modelcontextprotocol/protocolVersion` and `io.modelcontextprotocol/clientCapabilities`
  (the CP injects these in `normalizeRuntimeBody`). Re-verify through the CP face (§6), not by hand.

## 6. How to regenerate / re-verify this catalog

**Last verified run: 2026-11-11, stack-2** (CP :12641, base `4b5a7a3d44ab`) — source side and handshake
both ran; §2 is that run. The recipe below is the one that actually ran, including the two traps that
cost the first attempt: a **fresh stack database has no workspace** (create one before `tools/list`, or
the tenant filter answers `401`), and **never borrow stack-1 while another lane's verify window is
running** — start your own slot.

**Stack discipline.** Starting a stack is a shared-resource operation: use your own slot and clean it up.

```pwsh
cd A03-xihe
$env:XIHE_STACK_ID = 'stack-2'                              # stack-1 may be someone's verify window
node scripts/dev-stack.mjs start --stack 2 --with-pg --timeout 900
node scripts/dev-stack.mjs status --stack 2 --json          # expect ok=true, verdict=fresh, runningCommit==HEAD
# ... handshake against CP http://localhost:12641 (below) ...
node scripts/dev-stack.mjs stop --stack 2 --with-pg         # zero-residual teardown; volumes are kept
node scripts/dev-stack.mjs status --all --json              # expect no stack-2 listeners left
```

**Source side** (must be 23; names are the `async fn` after each `#[tool(...)]`):

```pwsh
cd A03-xihe/packages/runtime
(Select-String -Path src/main.rs -Pattern '#\[tool\(' | Measure-Object).Count          # expect 23
Select-String -Path src/main.rs -Pattern '#\[tool\(|^\s*async fn \w+\(' | ForEach-Object { $_.Line.Trim() }
```

**Runtime side** — handshake through the CP logical entry (the recipe that needs no `_meta` surgery).
Run this as a one-off script; it resolves the dev admin password the same way `dev-stack` does (D-766:
env → `.env` chain → `.local/dev/admin-password`) and prints only counts and names. No secret is printed.
The workspace-create branch is required on a fresh stack (first run), and is a no-op afterwards.

```js
// node mcp-tools-verify.mjs [CP_PORT]   (Node 24; run from the A03 checkout/worktree)
import { existsSync, readFileSync } from "node:fs";
const CP = "http://localhost:" + (process.argv[2] || "12641");   // your stack's CP port
const cwd = process.cwd();
function envValue(name) {
    for (const f of [".env", ".env.dev", ".env.local"]) {
        const p = cwd + "/" + f;
        if (!existsSync(p)) continue;
        const line = readFileSync(p, "utf8").split(/\r?\n/).find((l) => l.startsWith(name + "="));
        if (line && line.slice(name.length + 1).trim()) return line.slice(name.length + 1).trim();
    }
    return null;
}
const pw = process.env.XIHE_DEV_ADMIN_PASSWORD
    || envValue("XIHE_DEV_ADMIN_PASSWORD")
    || readFileSync(cwd + "/.local/dev/admin-password", "utf8").trim();
const login = await (await fetch(CP + "/api/v1/auth/login", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ identifier: "admin@xihe.local", password: pw }),
})).json();
const listWs = async () => (await (await fetch(CP + "/api/v1/workspaces", {
    headers: { authorization: "Bearer " + login.accessToken },
})).json())[0]?.id;
let ws = await listWs();
if (!ws) {   // fresh stack DB: create the probe workspace inside this stack's own root
    const hostPath = cwd + "/.xihe-stacks/2/workspaces/mcp-tools-probe";
    const res = await fetch(CP + "/api/v1/workspaces", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer " + login.accessToken },
        body: JSON.stringify({
            name: "mcp-tools-probe", storageMode: "direct_attach", hostPath, executionMode: "windows-host",
        }),
    });
    if (!res.ok) throw new Error("workspace create failed: " + res.status);
    ws = await listWs();
}
const list = async (token) => (await (await fetch(CP + "/api/v1/mcp", {
    method: "POST",
    headers: {
        authorization: "Bearer " + token,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "X-Workspace-Id": ws,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
})).json()).result;
const user = await list(login.accessToken);            // expect 23
const service = await list(envValue("XIHE_AGENT_API_TOKEN"));   // expect 29 (+6 CP-owned)
console.log("user face:", user.tools.length, "| service face:", service.tools.length);
console.log(user.tools.map((t) => t.name).sort().join(","));
```

Troubleshooting a failed run: `401 AUTHORIZATION_REQUIRED` from the logical entry means the request had
no resolvable workspace context (missing/stale `X-Workspace-Id`, or a fresh DB with no workspace) — not
an auth or endpoint problem. A `403 MCP_SESSION_INVALID` is expected if you copied a client that sends
`mcp-session-id`; drop that header.

**Diff the two sides.** Name sets must be identical; `description` must be byte-identical;
`inputSchema` must agree on property names, `required` lists and leaf types **after resolving `$defs`**
(§3). A mismatch means either the source registration and the running binary are out of sync (stale
build — check `dev-stack status --json` / `mise run dev:host:status`) or someone edited one side only.
If only `inputSchema` differs, that is a **true bug**: report it with the file:line of the registration
and both sides of the schema — do not "fix" this snapshot to match, because the snapshot is the
evidence. The re-verification artifacts (static extractor, handshake script, alignment table) live in
`plans/PLAN-0763-XH-api-contract-docs/evidence/m3-tools-snapshot/`.

## 7. Known discrepancies (as of the snapshot)

| # | Observation | Severity | Status |
|---|---|---|---|
| 1 | `start_background_process` used to advertise `truncate_limit` while its handler ignored it. | low | **fixed (task-241), re-verified 2026-11-11 on `4b5a7a3d44ab`**: the field was removed from `StartBackgroundProcessRequest` (inert on the background path — output is retained per stream up to 1 MiB, `job_engine/mod.rs:33 STREAM_CAP_BYTES`, read back via `read_command_output` which reports `truncated`); `execute_command` keeps the parameter because there it sizes the inline wire preview (`src/container_runtime.rs:450`, truncation applied `:620-640`); Rust tests pin both (`main.rs:7382-7450`); historical callers still passing the field are tolerated (serde ignores unknown fields). |
| 2 | `DEV-016` §1 states the protocol is `2026-07-28`; the Runtime `initialize` result advertises `2025-11-25` (rmcp 3.7.0). The CP *enforces* `2026-07-28` on the wire, so this is a doc-vs-negotiation wording gap, not a broken handshake. | doc | clarified in this file; DEV-016 now points here |
| 3 | `DEV-016` §3.2.1 can read as "the git tools are in every `tools/list`". They are injected only when `access.internalService()` is true, i.e. the user face never sees them. | doc | clarified in DEV-016 §10 |
| 4 | `DEV-016` §1 note "Runtime 侧按该协议全程无会话" holds only with `MCP-Protocol-Version: 2026-07-28` + `_meta`; without the header the endpoint is sessionful (`400 Session ID is required`). | doc | clarified in DEV-016 §10 |
| 5 | Omitting `X-Workspace-Id` still returned the same 23 tools in the single-workspace dev stack (re-confirmed 2026-11-11 on stack-2 with exactly one workspace: `200`, 23 tools); whether that is a fallback or a single-owner shortcut is unverified for multi-workspace instances. | unverified | do not document the header as optional |
| 6 | Runtime tool schemas omit `additionalProperties:false` (re-confirmed 2026-11-11: none of the 23 carry it); CP-owned schemas set it. Unknown arguments are therefore tolerated in one place and rejected in the other. | low | open question for the tool-surface owner |

## 8. Related documents

- Protocol/transport details (headers, SSE unwrapping, failure classification, tool-map lifecycle):
  [`DEV-016`](../i18n/zh-Hans/DEV-016-mcp-architecture.md), [`mcp-protocol-matrix.md`](mcp-protocol-matrix.md)
- Wire contracts for the HTTP endpoints behind the tools: [`openapi.yaml`](openapi.yaml),
  [`inventory.md`](inventory.md)
- Policy faces and approval gating: `ToolFaceRegistry.java`, `spec/protocol/mcp.md`
