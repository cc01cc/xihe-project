"""Tests for adapters/mcp_client.py - MCP client manager."""
import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from loguru import logger
from mcp.types import TextContent

from xihe_agent import main
from xihe_agent.adapters import mcp_client as mcp_client_module
from xihe_agent.adapters.approval_tool import ApprovalAgentTool
from xihe_agent.adapters.mcp_client import MCPAgentTool, MCPClientManager
from xihe_agent.interfaces.context import AgentContext


def _stub_tool(name: str, description: str = "", args_schema=None):
    return SimpleNamespace(name=name, description=description, args_schema=args_schema)


def _tool_result(text: str = "ok", is_error: bool = False):
    return SimpleNamespace(
        content=[TextContent(type="text", text=text)],
        structured_content=None,
        is_error=is_error,
    )


def _fake_manager(approval_tool=None, result=None, side_effect=None):
    manager = MagicMock()
    manager.approval_tool = approval_tool
    if side_effect is not None:
        manager.call_tool = AsyncMock(side_effect=side_effect)
    else:
        manager.call_tool = AsyncMock(return_value=result if result is not None else _tool_result())
    return manager


class _FakeDiscoveryClient:
    def __init__(self, *args, **kwargs):
        self.args = args
        self.kwargs = kwargs
        self.list_tools = AsyncMock(return_value=[])

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False


class _SingleToolDiscoveryClient(_FakeDiscoveryClient):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.list_tools = AsyncMock(return_value=[SimpleNamespace(name="test_tool")])


class _FailingDiscoveryClient:
    def __init__(self, *args, **kwargs):
        pass

    async def __aenter__(self):
        raise ConnectionError("refused")

    async def __aexit__(self, *exc):
        return False


def test_client_pins_stateless_protocol_generation():
    """PLAN-0308 决策 #34：客户端直接采纳 2026-07-28（无会话世代），免 server/discover 探测。"""
    from fastmcp.client.transports import StreamableHttpTransport

    manager = MCPClientManager(cp_url="http://localhost:12631", workspace_id="ws-1")
    client = manager.new_client({})
    assert mcp_client_module.STATELESS_PROTOCOL_VERSION == "2026-07-28"
    assert client.mode == "2026-07-28"
    assert isinstance(client.transport, StreamableHttpTransport)
    assert client.transport.url == "http://localhost:12631"


def test_request_headers_merges_static_and_dynamic():
    manager = MCPClientManager(
        cp_url="http://localhost:12631", workspace_id="ws-1", api_token="tok"
    )
    headers = manager.request_headers({"X-Session-Id": "s1"})
    assert headers == {
        "X-Workspace-Id": "ws-1",
        "Authorization": "Bearer tok",
        "X-Session-Id": "s1",
    }


class TestMCPClientManager:
    @pytest.fixture
    def manager(self):
        return MCPClientManager(
            cp_url="http://localhost:12631",
            server_name="cp",
            workspace_id="ws-1",
        )

    @pytest.fixture
    def log_sink(self):
        """Capture loguru output in a list for assertions."""
        messages = []
        sink_id = logger.add(messages.append, level="INFO")
        yield messages
        logger.remove(sink_id)

    def test_initial_state(self, manager):
        assert manager.initialized is False
        assert manager.tools == []
        assert manager.server_name == "cp"

    @pytest.mark.asyncio
    async def test_initialize_sets_initialized(self, manager):
        with patch(
            "xihe_agent.adapters.mcp_client.Client", _FakeDiscoveryClient
        ):
            await manager.initialize()

        assert manager.initialized is True

    @pytest.mark.asyncio
    async def test_tools_property_empty_before_init(self, manager):
        assert manager.tools == []

    @pytest.mark.asyncio
    async def test_initialize_populates_tools(self, manager):
        with (
            patch("xihe_agent.adapters.mcp_client.Client", _SingleToolDiscoveryClient),
            patch(
                "xihe_agent.adapters.mcp_client.as_langchain_tool",
                AsyncMock(return_value=_stub_tool("test_tool")),
            ),
        ):
            await manager.initialize()

        assert len(manager.tools) == 1
        assert manager.tools[0].spec.name == "test_tool"

    @pytest.mark.asyncio
    async def test_initialize_can_bind_request_workspace_before_discovery(self):
        manager = MCPClientManager(
            cp_url="http://localhost:12631",
            server_name="cp",
        )
        with patch("xihe_agent.adapters.mcp_client.Client", _FakeDiscoveryClient):
            await manager.initialize(workspace_id="request-workspace")

        assert manager.workspace_id == "request-workspace"
        transport = manager._discovery_client.args[0]
        assert transport.headers["X-Workspace-Id"] == "request-workspace"

    @pytest.mark.asyncio
    async def test_initialize_configures_only_the_cp_logical_endpoint(self, manager):
        with patch("xihe_agent.adapters.mcp_client.Client", _FakeDiscoveryClient):
            await manager.initialize()

        transport = manager._discovery_client.args[0]
        assert transport.url == "http://localhost:12631"
        assert "remote" not in transport.url
        assert transport.headers["X-Workspace-Id"] == "ws-1"

    @pytest.mark.asyncio
    async def test_initialize_logs_formatted_tool_count(self, manager, log_sink):
        with (
            patch("xihe_agent.adapters.mcp_client.Client", _SingleToolDiscoveryClient),
            patch(
                "xihe_agent.adapters.mcp_client.as_langchain_tool",
                AsyncMock(return_value=_stub_tool("test_tool")),
            ),
        ):
            await manager.initialize()

        text = "\n".join(log_sink)
        assert "MCP initialized: 1 tools from ['test_tool']" in text
        assert "%d" not in text

    @pytest.mark.asyncio
    async def test_ensure_ready_logs_formatted_retry_message(self, manager, log_sink):
        manager.retry_interval = 0.0
        manager.max_retries = 1

        with patch(
            "xihe_agent.adapters.mcp_client.Client", _FailingDiscoveryClient
        ):
            # ensure_ready now returns (gives up) instead of raising
            await manager.ensure_ready()

        text = "\n".join(log_sink)
        assert "[LIFECYCLE] service=agent event=mcp_init_failed" in text
        assert "attempt=1/1" in text
        assert "[LIFECYCLE] service=agent event=mcp_giving_up" in text
        assert "maxRetries=1" in text

    @pytest.mark.asyncio
    async def test_chat_without_workspace_does_not_initialize_mcp(self, monkeypatch):
        mock_manager = MagicMock()
        mock_manager.initialized = False
        mock_manager.workspace_id = None
        mock_manager.initialize = AsyncMock()
        mock_manager.tools = []
        monkeypatch.setattr(main, "mcp_manager", mock_manager)

        assert await main._get_mcp_tools(None) == []
        mock_manager.initialize.assert_not_awaited()


class TestMCPAgentToolApproval:
    @pytest.fixture
    def context(self):
        context = AgentContext.empty("session-1")
        context.metadata.update({
            "sessionId": "session-1",
            "workspaceId": "workspace-1",
            "runId": "run-1",
            "operationId": "operation-1",
        })
        return context

    @pytest.fixture
    def log_sink(self):
        messages = []
        sink_id = logger.add(messages.append, level="INFO")
        yield messages
        logger.remove(sink_id)

    @pytest.mark.asyncio
    async def test_sensitive_tool_waits_for_approval_and_injects_grant(self, context):
        context.metadata["operationItemId"] = "item-1"
        approval_tool = MagicMock(spec=ApprovalAgentTool)
        approval_tool.execute = AsyncMock(return_value={"requestId": "grant-1"})
        manager = _fake_manager(approval_tool=approval_tool, result=_tool_result("ok"))
        tool = MCPAgentTool(_stub_tool("write_file"), manager)

        result = await tool.execute({"path": "README.md"}, context)

        assert "ok" in result["content"]
        approval_tool.execute.assert_awaited_once()
        headers = manager.call_tool.await_args.args[2]
        assert headers == {
            "X-Session-Id": "session-1",
            "X-Chat-Run-Id": "run-1",
            "X-Operation-Id": "operation-1",
            "X-Operation-Item-Id": "item-1",
            "X-Xihe-Approval-Request-Id": "grant-1",
        }

    @pytest.mark.asyncio
    async def test_read_only_tool_propagates_run_context_without_approval(self, context):
        approval_tool = MagicMock(spec=ApprovalAgentTool)
        approval_tool.execute = AsyncMock()
        manager = _fake_manager(approval_tool=approval_tool, result=_tool_result("read-result"))
        tool = MCPAgentTool(_stub_tool("read_file"), manager)

        result = await tool.execute({"path": "README.md"}, context)

        assert "read-result" in result["content"]
        approval_tool.execute.assert_not_awaited()
        headers = manager.call_tool.await_args.args[2]
        assert headers == {
            "X-Session-Id": "session-1",
            "X-Chat-Run-Id": "run-1",
            "X-Operation-Id": "operation-1",
        }

    @pytest.mark.asyncio
    async def test_per_call_timeout_header_attached_only_for_named_tool(self, context):
        """PLAN-0308 T1.9：per-call 原始值随对应工具调用携带（CP 校验后采纳）。"""
        context.runtime_state["toolTimeouts"] = {"read_file": 120}
        manager = _fake_manager(result=_tool_result("ok"))

        tool = MCPAgentTool(_stub_tool("read_file"), manager)
        await tool.execute({}, context)
        assert manager.call_tool.await_args.args[2]["X-Xihe-Tool-Timeout-Per-Call"] == "120"

        other = MCPAgentTool(_stub_tool("list_directory"), manager)
        await other.execute({}, context)
        assert "X-Xihe-Tool-Timeout-Per-Call" not in manager.call_tool.await_args.args[2]

    @pytest.mark.asyncio
    async def test_per_call_timeout_header_present_on_approved_call(self, context):
        """审批工具的授权后调用同样携带 per-call 头（与只读路径同一规则）。"""
        context.runtime_state["toolTimeouts"] = {"execute_command": 120}
        approval_tool = MagicMock(spec=ApprovalAgentTool)
        approval_tool.execute = AsyncMock(return_value={"requestId": "grant-1"})
        manager = _fake_manager(approval_tool=approval_tool, result=_tool_result("ok"))
        tool = MCPAgentTool(_stub_tool("execute_command"), manager)

        await tool.execute({}, context)

        headers = manager.call_tool.await_args.args[2]
        assert headers["X-Xihe-Tool-Timeout-Per-Call"] == "120"
        assert headers["X-Xihe-Approval-Request-Id"] == "grant-1"

    @pytest.mark.asyncio
    async def test_post_grant_wait_is_logged_with_tool_call_id(self, context, log_sink):
        """T1.8（spec S5.1）：授权后转发的等待值打点，随 toolCallId 串三层时间线。"""
        context.metadata["operationItemId"] = "call-9"
        context.runtime_state["toolWaits"] = {"execute_command": 124}
        context.runtime_state["toolWaitOrigins"] = {"execute_command": "per-call"}
        approval_tool = MagicMock(spec=ApprovalAgentTool)
        approval_tool.execute = AsyncMock(return_value={"requestId": "grant-1"})
        manager = _fake_manager(approval_tool=approval_tool, result=_tool_result("ok"))
        tool = MCPAgentTool(_stub_tool("execute_command"), manager)

        await tool.execute({}, context)

        text = "\n".join(log_sink)
        assert "event=mcp_tool_post_grant" in text
        assert "toolCallId=call-9" in text
        assert "waitS=124" in text
        assert "valueOrigin=per-call" in text

    @pytest.mark.asyncio
    async def test_per_call_timeout_header_skips_invalid_values(self, context):
        """非法 per-call 值（CP 不会产生）不携带头，避免把坏值送给 CP。"""
        context.runtime_state["toolTimeouts"] = {"execute_command": 0, "write_file": "abc"}
        approval_tool = MagicMock(spec=ApprovalAgentTool)
        approval_tool.execute = AsyncMock(return_value={"requestId": "grant-1"})
        manager = _fake_manager(approval_tool=approval_tool, result=_tool_result("ok"))

        for name in ("execute_command", "write_file"):
            tool = MCPAgentTool(_stub_tool(name), manager)
            await tool.execute({}, context)
            assert "X-Xihe-Tool-Timeout-Per-Call" not in manager.call_tool.await_args.args[2]

    @pytest.mark.asyncio
    async def test_chat_with_workspace_initializes_mcp_on_demand(self, monkeypatch):
        mock_manager = MagicMock()
        mock_manager.initialized = False
        mock_manager.workspace_id = None
        mock_manager.initialize = AsyncMock()
        mock_manager.tools = []
        monkeypatch.setattr(main, "mcp_manager", mock_manager)

        assert await main._get_mcp_tools("request-workspace") == []
        mock_manager.initialize.assert_awaited_once_with(workspace_id="request-workspace")

    @pytest.mark.asyncio
    async def test_chat_fails_closed_for_a_different_bound_workspace(self, monkeypatch):
        mock_manager = MagicMock()
        mock_manager.initialized = True
        mock_manager.workspace_id = "bound-workspace"
        mock_manager.initialize = AsyncMock()
        mock_manager.tools = []
        monkeypatch.setattr(main, "mcp_manager", mock_manager)

        # Fail-closed: tools discovered for one workspace must never be reused
        # for another workspace; the request fails instead of silently returning [].
        with pytest.raises(RuntimeError, match="cannot be reused"):
            await main._get_mcp_tools("other-workspace")
        mock_manager.initialize.assert_not_awaited()


class TestMCPAgentToolTimeout:
    @pytest.mark.asyncio
    async def test_execute_returns_error_on_timeout(self):
        async def _hang(*args, **kwargs):
            await asyncio.sleep(30)

        manager = _fake_manager(side_effect=_hang)
        tool = MCPAgentTool(_stub_tool("hanging_tool"), manager)
        context = AgentContext.empty(aggregate_id="ctx-timeout")
        context.runtime_state["toolWaits"] = {"hanging_tool": 0.05}

        result = await tool.execute({"path": "x"}, context)

        assert "timed out" in result["content"]
        assert "hanging_tool" in result["content"]

    @pytest.mark.asyncio
    async def test_execute_wraps_success(self):
        manager = _fake_manager(result=_tool_result("hello"))
        tool = MCPAgentTool(_stub_tool("ok_tool"), manager)
        context = AgentContext.empty(aggregate_id="ctx-ok")

        result = await tool.execute({}, context)

        assert "hello" in result["content"]

    @pytest.mark.asyncio
    async def test_approval_tool_skips_outer_short_timeout(self):
        """write_file waits on the user; outer short bound must not kill the approval wait."""
        approval_tool = MagicMock(spec=ApprovalAgentTool)
        approval_tool.execute = AsyncMock(return_value={"requestId": "grant-1"})

        async def _slow(*args, **kwargs):
            await asyncio.sleep(0.2)
            return _tool_result("ok")

        manager = _fake_manager(approval_tool=approval_tool, side_effect=_slow)
        tool = MCPAgentTool(_stub_tool("write_file"), manager)
        context = AgentContext.empty(aggregate_id="ctx-approval-timeout")

        result = await tool.execute({"path": "a.md", "content": "x"}, context)

        # Not "timed out" — approval-class tools are bounded post-grant only.
        assert "ok" in result["content"]
        assert "timed out" not in result["content"]
