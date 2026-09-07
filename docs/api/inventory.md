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
| CP | `/config/**`, `/providers` | `/api/v1/config/**`, `/api/v1/providers` | user/admin Bearer | UI |
| CP | `/models` | `/api/v1/models` | user/admin Bearer | UI model selector; proxies provider status/capability without secrets |
| CP | `/internal/config/**` | `/internal/v1/config/**` | service Bearer | Agent, Runtime |
| CP | `/workspaces/{id}/mcp-config` | `/api/v1/workspaces/{workspaceId}/mcp-config` | user Bearer | UI |
| CP | `/workspaces/{id}/mcp-config` | `/internal/v1/config/workspaces/{workspaceId}/mcp-config` | service Bearer | Runtime config read |
| CP | `/workspaces/current`, `/workspaces`, `/workspaces/{workspaceId}` | unchanged under `/api/v1/workspaces/...` | user Bearer | UI, Runtime lifecycle |
| CP | `/sessions`, `/sessions/{sessionId}` | unchanged under `/api/v1/sessions/...` | user Bearer + current workspace | UI |
| CP | `/files/**`, `/rag/**` | `/api/v1/...` equivalent | user Bearer | UI |
| CP | `POST /api/v1/chat` | `POST /api/v1/chat` (requires active SSE, single in-flight, `202` + `runId`, `409 SSE_SUBSCRIPTION_REQUIRED` / `CHAT_IN_PROGRESS`) | user Bearer + current workspace | UI — enqueues async Agent relay; streams `token` → `done` on persistent SSE |
| CP | `POST /api/v1/chat/approvals/{requestId}/decision` | unchanged under `/api/v1/chat/approvals/{requestId}/decision` | user Bearer + authoritative request/session/run/workspace ownership | UI approval modal — CP persists/locks decision then forwards Agent service Bearer; same decision is idempotent |
| CP | `GET /api/v1/events?sessionId=` | `GET /api/v1/events?sessionId=` — **session-scoped persistent SSE** | user Bearer + current workspace | UI — one active emitter per `sessionId`; `done` ends run, not SSE; `heartbeat` (15s) is transport-only, never enters `MessagePart` |
| CP | `/api/v1/status`, `/api/v1/health`, `/api/v1/logs`, `/api/v1/telemetry/*` | unchanged `/api/v1/...` | public/user Bearer | UI/telemetry |
| CP | `/api/v1/sessions/{sessionId}/messages[/{messageId}]` | unchanged `/api/v1/...` | user Bearer | UI |
| CP | `/api/v1/sessions/{sessionId}/attachments[/{fileId}]` | unchanged `/api/v1/...` | user Bearer | UI |
| CP | `/api/v1/files/{fileId}`, `/api/v1/files/upload` | unchanged `/api/v1/...` | user Bearer | UI |
| CP | `/api/v1/rag/stats`, `/api/v1/rag/ingest`, `/api/v1/rag/search`, `/api/v1/rag/documents/{docId}` | unchanged `/api/v1/...` | user Bearer | UI |
| CP | `/api/v1/context/**` | `/internal/v1/context/**` | service Bearer | Agent context client |
| Runtime | `/workspace/**` | `/internal/v1/runtime/workspaces/**` | service Bearer | CP, UI through CP |
| Runtime | targeted execution spec lookup | `/internal/v1/runtime/workspaces/{workspaceId}/execution-spec` | service Bearer | Runtime lazy materialization |
| Runtime | per-workspace materialization status | `/internal/v1/runtime/workspaces/{workspaceId}/status` | service Bearer | CP environment view/diagnostics |
| Runtime | explicit materialization trigger (202, poll status) | `/internal/v1/runtime/workspaces/{workspaceId}/materialize` | service Bearer | CP materialize proxy (PLAN-262 M4) |
| Runtime | `/runtime/heartbeat` | `/internal/v1/runtime/heartbeat` | service Bearer | Runtime heartbeat |
| Runtime | `/remote-mcp/{workspaceId}/{serverId}/call` | `/internal/v1/runtime/remote-mcp/{workspaceId}/{serverId}/call` | service Bearer | CP |
| CP | `/workspaces/{workspaceId}/environment` | `/api/v1/workspaces/{workspaceId}/environment` | user Bearer | UI environment status view |
| CP | `/workspaces/{workspaceId}/materialize` (proxy, 202) | `/api/v1/workspaces/{workspaceId}/materialize` | user Bearer | UI Prepare button (PLAN-262 M4) |
| Agent | `/chat`, `/rag/**`, `/approval/**`, `/mcp/reinit`, `/registry/**` | `/internal/v1/agent/...` equivalent | service Bearer | CP/admin service; approval response/status are never browser routes |
| Agent | `/v1/models`, `/v1/embedding-models` | `/internal/v1/agent/models`, `/internal/v1/agent/embedding-models` | service Bearer | UI through CP proxy |
| Agent | `/internal/v1/agent/health`, `/internal/v1/agent/tools` | unchanged `/internal/v1/agent/...` | health public/tools service Bearer | probes/admin |

## Contract Rules

- Public HTTP routes use `/api/v1`; service routes use `/internal/v1`.
- Service authentication is `Authorization: Bearer <token>` only.
- Xihe-owned JSON uses camelCase. MCP JSON-RPC fields and headers remain as
  defined by MCP `2026-07-28`.
- Errors use `application/problem+json` with `type`, `title`, `status`,
  `code`, `detail`, and `requestId`.
- No query-string tokens, `X-Api-Token`, old path aliases, or field fallbacks.

## Chat SSE Contract (PLAN-230)

- **Persistence**: `GET /api/v1/events?sessionId=` is a session-scoped long-lived SSE. `done` terminates a *run*, not the SSE. Only client disconnect, session deletion, or explicit server termination closes it. Heartbeat `event: heartbeat` every 15s; never enters UI `MessagePart`.
- **Identity**: One active emitter per `sessionId` (v1). `SseEmitterManager` stores `{sessionId, generation, emitter}` and uses `compareAndRemove`; new connection replaces old (`chat_sse_replaced`) and old `onCompletion`/`onTimeout`/`onError` that no longer own the entry are logged as `chat_sse_stale_cleanup_ignored`.
- **Gate**: `POST /api/v1/chat` checks `hasEmitter(sessionId)` *before* persisting the user message. On miss: `409 SSE_SUBSCRIPTION_REQUIRED`; on concurrent run: `409 CHAT_IN_PROGRESS` / `429` / `503 AGENT_CIRCUIT_OPEN`.
- **Events per run**: `connected` (SSE open) → optional `status`/`thinking` → optional `tool_call`/`tool_result` → `token` (≥1) → `done` (exactly one; `error` + `done(error)` on failure). Real MiMo long replies produce ≥2 `token` events; `on_chat_model_end` fallback fires only when no `on_chat_model_stream` was emitted (`LangGraphEventAdapter` per `run_id`).
- **Approval**: `approval_request` is persisted by CP before dispatch to the UI and contains canonical `requestId/runId/sessionId/workspaceId/tool/action/details/expiresAt`; browser decisions use `POST /api/v1/chat/approvals/{requestId}/decision`, while CP alone calls Agent `/internal/v1/agent/approval/respond`. Reconnect replays pending requests for the same authorized session only.
- **Observability**: CP logs `chat_sse_registered` / `replaced` / `stale_cleanup_ignored` / `client_closed` / `send_failed` with `sessionId` + `connectionGeneration`; `chat_run_started` / `forwarded` / `finished` / `failed` with `requestId` + `runId`; `chat_stream_event_received` / `relay_finished` with `eventIndex` + `tokenCount` (never token content). `requestId` from `RequestIdFilter` is explicitly propagated to `execAsync` via `X-Request-Id`/`X-Chat-Run-Id` (not thread-local).
- **UI**: `chatTransport` enforces single flight per session (`connectionGeneration` + `intentionalStops`), `fetch-event-source` retry is *solely* in transport (`onerror` returns explicit backoff 250ms→5s, `onclose` schedules at most one reconnect; no second retry loop). `useSSE.ensureConnected()` + one-shot `409` recovery, `SSEStream` replaces streaming parts on every `token` (`replaceStreamingParts`).

## ChatRun Contract (PLAN-247)

- CP creates a durable `ChatRun` only after readiness, SSE subscription, authorization, and single-flight gates pass. The run is unique by `(userId, sessionId, Idempotency-Key)` and stores a request hash.
- Duplicate keys with the same payload return the existing run without starting Agent again; a different payload returns `409 IDEMPOTENCY_KEY_CONFLICT`.
- Terminal outcomes are `success`, `error`, `partial`, and `ambiguous`. A provider disconnect with uncertain execution is `ambiguous` and must not be automatically retried. Manual retry uses a new key.
- `/api/v1/exec` is intentionally absent; callers use `/api/v1/chat`.
