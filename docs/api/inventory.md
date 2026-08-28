# Xihe API Inventory

This inventory is the implementation baseline for PLAN-191. It records the
routes found in source before the one-shot migration and their frozen target.

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
| CP | `/internal/config/**` | `/internal/v1/config/**` | service Bearer | Agent, Runtime |
| CP | `/workspaces/{id}/mcp-config` | `/api/v1/workspaces/{workspaceId}/mcp-config` | user Bearer | UI, Runtime config read |
| CP | `/files/**`, `/rag/**`, `/chat`, `/events`, `/exec` | `/api/v1/...` equivalent | user Bearer | UI |
| CP | `/api/v1/status`, `/api/v1/health`, `/api/v1/logs`, `/api/v1/telemetry/*` | unchanged `/api/v1/...` | public/user Bearer | UI/telemetry |
| CP | `/api/v1/sessions/{sessionId}/messages[/{messageId}]` | unchanged `/api/v1/...` | user Bearer | UI |
| CP | `/api/v1/sessions/{sessionId}/attachments[/{fileId}]` | unchanged `/api/v1/...` | user Bearer | UI |
| CP | `/api/v1/files/{fileId}`, `/api/v1/files/upload`, `/api/v1/files/split-pdf` | unchanged `/api/v1/...` | user Bearer | UI |
| CP | `/api/v1/rag/stats`, `/api/v1/rag/ingest`, `/api/v1/rag/search`, `/api/v1/rag/documents/{docId}` | unchanged `/api/v1/...` | user Bearer | UI |
| CP | `/api/v1/context/**` | `/internal/v1/context/**` | service Bearer | Agent context client |
| Runtime | `/workspace/**` | `/internal/v1/runtime/workspaces/**` | service Bearer | CP, UI through CP |
| Runtime | `/remote-mcp/{workspaceId}/{serverId}/call` | `/internal/v1/runtime/remote-mcp/{workspaceId}/{serverId}/call` | service Bearer | CP |
| Agent | `/chat`, `/rag/**`, `/approval/**`, `/mcp/reinit`, `/registry/**` | `/internal/v1/agent/...` equivalent | service Bearer | CP/admin service |
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
