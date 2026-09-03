# MCP Protocol Matrix

| Operation | Logical endpoint | Internal transport | Required headers | Body/response rule |
|---|---|---|---|---|
| initialize/tools/list/tools/call | `/api/v1/mcp` | `/internal/v1/runtime/workspaces/{workspaceId}/mcp` | `Authorization: Bearer`, MCP `Accept`, optional `Mcp-Session-Id` | JSON-RPC fields remain unchanged |
| server stream | `/api/v1/mcp` `GET` | same runtime route | Bearer, `Accept: text/event-stream` | SSE data is MCP JSON-RPC |
| disconnect | `/api/v1/mcp` `DELETE` | same runtime route | Bearer, `Mcp-Session-Id` | status/body follows MCP transport |
| remote call | not browser-visible | `/internal/v1/runtime/remote-mcp/{workspaceId}/{serverId}/call` | service Bearer | MCP JSON-RPC envelope unchanged |
| OAuth token broker | not MCP logical API | `/internal/v1/oauth/token` | service Bearer | OAuth standard snake_case fields remain unchanged |
| `start_background_process` | MCP tool (opaque `jobId`) | container `start_exec(detach)` + `/tmp/xihe-jobs/<jobId>/` state files | workspace MCP auth | `{meta,pid,stdout,stderr,exit}` bounded 1 MiB, TTL 15 min |
| `list/get_background_process` | MCP tool | oneshot exec reads job state files | workspace MCP auth | 404 `job not found` when orphaned by container rebuild |
| `cancel_background_process` | MCP tool | oneshot exec `kill -- -PGID` + `meta=cancelled` | workspace MCP auth | returns `cancelled`; TTL cleanup is periodic oneshot exec |
| `read_command_output` | MCP tool | reads retained preview from job state files | workspace MCP auth | offset/limit paged; never unbounded |

MCP protocol names, JSON-RPC keys, `Mcp-Session-Id`, `Last-Event-ID`, and
OAuth wire fields are protocol-owned and are not camel-cased.
