"""Real local HTTP coverage for the Agent -> CP MCP boundary.

The fixture is a listening TCP server, not pytest-httpx interception.  It
records every request so a remote endpoint can never be accidentally used by
the Agent configuration.
"""

import asyncio
import json

import pytest
from mcp.types import LATEST_PROTOCOL_VERSION

from xihe_agent.adapters.mcp_client import MCPClientManager


class LocalCPFixture:
    def __init__(self) -> None:
        self.requests: list[tuple[str, str, dict[str, str], dict]] = []
        self.server: asyncio.AbstractServer | None = None

    async def start(self) -> str:
        self.server = await asyncio.start_server(self._handle, "127.0.0.1", 0)
        host, port = self.server.sockets[0].getsockname()[:2]
        return f"http://{host}:{port}/api/v1/mcp"

    async def close(self) -> None:
        assert self.server is not None
        self.server.close()
        await self.server.wait_closed()

    async def _handle(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        try:
            head = await reader.readuntil(b"\r\n\r\n")
            lines = head.decode("latin1").split("\r\n")
            method, path, _ = lines[0].split(" ", 2)
            headers = {
                key.lower(): value.strip()
                for key, value in (line.split(":", 1) for line in lines[1:] if ":" in line)
            }
            length = int(headers.get("content-length", "0"))
            raw_body = await reader.readexactly(length) if length else b"{}"
            body = json.loads(raw_body)
            self.requests.append((method, path, headers, body))
            rpc_method = body.get("method")
            if method == "POST" and rpc_method == "initialize":
                response_body = {
                    "jsonrpc": "2.0",
                    "id": body["id"],
                    "result": {
                        "protocolVersion": LATEST_PROTOCOL_VERSION,
                        "capabilities": {"tools": {}},
                        "serverInfo": {"name": "local-cp", "version": "test"},
                    },
                }
                status = "200 OK"
            elif method == "POST" and rpc_method == "tools/list":
                response_body = {
                    "jsonrpc": "2.0",
                    "id": body["id"],
                    "result": {
                        "tools": [
                            {
                                "name": "cp_echo",
                                "description": "Echo from CP",
                                "inputSchema": {"type": "object", "properties": {}},
                            }
                        ]
                    },
                }
                status = "200 OK"
            elif method == "POST" and rpc_method == "notifications/initialized":
                response_body = {}
                status = "202 Accepted"
            else:
                response_body = {"jsonrpc": "2.0", "id": body.get("id"), "result": {}}
                status = "200 OK"
            payload = json.dumps(response_body).encode()
            response = (
                f"HTTP/1.1 {status}\r\n"
                "Content-Type: application/json\r\n"
                "MCP-Session-Id: local-session\r\n"
                f"Content-Length: {len(payload)}\r\n\r\n"
            ).encode() + payload
            writer.write(response)
            await writer.drain()
        finally:
            writer.close()
            await writer.wait_closed()


@pytest.mark.integration
@pytest.mark.asyncio
async def test_agent_uses_only_the_cp_http_boundary() -> None:
    fixture = LocalCPFixture()
    cp_url = await fixture.start()
    try:
        manager = MCPClientManager(
            cp_url=cp_url,
            server_name="cp",
            workspace_id="ws-wire",
            api_token="agent-token",
        )
        await manager.initialize()

        assert manager.initialized is True
        assert [tool.spec.name for tool in manager.tools] == ["cp_echo"]
        assert fixture.requests
        assert {request[2]["host"] for request in fixture.requests} == {
            cp_url.removeprefix("http://").split("/", 1)[0]
        }
        methods = {request[0] for request in fixture.requests}
        assert methods == {"POST", "GET", "DELETE"}
        assert any(request[0] == "POST" for request in fixture.requests)
        assert any(request[0] == "GET" for request in fixture.requests)
        assert any(request[0] == "DELETE" for request in fixture.requests)
        assert all(request[1] == "/api/v1/mcp" for request in fixture.requests)
        assert all("remote" not in request[1].lower() for request in fixture.requests)
        assert all(request[2]["authorization"] == "Bearer agent-token" for request in fixture.requests)
        assert all(request[2]["x-workspace-id"] == "ws-wire" for request in fixture.requests)
    finally:
        await fixture.close()
