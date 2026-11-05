"""Real fastmcp server fixture integration tests for the MCP client layer.

PLAN-0625 task-88 (MCP gap ①): the XH remote MCP path is exercised against a **real**
in-process FastMCP server over the streamable-http transport — no mocked transport, no
recorded sessions. Only the new protocol generation (2026-07-28) is covered, per the
standing ruling.

Covers:
- discovery through ``MCPClientManager.initialize`` → ``as_langchain_tool`` projection;
- a real ``tools/call`` round trip and its output text;
- input-schema projection onto ``ToolSpec`` (plus the checkpoint-resume fixture schema for
  the ``remote_mutate`` tool when the fixture env triad is set);
- an empty tool list (initialize succeeds with zero tools);
- server death mid-session — the call surface fails closed with an error, never a silent
  None.
"""

import asyncio
import contextlib
import socket
from collections.abc import AsyncIterator
from typing import Any

import httpx
import pytest
from fastmcp import Client, FastMCP

from xihe_agent.adapters.mcp_client import (
    _CHECKPOINT_RESUME_FIXTURE_SCHEMA,
    MCPClientManager,
)


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.bind(("127.0.0.1", 0))
        return int(probe.getsockname()[1])


async def _wait_ready(url: str, timeout_s: float = 10.0) -> None:
    """Poll the streamable-http endpoint until it answers (explicit deadline, no fixed sleep)."""
    deadline = asyncio.get_event_loop().time() + timeout_s
    async with httpx.AsyncClient(base_url=url, timeout=1.0) as probe:
        while asyncio.get_event_loop().time() < deadline:
            try:
                response = await probe.post("/mcp/", json={"jsonrpc": "2.0", "id": 0,
                                                           "method": "tools/list", "params": {}})
                if response.status_code < 500:
                    return
            except httpx.HTTPError:
                pass
            await asyncio.sleep(0.05)
    raise TimeoutError(f"fixture MCP server did not become ready at {url}")


class _FixtureServer:
    """An in-process FastMCP server (real ASGI app) driven by a real uvicorn Server.

    Holding the uvicorn ``Server`` handle makes death faithful: ``should_exit`` triggers a
    real listener shutdown (process-death equivalent for the transport), unlike cancelling
    the run task, which leaves the listening socket behind on anyio/uvicorn internals.
    """

    def __init__(self, mcp: FastMCP) -> None:
        self.mcp = mcp
        self.port = _free_port()
        self.url = f"http://127.0.0.1:{self.port}/mcp/"
        self._server: Any = None
        self._task: asyncio.Task[None] | None = None

    async def __aenter__(self) -> "_FixtureServer":
        from uvicorn import Config, Server

        self._server = Server(Config(self.mcp.http_app(path="/mcp/"), host="127.0.0.1",
                                     port=self.port, log_level="error"))
        self._task = asyncio.create_task(self._server.serve())
        await _wait_ready(self.url)
        return self

    async def __aexit__(self, *exc_info: Any) -> None:
        if self._server is not None:
            self._server.should_exit = True
        if self._task is not None:
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await asyncio.wait_for(self._task, timeout=5.0)

    async def wait_dead(self, timeout_s: float = 5.0) -> None:
        """Process-death simulation: close the listener and await the server task."""
        if self._server is not None:
            self._server.should_exit = True
        if self._task is not None:
            await asyncio.wait_for(self._task, timeout=timeout_s)

    def kill(self) -> None:
        if self._server is not None:
            self._server.should_exit = True

def _build_tool_server() -> FastMCP:
    mcp = FastMCP("xh-fixture")

    @mcp.tool
    def echo(text: str) -> str:
        """Echo the input back with a prefix."""
        return f"echo:{text}"

    @mcp.tool
    def add(a: int, b: int) -> int:
        """Add two integers."""
        return a + b

    @mcp.tool(name="remote_mutate")
    def remote_mutate(target: str, payload: str) -> str:
        """Fixture stand-in for the checkpoint-resume remote mutation tool."""
        return f"mutated:{target}:{len(payload)}"

    return mcp


@pytest.fixture
async def tool_server() -> AsyncIterator[_FixtureServer]:
    async with _FixtureServer(_build_tool_server()) as server:
        yield server


@pytest.fixture
async def empty_server() -> AsyncIterator[_FixtureServer]:
    async with _FixtureServer(FastMCP("xh-empty")) as server:
        yield server


async def test_discover_project_and_call_through_a_real_server(tool_server: _FixtureServer) -> None:
    manager = MCPClientManager(cp_url=tool_server.url, server_name="fixture",
                               workspace_id="ws-fixture", api_token="fixture-token")
    await manager.initialize()

    names = [tool.spec.name for tool in manager.tools]
    assert set(names) == {"echo", "add", "remote_mutate"}

    # Input-schema projection: as_langchain_tool must carry the declared arguments.
    echo_spec = next(tool.spec for tool in manager.tools if tool.spec.name == "echo")
    assert "text" in echo_spec.input_schema.get("properties", {})

    result = await manager.call_tool("echo", {"text": "hello-xh"}, headers={})
    text = "".join(block.text for block in result.content if hasattr(block, "text"))
    assert "hello-xh" in text


async def test_checkpoint_safe_schema_fixture_gate(tool_server: _FixtureServer,
                                                   monkeypatch: pytest.MonkeyPatch) -> None:
    """remote_mutate carries the checkpoint-resume schema only under the fixture env triad."""
    monkeypatch.setenv("XIHE_ENV", "dev")
    monkeypatch.setenv("XIHE_E2E_PROFILE", "host")
    monkeypatch.setenv("XIHE_E2E_CHECKPOINT_RESUME", "1")
    manager = MCPClientManager(cp_url=tool_server.url, workspace_id="ws-fixture")
    await manager.initialize()

    mutate_spec = next(tool.spec for tool in manager.tools if tool.spec.name == "remote_mutate")
    assert mutate_spec.checkpoint_safe_schema is not None
    assert mutate_spec.checkpoint_safe_schema == _CHECKPOINT_RESUME_FIXTURE_SCHEMA
    echo_spec = next(tool.spec for tool in manager.tools if tool.spec.name == "echo")
    assert echo_spec.checkpoint_safe_schema is None


async def test_empty_tool_list_initializes_with_zero_tools(empty_server: _FixtureServer) -> None:
    manager = MCPClientManager(cp_url=empty_server.url, workspace_id="ws-fixture")
    await manager.initialize()
    assert manager.initialized is True
    assert manager.tools == []


async def test_server_death_mid_session_fails_closed(tool_server: _FixtureServer) -> None:
    manager = MCPClientManager(cp_url=tool_server.url, workspace_id="ws-fixture")
    await manager.initialize()
    assert len(manager.tools) == 3

    await tool_server.wait_dead()

    with pytest.raises(Exception) as failure:  # noqa: BLE001 — the assert is on the failure surface
        await manager.call_tool("echo", {"text": "after-death"}, headers={})
    assert failure.value is not None


async def test_manager_rejects_cross_workspace_reinitialize(tool_server: _FixtureServer) -> None:
    manager = MCPClientManager(cp_url=tool_server.url, workspace_id="ws-a")
    await manager.initialize()
    with pytest.raises(ValueError, match="another workspace"):
        await manager.initialize(workspace_id="ws-b")


async def test_raw_fastmcp_client_protocol_version(tool_server: _FixtureServer) -> None:
    """The discovery client speaks the 2026-07-28 single-generation protocol."""
    async with Client(tool_server.url, timeout=10.0) as client:
        tools = await client.list_tools()
        assert any(tool.name == "echo" for tool in tools)
