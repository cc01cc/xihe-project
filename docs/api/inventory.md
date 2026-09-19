# Xihe API Inventory

This inventory is the implementation baseline for PLAN-222 + PLAN-230. It records the
current canonical routes after the targeted WorkspaceExecutionSpec migration and the PLAN-230 Chat SSE lifecycle freeze.

## HTTP Routes

| Module | Current source route | Target route | Auth | Caller/consumer |
|---|---|---|---|---|
| CP | `POST /auth/register` | `POST /api/v1/auth/register` | public | UI, integration tests |
| CP | `POST /auth/login` | `POST /api/v1/auth/login` | public | UI, integration tests |
| CP | `POST /auth/refresh` | `POST /api/v1/auth/refresh` | public | UI |
| CP | `GET /auth/me` | `GET /api/v1/auth/me` | user Bearer | UI |
| CP | `POST /oauth/sessions` | `POST /api/v1/oauth/sessions` | user Bearer | UI |
| CP | `GET /oauth/callback` | `GET /api/v1/oauth/callback` | public | OAuth provider |
| CP | `POST /oauth/revoke` | `POST /api/v1/oauth/revoke` | user Bearer | UI |
| CP | `POST /oauth/token` | `POST /internal/v1/oauth/token` | service Bearer | Runtime |
| CP | `/mcp` | `/api/v1/mcp` | user Bearer | Agent, UI |
| CP | `/config/**` | `/api/v1/config/**`（`instance` / `workspace` / `user` 三层；`/api/v1/providers` 已删除 → `provider-connections` + `provider-catalog`） | user/admin Bearer | UI |
| CP | `/models` | `/api/v1/models` | user/admin Bearer | UI model selector; proxies provider status/capability without secrets |
| CP | `/internal/config/**` | `/internal/v1/config/effective/{domain}`（层端点已废弃，决策 #19） | service Bearer | Agent（effective）+ Runtime 按需 |
| CP | `/workspaces/{id}/mcp-config` | `/api/v1/workspaces/{workspaceId}/mcp-config`（混合 JSON，字段拆分）与 `/api/v1/workspaces/{workspaceId}/stdio-servers`（结构化） | user Bearer | UI |
| CP | `/workspaces/{id}/mcp-config` | `/internal/v1/workspaces/{workspaceId}/stdio-servers`（原 `/internal/v1/config/workspaces/{id}/mcp-config` 改名） | service Bearer | Runtime stdio 声明同步 |
| CP | Runtime stdio session snapshots | `GET /api/v1/workspaces/{workspaceId}/mcp/servers` | user Bearer（成员可见） | UI 设置页 stdio 服务器状态徽章（PLAN-0366；CP 显式映射 camelCase `serverId/state/attempt/lastError/sinceMs/epoch`，state 保持 Runtime 小写字面量；错误表：404 `WORKSPACE_NOT_FOUND`、409 `WORKSPACE_DESTROYING/BUSY`、503 `WORKSPACE_MATERIALIZATION_FAILED`、其余 502 `RUNTIME_UNAVAILABLE`） |
| CP | `/workspaces/current`, `/workspaces`, `/workspaces/{workspaceId}` | unchanged under `/api/v1/workspaces/...`; `GET /api/v1/workspaces` lists all active Workspace memberships, `POST` creates another active Workspace | user Bearer | UI Workspace selector, Runtime lifecycle |
| CP | `/workspaces/{workspaceId}/imports`, `/workspace-imports/{importId}` | `POST/GET /api/v1/workspaces/{workspaceId}/imports`, `GET/POST /api/v1/workspace-imports/{importId}[/cancel]` (PLAN-0376 durable import record; Runtime copy worker pending) | user Bearer + Workspace membership | UI/Runtime import flow |
| CP | `/workspaces/import-sources` | `GET /api/v1/workspaces/import-sources?path=...` lists Runtime-visible source directory entries for the UI picker | user Bearer + Runtime service token | PLAN-0376 source browser |
| CP | `/sessions`, `/sessions/{sessionId}` | unchanged under `/api/v1/sessions/...` | user Bearer + current workspace | UI |
| CP | `/sessions/{sessionId}/compact` | `POST /api/v1/sessions/{sessionId}/compact`（`upToSequence` 可选；活跃 run 409 `CHAT_IN_PROGRESS`） | user Bearer + session ownership | UI 手动压缩（PLAN-294/0341；行为不变，openapi 已补登） |
| CP | `/files/**`, `/rag/**` | `/api/v1/...` equivalent | user Bearer | UI |
| CP | `POST /api/v1/chat` | `POST /api/v1/chat` (requires active SSE, single in-flight, `202` + `runId` + durable `operationId`, `409 SSE_SUBSCRIPTION_REQUIRED` / `CHAT_IN_PROGRESS`) | user Bearer + current workspace | UI — enqueues async Agent relay; streams `token` → `done` on persistent SSE |
| CP | `GET /api/v1/chat/runs/{runId}` | unchanged under `/api/v1/chat/runs/{runId}` | user Bearer + current workspace/run ownership | UI — reconnect/reload recovery; returns run status, lease expiry, and pending approvals |
| CP | `POST /api/v1/chat/approvals/{requestId}/decision` | unchanged under `/api/v1/chat/approvals/{requestId}/decision` | user Bearer + authoritative request/session/run/workspace ownership | UI approval modal — CP persists/locks decision then forwards Agent service Bearer; same decision is idempotent |
| CP | `GET /api/v1/approvals/pending` | unchanged under `/api/v1/approvals/pending` | user Bearer + current workspace/user | UI cross-session indicator for live actionable approval/retry states (`pending` and `dispatch_unknown`) — counts and oldest timestamps only; no tool arguments, details or rule text |
| CP | `GET /api/v1/policy/mode?sessionId=` | unchanged under `/api/v1/policy/mode?sessionId=` | user Bearer + current workspace/user + session ownership | UI session policy control — reads one session's fixed mode set: `manual`, `auto` |
| CP | `POST /api/v1/policy/mode` | unchanged under `/api/v1/policy/mode` | user Bearer + current workspace/user + session ownership | UI session policy control — writes only the selected session's fixed mode and returns `scope: session`; mode is persisted on the session row (`sessions.approval_mode`, V24) and survives a CP restart |
| CP | `GET /api/v1/policy/tool-faces?scope=instance\|workspace` | unchanged under `/api/v1/policy/tool-faces` | user/admin Bearer + server-side TenantContext scope | UI tool registry — returns built-in (`id: null`, `scope: builtin`) and effective persisted faces; workspace rows override instance rows; unknown third-party tools are absent until first ask |
| CP | `POST /api/v1/policy/tool-faces` | unchanged under `/api/v1/policy/tool-faces` | user/admin Bearer + server-side instance ADMIN or workspace OWNER/ADMIN guard | UI tool classification — accepts only `scope: instance\|workspace`; explicit classification unlocks normal policy resolution, while unclassified tools remain `ask` + `opaque` |
| CP | `GET /api/v1/policy/domains` | unchanged under `/api/v1/policy/domains` | user/admin Bearer + current workspace/user | UI permission-rules page — per-`actionClass` effective layer (`builtin` when unconfigured) and per-layer rule counts |
| CP | `GET /api/v1/policy/rules?layer=instance\|user\|workspace` | unchanged under `/api/v1/policy/rules` | user/admin Bearer + instance layer ADMIN / workspace scope | UI permission-rules page — layer rules with server-derived `effective` flag (this layer is the domain's effective layer, not a runtime match) and static `conflict` note |
| CP | `POST /api/v1/policy/rules` | unchanged under `/api/v1/policy/rules` | user/admin Bearer + instance ADMIN or workspace OWNER/ADMIN guard | UI permission-rules page — creates `{layer, actionClass, resource, effect, priority, locked}`; `locked` is ADMIN-only and only with deny/ask |
| CP | `DELETE /api/v1/policy/rules/{id}?layer=` | unchanged under `/api/v1/policy/rules/{id}` | user/admin Bearer + instance ADMIN or workspace OWNER/ADMIN guard | UI permission-rules page — deletes one rule scoped by layer; cross-layer/owner deletion is 404 without leaking existence |
| CP | `GET /api/v1/policy/rules/conflicts?layer=instance\|user\|workspace` | unchanged under `/api/v1/policy/rules/conflicts` | user/admin Bearer + instance layer ADMIN / workspace scope | UI permission-rules page — subset of rules carrying a static `conflict` note; detection is server-side only |
| CP | `GET /api/v1/events?sessionId=` | `GET /api/v1/events?sessionId=` — **session-scoped persistent SSE** | user Bearer + current workspace | UI — one active emitter per `sessionId`; `done` ends run, not SSE; `heartbeat` (15s) is transport-only, never enters `MessagePart` |
| CP | `/api/v1/status`, `/api/v1/health`, `/api/v1/logs`, `/api/v1/telemetry/*` | unchanged `/api/v1/...` | public/user Bearer | UI/telemetry |
| CP | `/api/v1/sessions/{sessionId}/messages[/{messageId}]` | unchanged `/api/v1/...` | user Bearer | UI |
| CP | `GET /api/v1/operations` | unchanged (paginated, redacted user projection) | user Bearer | UI audit view (PLAN-281) |
| CP | `GET /api/v1/operations/{operationId}` | unchanged (owner-only trace, non-owner 404); items may carry the optional safe `policy` verdict summary (`effect` / `sourceLayer` / `matchedRule` / `reason` / `mode` / `allowedBy` / `actionClass` / `shape` / `reused`, no raw arguments); trace carries the additive read-only `toolCallPairs` (`toolCallId` / `agentItemId?` / `mcpItemId?`, missing side null; PLAN-0346) | user Bearer | UI audit detail (PLAN-281, PLAN-0328 T1.15; additive field PLAN-0346) |
| CP | `GET /api/v1/operations/items/{itemId}/job-output` | **new** (PLAN-0344): durable job 输出续看（字节游标分页，`nextOffset` 恒为 UTF-8 rune 边界；409 `JOB_OUTPUT_LOST` / `JOB_OUTPUT_EXPIRED`，502 `RUNTIME_UNAVAILABLE`）；owner-only（item → operation.userId） | user Bearer | UI job 卡片续看 |
| CP | `POST /api/v1/operations/items/{itemId}/cancel` | **new** (PLAN-0366): 取消单个 durable job（owner-only，与 job-output 同键位；非归属/不存在一律 404 `OPERATION_ITEM_NOT_FOUND`，无档案 404 `JOB_ARCHIVE_NOT_FOUND`）；已终态幂等 200 + `changed:false`；终止未确认 502 `JOB_CANCEL_UNCONFIRMED`（档案不变）；Runtime 404 → 档案落 `orphaned`；每次带档案调用写 `operation_events`（`job.cancel`/`actor=user`，含 result/changed） | user Bearer | UI job 卡片取消按钮 |
| CP | `POST /internal/v1/operations` | unchanged (service-to-service ledger entry; idempotent replay returns 200); all ledger/context write routes fail explicitly with 503 `OPERATION_LOCK_TIMEOUT` when a PostgreSQL lock wait exceeds `cp.lock-timeout-ms` (PLAN-0346 T1.8) | service Bearer | Agent, Runtime (PLAN-281) |
| CP | `POST /internal/v1/operations/items/{itemId}/late-termination` | records a Runtime-reported late termination (append-only event); 503 `OPERATION_LOCK_TIMEOUT` on bounded lock wait (PLAN-0346 T1.8) | service Bearer | Runtime (PLAN-0317 T2.9) |
| CP | `GET /internal/v1/operations/{operationId}/trace` | unchanged (full trace with refs; artifact contents excluded); items include the same optional safe `policy` verdict summary; trace carries the additive read-only `toolCallPairs` (`toolCallId` / `agentItemId?` / `mcpItemId?`, missing side null; PLAN-0346) | service Bearer | Agent, Runtime, admin diagnostics (PLAN-281, PLAN-0328 T1.15) |
| CP | `/api/v1/sessions/{sessionId}/attachments[/{fileId}]` | unchanged `/api/v1/...` | user Bearer | UI |
| CP | `/api/v1/files/{fileId}`, `/api/v1/files/upload` | unchanged `/api/v1/...` | user Bearer | UI |
| CP | `/api/v1/rag/stats`, `/api/v1/rag/ingest`, `/api/v1/rag/search`, `/api/v1/rag/documents/{docId}` | unchanged `/api/v1/...` | user Bearer | UI |
| CP | `/internal/v1/context/**` | `/internal/v1/context/**` | service Bearer | Agent context client（events/snapshot/refresh-sources/compact/fork） |
| CP | `/context/{sessionId}/sources` | `GET /api/v1/context/{sessionId}/sources` | user Bearer | UI `ContextSourcesU1` U1 元信息（无正文，PLAN-0340） |
| Runtime | `/workspace/**` | `/internal/v1/runtime/workspaces/**` | service Bearer | CP, UI through CP |
| Runtime | git porcelain status | `/internal/v1/runtime/workspaces/{workspaceId}/git-status` | service Bearer | CP dual-diff 待提交侧 |
| Runtime | git branch+HEAD 事实 | `/internal/v1/runtime/workspaces/{workspaceId}/git-facts` | service Bearer | CP L1b env（PLAN-0340，仅 branch/HEAD，无 dirty） |
| Runtime | targeted execution spec lookup | `/internal/v1/runtime/workspaces/{workspaceId}/execution-spec` | service Bearer | Runtime lazy materialization |
| Runtime | per-workspace materialization status | `/internal/v1/runtime/workspaces/{workspaceId}/status` | service Bearer | CP environment view/diagnostics |
| Runtime | explicit materialization trigger (202, poll status) | `/internal/v1/runtime/workspaces/{workspaceId}/materialize` | service Bearer | CP materialize proxy (PLAN-262 M4) |
| Runtime | job status / job output read (internal) | `/internal/v1/runtime/workspaces/{workspaceId}/jobs/status`, `/internal/v1/runtime/workspaces/{workspaceId}/jobs/output` | service Bearer | CP job 续看端点与 running 对账（PLAN-0344；字节游标 + UTF-8 边界由 Runtime 保证，`available=false` 表示 job/输出缺失） |
| Runtime | job cancel (internal) | `POST /internal/v1/runtime/workspaces/{workspaceId}/jobs/cancel` | service Bearer | CP `POST /api/v1/operations/items/{itemId}/cancel`（PLAN-0366：`{jobId}` → 200 `{jobId,status:cancelled\|failed}`；404 `JOB_NOT_FOUND`；复用四阶段终止，`failed`=终止未确认由 CP 折叠 502） |
| Runtime | `/runtime/heartbeat` | `/internal/v1/runtime/heartbeat` | service Bearer | Runtime heartbeat |
| Runtime | `/remote-mcp/{workspaceId}/{serverId}/call` | `/internal/v1/runtime/remote-mcp/{workspaceId}/{serverId}/call` | service Bearer | CP |
| Runtime | stdio MCP session call | `POST /internal/v1/runtime/workspaces/{workspaceId}/mcp/stdio/{serverId}` | service Bearer | CP MCP 代理（PLAN-0347：exec attach 直连会话；错误码 `MCP_SESSION_UNAVAILABLE/FAILED/BUSY`） |
| Runtime | stdio MCP session snapshots | `GET /internal/v1/runtime/workspaces/{workspaceId}/mcp/servers`、`DELETE .../servers/{serverId}` | service Bearer | 运维/测试与后续 CP/UI 状态面（PLAN-0347；spawn 端点已退役 410） |
| CP | `/workspaces/{workspaceId}/environment` | `/api/v1/workspaces/{workspaceId}/environment` | user Bearer | UI environment status view |
| CP | `/workspaces/{workspaceId}/materialize` (proxy, 202) | `/api/v1/workspaces/{workspaceId}/materialize` | user Bearer | UI Prepare button (PLAN-262 M4) |
| Agent | `/chat`, `/rag/**`, `/approval/**`, `/mcp/reinit`, `/registry/**` | `/internal/v1/agent/...` equivalent | service Bearer | CP/admin service; approval response/status are never browser routes; chat payload carries CP-resolved `userOverrides`/`workspaceOverrides` (PLAN-0307 T2.7, env-locked keys excluded, merged per run without side effects) |
| Agent | `/v1/models`, `/v1/embedding-models` | `/internal/v1/agent/models`, `/internal/v1/agent/embedding-models` | service Bearer | UI through CP proxy |
| Agent | `/internal/v1/agent/health`, `/internal/v1/agent/tools` | unchanged `/internal/v1/agent/...` | health public/tools service Bearer | probes/admin |
| Agent | `/summarize` | `/internal/v1/agent/summarize` | service Bearer | CP `LlmSummaryProvider`（PLAN-0354）：CP 签发 2 分钟短租约，Agent 经既有 `/internal/v1/provider-leases/redeem` 兑换后单次调用 provider；`credentialLease`/`text` 必填（缺 → 400 `INVALID_REQUEST`），兑换失败 → 503 `PROVIDER_CONNECTION_UNAVAILABLE`，provider 调用失败 → 502 + `_classify_llm_exception` 细分码；200 `{summary, usage}`（六节摘要不含 `[Constraints]`，0343 同名 usage）；无事件/无持久化；CP 对任何非 2xx 一律记回退原因 `agent_error` |

## MCP Tool Surface

- Gateway-public built-ins are the 23 tools exposed by Runtime `#[tool_router]` and merged by CP `tools/list`; `apply_patch` is exposed to the Agent as an atomic multi-file mutation and is classified as `actionClass: write`, `shape: structured`, `REQUIRE_APPROVAL`.

## Contract Rules

- Public HTTP routes use `/api/v1`; service routes use `/internal/v1`.
- Service authentication is `Authorization: Bearer <token>` only.
- Xihe-owned JSON uses camelCase. MCP JSON-RPC fields and headers remain as
  defined by MCP `2026-07-28`.
- Cross-module operation correlation uses `X-Operation-Id`,
  `X-Operation-Item-Id`, and `X-Operation-Attempt-Id`; Chat responses expose the
  durable root `operationId` without exposing prompt contents.
- Errors use `application/problem+json` with `type`, `title`, `status`,
  `code`, `detail`, and `requestId`.
- No query-string tokens, `X-Api-Token`, old path aliases, or field fallbacks.

## Policy Tool-Face Contract (PLAN-0328)

- `GET /api/v1/policy/tool-faces?scope=instance|workspace` returns a deterministic effective catalog sorted by `tool`.
- Built-in catalog entries use `scope: builtin`, `id: null`, and `ownerId: null`; persisted instance/workspace entries retain their UUID and owner identity and override entries for the same tool at lower precedence.
- `scope=builtin` is response metadata only and is not accepted by the write route. Role and tenant authorization remain server-side through `TenantContext`.
- Unknown third-party tools are absent from the catalog until their first approval request. Before explicit owner/admin classification, their policy face is `actionClass: unclassified`, `shape: opaque`, and the verdict is `ask` even under automatic modes; one-shot approval remains available while session/saved rule grants are rejected.

## Policy Rules Contract (PLAN-0328)

- `GET /api/v1/policy/domains` returns `actionClass`, `effectiveLayer` (`builtin` when no persisted layer configures the domain), `configuredLayers`, and `ruleCounts` (only layers holding at least one rule). This is the UI's "domain and effective layer" source; clients never infer the effective layer locally.
- `GET /api/v1/policy/rules?layer=` returns `RuleView` rows whose `effective` flag reports whether the rule's layer is the domain's effective layer — it does not mean the rule matched at runtime. `conflict` carries the server's static shadowing note (for example an allow covered by a more specific deny) or `null`.
- `GET /api/v1/policy/rules/conflicts?layer=` is the filtered conflict view of the same rows; conflict detection stays server-side (`PolicyRuleService.conflicts`) and must not be reimplemented in the UI.
- `POST /api/v1/policy/rules` creates `{layer, actionClass, resource, effect, priority, locked}`. Instance writes require ADMIN, workspace writes require workspace OWNER/ADMIN, and `locked` requires ADMIN and only accepts deny/ask (DB CHECK V15). `DELETE /api/v1/policy/rules/{id}?layer=` is layer/owner scoped and returns 404 for foreign rows.
- Every response is camelCase with UUID rule ids and RFC 9457 Problem Details (`401`/`403`/`404`). The UI relies on the server `403` for write authority and never equates `effective=true` with a runtime match.

## Approval Grant Reuse Contract (PLAN-0328 T1.7)

- **Durable binding (V20/V21)**: `approval_requests` carries `policy_revision` (the durable monotonic `policy_revision.seq` counter, incremented for every policy/tool-face change, including deletion), `sandbox_generation` (`Workspace.generation` at decision time) and `reuse_scope` (`once|session|saved`; legacy NULL rows are treated as `once`, fail-closed). A plain `(session_id, tool, arguments_hash)` index backs the gate's idempotent lookup.
- **Consume checks (all fail-closed)**: a grant is consumed once and only while unexpired, with `rank(modeAtGrant) >= rank(currentMode)` (`manual > auto`; NULL mode ranks as `manual`), an unchanged durable `policy_revision`, and a matching `sandbox_generation`. Legacy rows without the V20 columns are rejected. The `approval_grant_consumed` audit record is emitted inside the consume transaction (R7).
- **Session tier = exact fingerprint**: a `session` decision records `{tool, arguments_hash, modeAtGrant, policyRevision, sandboxGeneration}` in memory (12h TTL, ≤64 entries/session, cleared on session delete) instead of a coarse L4 rule; the MCP gate dispatches the same invocation without a new pending approval and audits `grant_reused scope=session`. `saved`/`reject_always` keep writing persistent rules and now also record the new columns.
- **Gate idempotency + shape ceiling**: before creating a pending row the gate returns the live non-terminal row for the same `(sessionId, tool, arguments_hash)`. Allowed reuse tiers are shape-gated (structured → once/session/saved; structured+delete → once; interpreter → once/session; opaque/unclassified → once) and violations return `400 REUSE_NOT_ALLOWED_FOR_SHAPE`; unclassified tools keep their existing `409 TOOL_UNCLASSIFIED` path first.
- **409 APPROVAL_REQUIRED extension**: run-scoped ASK responses carry a JSON-RPC error frame (`error.code: -32003`, `error.message: APPROVAL_REQUIRED`) whose `error.data` holds `{status, code, approvalRequestId, tool, expiresAt, retryHeader, statusUrl?, policy?}`; MCP transports discard `application/problem+json` bodies, so the extension must travel in the JSON-RPC frame. Without a run context the gate keeps the legacy problem+json 409 (no extension; the Agent fails closed with no waiter).

## Chat SSE Contract (PLAN-230)

- **Persistence**: `GET /api/v1/events?sessionId=` is a session-scoped long-lived SSE. `done` terminates a *run*, not the SSE. Only client disconnect, session deletion, or explicit server termination closes it. Heartbeat `event: heartbeat` every 15s; never enters UI `MessagePart`.
- **Identity**: One active emitter per `sessionId` (v1). `SseEmitterManager` stores `{sessionId, generation, emitter}` and uses `compareAndRemove`; new connection replaces old (`chat_sse_replaced`) and old `onCompletion`/`onTimeout`/`onError` that no longer own the entry are logged as `chat_sse_stale_cleanup_ignored`.
- **Gate**: `POST /api/v1/chat` checks `hasEmitter(sessionId)` *before* persisting the user message. On miss: `409 SSE_SUBSCRIPTION_REQUIRED`; on concurrent run: `409 CHAT_IN_PROGRESS` / `429` / `503 AGENT_CIRCUIT_OPEN`.
- **Events per run**: `connected` (SSE open) → optional `status`/`thinking` → optional `tool_call`/`tool_result` → `token` (≥1) → `done` (exactly one; `error` + `done(error)` on failure). Real MiMo long replies produce ≥2 `token` events; `on_chat_model_end` fallback fires only when no `on_chat_model_stream` was emitted (`LangGraphEventAdapter` per `run_id`).
- **Diagnostics (PLAN-0342)**: a failed, parseable command result may add an optional `diagnostics` bundle (`{items, total, confidence}`; `items` is the Top-N slice of `total`) to the `tool_result` data — copied from the Agent tool-message artifact channel and relayed unchanged by CP; the model-visible `<diagnostics>` block stays inside the untrusted envelope.
- **Approval**: `approval_request` is persisted by CP before dispatch to the UI and its live/replay envelope contains canonical `requestId/runId/sessionId/workspaceId/tool/action/details/expiresAt/replayed` (`requestId` is a UUID), with optional legacy-preserved `argumentsHash/state`, the durable creation `origin` (`cp_gate` for CP-gate rows, `agent_relay` for model-initiated `request_approval`; null for pre-V25 rows), plus an optional safe `policy` summary (`effect/sourceLayer/matchedRule/reason/mode/actionClass/shape/reused`, with `modeAtGrant` when emitted); it never includes raw tool arguments. Browser decisions use `POST /api/v1/chat/approvals/{requestId}/decision`, while CP alone calls Agent `/internal/v1/agent/approval/respond`. The Agent `/internal/v1/agent/approval/{requestId}` status is a separate raw coordinator response and does not carry the CP policy summary or replay/state fields. Reconnect replays live approval/retry requests for the same authorized session only; `dispatching` is in-flight and not actionable in the UI. Post-gate (T1.7/T1.9): a run-scoped ASK without a valid consume or session grant creates/reuses the durable pending row and answers `409` with a JSON-RPC error frame whose `error.data` carries `approvalRequestId/tool/expiresAt/retryHeader/statusUrl/policy`; without a run context the gate keeps the legacy problem+json 409 without extension.
- **Observability**: CP logs `chat_sse_registered` / `replaced` / `stale_cleanup_ignored` / `client_closed` / `send_failed` with `sessionId` + `connectionGeneration`; `chat_run_started` / `forwarded` / `finished` / `failed` with `requestId` + `runId`; `chat_stream_event_received` / `relay_finished` with `eventIndex` + `tokenCount` (never token content). `requestId` from `RequestIdFilter` is explicitly propagated to `execAsync` via `X-Request-Id`/`X-Chat-Run-Id` (not thread-local).
- **UI**: `chatTransport` enforces single flight per session (`connectionGeneration` + `intentionalStops`), `fetch-event-source` retry is *solely* in transport (`onerror` returns explicit backoff 250ms→5s, `onclose` schedules at most one reconnect; no second retry loop). `useSSE.ensureConnected()` + one-shot `409` recovery, `SSEStream` replaces streaming parts on every `token` (`replaceStreamingParts`).

## ChatRun Contract (PLAN-247)

- CP creates a durable `ChatRun` only after readiness, SSE subscription, authorization, and single-flight gates pass. The run is unique by `(userId, sessionId, Idempotency-Key)` and stores a request hash.
- Duplicate keys with the same payload return the existing run without starting Agent again; a different payload returns `409 IDEMPOTENCY_KEY_CONFLICT`.
- Terminal outcomes are `success`, `error`, `partial`, and `ambiguous`. A provider disconnect with uncertain execution is `ambiguous` and must not be automatically retried. Manual retry uses a new key.
- `/api/v1/exec` is intentionally absent; callers use `/api/v1/chat`.

## Checkpoint Slice Contract (PLAN-0338 + PLAN-0339)

- **Runtime routes (internal, CP is the caller)**: `POST /internal/v1/runtime/workspaces/{workspaceId}/checkpoints/capture` (`{runId, actor, callId, abnormal}` → `{runId, noChange, sliceRef, commit, capturedAt, state, changedFiles, opaqueNestedRepos, predecessor}`), `POST .../checkpoints/gc` (slice retention counts), `POST .../checkpoints/cleanup` (`{removed}`; idempotent, `409 CHECKPOINT_BUSY` while capture/restore is active), `POST .../checkpoints/revert/preview` (`{sliceRef}` → `{sliceRef, counts:{restore,delete,typeConflict}, entries, truncated}`), `POST .../checkpoints/revert` (`{sliceRef, acknowledgeTypeChanges}` → `{sliceRef, counts:{restored,deleted,failed}, entries, durationMs, suspects}`), `GET .../checkpoints/blob?sliceRef=&path=` (plain text ≤ 1 MiB), and `GET /internal/v1/runtime/workspaces/{workspaceId}/git-status` (`{isRepository, entries}`; non-Git workspaces answer `false`). All service errors use RFC 9457 Problem Details.
- **CP projection (`run_checkpoints`, rebuilt by PLAN-0339 V27)**: workspace slice rows, with no Run-scoped compatibility row. Each row exposes `id`, `sliceRef`, `capturedAt`, `sourceRunId`, `sourceSessionId`, `predecessorRef`, `changedFiles`, `changedCount`, `opaqueNestedRepos`, `state`, `unrollableReason`, and `revert`. `changedFiles` is the diff against the preceding chain slice; if the predecessor is absent it is empty rather than a fabricated full-tree list. States are `captured | abnormal-captured | degraded | expired`; expired rows are not returned by the public list.
- **Revert bookkeeping**: `revert` contains `state` (`none | rolled_back | partial | failed`), `at`, `counts`, `ref` (the restored slice ref), and `attemptCount`. UI restore appends the `kind=checkpoint`, `source=ui`, `tool_name=revert_checkpoint` ledger fact; the summary is bounded and never contains raw arguments or file content.
- **Public workspace routes**: `GET /api/v1/workspaces/{workspaceId}/checkpoints` returns the direct JSON slice array; `POST .../checkpoints/revert/preview` accepts `{sliceRef}`; `POST .../checkpoints/revert` accepts `{sliceRef, acknowledgeTypeChanges}`; `GET .../checkpoints/blob?sliceRef=&path=` reads a slice file; `POST .../checkpoints/cleanup` requires `{acknowledge:true}` and clears CP rows only after Runtime cleanup succeeds. All are owned by `requireAccessibleWorkspace` (404 `WORKSPACE_NOT_FOUND`), and the Agent has no restore route.
- **Retained workspace routes**: `GET /api/v1/workspaces/{workspaceId}/git-status` remains the user-repository side of the dual diff; `GET .../checkpoints/retention` keeps the fixed newest-50/30-day policy; `POST .../checkpoints/gc` returns Runtime sweep counts.
- **Trigger and safety**: capture occurs once at Run termination, during abnormal recovery, or for C0 materialization; unchanged trees do not create a slice. Restore previews list all paths that will be restored or deleted, mark `truncated` when bounded, require explicit type-change acknowledgement, and report concurrent-write `suspects`. Capture/restore use short locks; a restore does not block concurrent writes, so the risk remains visible in the preview/result.

## Tool Timeout Budget (PLAN-0308 M1)

- **per-call request**: `POST /api/v1/chat` accepts an optional `toolTimeouts` object (`{toolName: seconds}`) — the highest-priority input to the tool budget. Values are positive integer seconds, max 600 (code constant); invalid or oversized values return `400 INVALID_REQUEST` naming the offending key (never silently clamped). The map participates in the idempotency request hash, so replaying a key with different timeouts is `409 IDEMPOTENCY_KEY_CONFLICT`, not a silent reuse.
- **CP → Agent delivery**: CP is the only timeout calculator; the run payload carries `toolWaits` (final per-tool Agent wait = budget + 4s), `toolWaitOrigins` (`per-call | config`), `systemToolWait` (single value covering all system tools), raw `toolTimeouts`, and `budgetCoverage` (`partial` when the tool→server cache was cold). The Agent only consumes these values (three judgments, no arithmetic).
- **CP → Runtime delivery**: `X-Xihe-Tool-Timeout-S` (Runtime budget) and `X-Xihe-Tool-Timeout-Origin` are set by CP alone; upstream same-name headers are stripped at ingress, and a validated inbound per-call header is stripped before forwarding. The same headers ride both the system/stdio and remote forward paths.
- **Agent → CP (per-call carrier)**: when the run payload has a per-call entry for the tool being called, the Agent attaches it as the inbound header `X-Xihe-Tool-Timeout-Per-Call`; CP validates it (positive integer ≤ 600, else `400`) and forwards with `valueOrigin=per-call`, which overrides each hop's own ENV.
