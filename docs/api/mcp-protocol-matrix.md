# MCP Protocol Matrix

| Operation | Logical endpoint | Internal transport | Required headers | Body/response rule |
|---|---|---|---|---|
| initialize/tools/list/tools/call | `/api/v1/mcp` | `/internal/v1/runtime/workspaces/{workspaceId}/mcp` | `Authorization: Bearer`, MCP `Accept`, optional `Mcp-Session-Id` | JSON-RPC fields remain unchanged |
| server stream | `/api/v1/mcp` `GET` | same runtime route | Bearer, `Accept: text/event-stream` | SSE data is MCP JSON-RPC |
| disconnect | `/api/v1/mcp` `DELETE` | same runtime route | Bearer, `Mcp-Session-Id` | status/body follows MCP transport |
| remote call | not browser-visible | `/internal/v1/runtime/remote-mcp/{workspaceId}/{serverId}/call` | service Bearer | MCP JSON-RPC envelope unchanged |
| OAuth token broker | not MCP logical API | `/internal/v1/oauth/token` | service Bearer | OAuth standard snake_case fields remain unchanged |

MCP protocol names, JSON-RPC keys, `Mcp-Session-Id`, `Last-Event-ID`, and
OAuth wire fields are protocol-owned and are not camel-cased.
