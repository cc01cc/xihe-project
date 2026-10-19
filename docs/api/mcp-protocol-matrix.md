# MCP Protocol Matrix

| Operation | Logical endpoint | Internal transport | Required headers | Body/response rule |
|---|---|---|---|---|
| initialize/tools/list/tools/call | `/api/v1/mcp` | `/internal/v1/runtime/workspaces/{workspaceId}/mcp` | `Authorization: Bearer`, MCP `Accept` | JSON-RPC fields remain unchanged; `Mcp-Session-Id` is not accepted (403 `MCP_SESSION_INVALID`, PLAN-0537) |
| server stream | `/api/v1/mcp` `GET` | not forwarded | Bearer | 405 `MCP_STREAM_NOT_SUPPORTED` (stateless logical MCP) |
| disconnect | `/api/v1/mcp` `DELETE` | not forwarded | Bearer | 405 `MCP_SESSION_NOT_SUPPORTED` (stateless logical MCP) |
| remote call | not browser-visible | `/internal/v1/runtime/remote-mcp/{workspaceId}/{serverId}/call` | service Bearer | MCP JSON-RPC envelope unchanged |
| OAuth token broker | not MCP logical API | `/internal/v1/oauth/token` | service Bearer | OAuth standard snake_case fields remain unchanged |
| `start_background_process` | MCP tool (opaque `jobId`) | container `start_exec(detach)` + `/tmp/xihe-jobs/<jobId>/` state files | workspace MCP auth | `{meta,pid,stdout,stderr,exit}` bounded 1 MiB, TTL 15 min |
| `list/get_background_process` | MCP tool | oneshot exec reads job state files | workspace MCP auth | 404 `job not found` when orphaned by container rebuild |
| `cancel_background_process` | MCP tool | oneshot exec `kill -- -PGID` + `meta=cancelled` | workspace MCP auth | returns `cancelled`; TTL cleanup is periodic oneshot exec |
| `read_command_output` | MCP tool (structured page) | reads retained output bundle from `/tmp/xihe-jobs/<artifact_id>/` state files | workspace MCP auth | `stream=stdout\|stderr` (default stdout); returns `available/data/offset/nextOffset/sizeBytes/truncated` or `available:false+reason` (expired/rebuilt); cross-workspace and unknown ids rejected; offset/limit paged, never unbounded (PLAN-0381 T2.2) |

MCP protocol names, JSON-RPC keys, `Last-Event-ID`, and
OAuth wire fields are protocol-owned and are not camel-cased.
