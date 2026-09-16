"""Tests for adapters/mcp_client.py - MCP client manager."""
import asyncio
import json
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from loguru import logger
from mcp.shared.exceptions import MCPError
from mcp.types import TextContent

from xihe_agent import main
from xihe_agent.adapters import mcp_client as mcp_client_module
from xihe_agent.adapters.approval_tool import (
    ApprovalAgentTool,
    ApprovalExpiredError,
    ApprovalProtocolError,
    ApprovalRejectedError,
    ApprovalRetryFailedError,
)
from xihe_agent.adapters.mcp_client import (
    APPROVAL_GRANT_HEADER,
    MCPAgentTool,
    MCPClientManager,
    classify_approval_gate_failure,
)
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


class _ApplyPatchDiscoveryClient(_FakeDiscoveryClient):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.list_tools = AsyncMock(return_value=[SimpleNamespace(name="apply_patch")])


class _FailingDiscoveryClient:
    def __init__(self, *args, **kwargs):
        pass

    async def __aenter__(self):
        raise ConnectionError("refused")

    async def __aexit__(self, *exc):
        return False


def test_client_pins_stateless_protocol_generation():
    """PLAN-0308 决策 #34/T3.1：pin 2026-07-28（无会话世代，免 server/discover 探测），
    并显式设置 3600s 传输层挂死兜底（避免 SDK 默认 read=300s 抢先于逻辑授权值）。"""
    from fastmcp.client.transports import StreamableHttpTransport

    manager = MCPClientManager(cp_url="http://localhost:12631", workspace_id="ws-1")
    client = manager.new_client({})
    assert mcp_client_module.STATELESS_PROTOCOL_VERSION == "2026-07-28"
    assert client.mode == "2026-07-28"
    assert client._session_kwargs["read_timeout_seconds"] == 3600.0
    discovery = manager.new_client({}, timeout=mcp_client_module.DISCOVERY_READ_TIMEOUT_S)
    assert discovery._session_kwargs["read_timeout_seconds"] == 30.0
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
    async def test_initialize_discovers_apply_patch_from_workspace_gateway(self, manager):
        with (
            patch("xihe_agent.adapters.mcp_client.Client", _ApplyPatchDiscoveryClient),
            patch(
                "xihe_agent.adapters.mcp_client.as_langchain_tool",
                AsyncMock(return_value=_stub_tool("apply_patch")),
            ),
        ):
            await manager.initialize()

        assert [tool.spec.name for tool in manager.tools] == ["apply_patch"]

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
    async def test_sensitive_tool_dispatches_without_any_local_approval(self, context):
        """PLAN-0337 M2：写类工具首调用直达 CP 闸门，Agent 不做本地前置审批。"""
        context.metadata["operationItemId"] = "item-1"
        approval_tool = MagicMock(spec=ApprovalAgentTool)
        approval_tool.execute = AsyncMock()
        manager = _fake_manager(approval_tool=approval_tool, result=_tool_result("ok"))
        tool = MCPAgentTool(_stub_tool("write_file"), manager)

        result = await tool.execute({"path": "README.md"}, context)

        assert "ok" in result["content"]
        approval_tool.execute.assert_not_awaited()
        headers = manager.call_tool.await_args.args[2]
        assert headers == {
            "X-Session-Id": "session-1",
            "X-Chat-Run-Id": "run-1",
            "X-Operation-Id": "operation-1",
            "X-Operation-Item-Id": "item-1",
        }
        assert APPROVAL_GRANT_HEADER not in headers

    @pytest.mark.asyncio
    async def test_apply_patch_dispatches_without_any_local_approval(self, context):
        """PLAN-0337 M2：apply_patch 与其它写类工具同一路径，均由 CP 闸门裁决。"""
        context.metadata["operationItemId"] = "item-apply-patch"
        approval_tool = MagicMock(spec=ApprovalAgentTool)
        approval_tool.execute = AsyncMock()
        manager = _fake_manager(approval_tool=approval_tool, result=_tool_result("patched"))
        tool = MCPAgentTool(_stub_tool("apply_patch"), manager)
        patch_arguments = {
            "patches": [
                {
                    "path": "new.md",
                    "expectedHash": "",
                    "hunks": [{"before": "", "after": "new"}],
                }
            ]
        }

        result = await tool.execute(patch_arguments, context)

        assert "patched" in result["content"]
        approval_tool.execute.assert_not_awaited()
        headers = manager.call_tool.await_args.args[2]
        assert APPROVAL_GRANT_HEADER not in headers
        assert manager.call_tool.await_args.args[1] == patch_arguments

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
    async def test_per_call_timeout_header_present_on_mutation_call(self, context):
        """PLAN-0337 M2：写类工具同样走单一派发路径，per-call 头与只读路径同一规则。"""
        context.runtime_state["toolTimeouts"] = {"execute_command": 120}
        approval_tool = MagicMock(spec=ApprovalAgentTool)
        approval_tool.execute = AsyncMock()
        manager = _fake_manager(approval_tool=approval_tool, result=_tool_result("ok"))
        tool = MCPAgentTool(_stub_tool("execute_command"), manager)

        await tool.execute({}, context)

        headers = manager.call_tool.await_args.args[2]
        assert headers["X-Xihe-Tool-Timeout-Per-Call"] == "120"
        assert APPROVAL_GRANT_HEADER not in headers

    @pytest.mark.asyncio
    async def test_dispatch_wait_is_logged_with_tool_call_id(self, context, log_sink):
        """T1.8（spec S5.1）：派发等待值打点，随 toolCallId 串三层时间线。"""
        context.metadata["operationItemId"] = "call-9"
        context.runtime_state["toolWaits"] = {"execute_command": 124}
        context.runtime_state["toolWaitOrigins"] = {"execute_command": "per-call"}
        manager = _fake_manager(result=_tool_result("ok"))
        tool = MCPAgentTool(_stub_tool("execute_command"), manager)

        await tool.execute({}, context)

        text = "\n".join(log_sink)
        assert "event=mcp_tool_wait" in text
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


# ---------------------------------------------------------------------------
# PLAN-0328 T1.9 post-gate protocol: CP MCP gate 409 APPROVAL_REQUIRED
# ---------------------------------------------------------------------------


def _future_iso(seconds: float = 30.0) -> str:
    return (datetime.now(UTC) + timedelta(seconds=seconds)).isoformat().replace("+00:00", "Z")


def _gate_problem(tool: str, **overrides) -> dict:
    problem = {
        "type": "https://xihe.dev/problems/approval_required",
        "title": "Request failed",
        "status": 409,
        "code": "APPROVAL_REQUIRED",
        "detail": "Tool execution requires approval before dispatch",
        "requestId": "cp-request-1",
        "approvalRequestId": "apr-00000001",
        "tool": tool,
        "expiresAt": _future_iso(),
        "retryHeader": "X-Xihe-Approval-Request-Id",
        "statusUrl": "/api/v1/approvals/apr-00000001",
        "policy": {
            "effect": "ask",
            "sourceLayer": "builtin",
            "matchedRule": "{ write, *, ask }",
            "reason": "mutation requires approval",
            "mode": "default",
            "actionClass": "write",
            "shape": "A",
        },
    }
    problem.update(overrides)
    return problem


def _gate_error(tool: str, **overrides) -> MCPError:
    # Frozen CP frame (W1, 2026-09-15): code -32003, message APPROVAL_REQUIRED,
    # unwrapped problem extensions under JSON-RPC error.data.
    return MCPError(-32003, "APPROVAL_REQUIRED", data=_gate_problem(tool, **overrides))


async def _await_pending(
    approval_tool: ApprovalAgentTool, exclude: set[str] | None = None, attempts: int = 1000
) -> str:
    excluded = exclude or set()
    for _ in range(attempts):
        pending = [rid for rid in approval_tool.coordinator.pending_requests if rid not in excluded]
        if pending:
            return pending[0]
        await asyncio.sleep(0)
    raise AssertionError("CP gate approval waiter was never registered")


def _publishing_context(session_id: str = "session-gate") -> tuple[AgentContext, list[dict]]:
    context = AgentContext.empty(session_id)
    context.metadata.update({
        "sessionId": session_id,
        "workspaceId": "workspace-1",
        "runId": "run-1",
        "operationId": "operation-1",
        "operationItemId": "item-1",
    })
    published: list[dict] = []

    async def publish(payload):
        published.append(payload)

    context.metadata["_approval_event_sink"] = publish
    return context, published


class TestMCPAgentToolPostGateApproval:
    @pytest.fixture
    def context(self):
        context = AgentContext.empty("session-gate")
        context.metadata.update({
            "sessionId": "session-gate",
            "workspaceId": "workspace-1",
            "runId": "run-1",
            "operationId": "operation-1",
            "operationItemId": "item-1",
        })
        return context

    @pytest.fixture
    def log_sink(self):
        messages = []
        sink_id = logger.add(messages.append, level="DEBUG")
        yield messages
        logger.remove(sink_id)

    @pytest.mark.asyncio
    @pytest.mark.parametrize("tool_name", ["read_file", "apply_patch"])
    async def test_gate_409_approve_retries_once_with_grant_header(self, context, tool_name):
        """PLAN-0337 M2：写类工具首调用也不带 grant；闸门批准后仅重试一次并携 CP grant。"""
        approval_tool = ApprovalAgentTool(timeout_seconds=5)
        calls: list[dict[str, str]] = []
        arguments = (
            {"path": "notes/a.md"}
            if tool_name == "read_file"
            else {
                "patches": [
                    {
                        "path": "new.md",
                        "expectedHash": "",
                        "hunks": [{"before": "", "after": "new"}],
                    }
                ]
            }
        )

        async def _call(name, arguments, headers):
            calls.append(headers)
            if len(calls) == 1:
                raise _gate_error(tool_name)
            return _tool_result("gate-ok")

        manager = _fake_manager(approval_tool=approval_tool)
        manager.call_tool = AsyncMock(side_effect=_call)
        tool = MCPAgentTool(_stub_tool(tool_name), manager)

        task = asyncio.create_task(tool.execute(arguments, context))
        request_id = await _await_pending(approval_tool)
        assert request_id == "apr-00000001"
        assert approval_tool.resolve_approval_status(request_id, True) == ("accepted", True)

        result = await asyncio.wait_for(task, timeout=5)

        assert "gate-ok" in result["content"]
        assert len(calls) == 2
        assert APPROVAL_GRANT_HEADER not in calls[0], (
            "首个 dispatch 必须无 grant 头：审批权在 CP 闸门，Agent 不得先自行取得本地 grant"
        )
        assert calls[1][APPROVAL_GRANT_HEADER] == request_id
        # The retry must be the identical MCP call (same JSON-RPC bound payload).
        assert manager.call_tool.await_args_list[0].args[1] == manager.call_tool.await_args_list[1].args[1]
        assert approval_tool.get_pending() == []

    @pytest.mark.asyncio
    async def test_gate_409_rejection_is_terminal_with_feedback_and_no_retry(self, context):
        approval_tool = ApprovalAgentTool(timeout_seconds=5)
        manager = _fake_manager(approval_tool=approval_tool, side_effect=[_gate_error("read_file")])
        tool = MCPAgentTool(_stub_tool("read_file"), manager)

        task = asyncio.create_task(tool.execute({"path": "notes/a.md"}, context))
        request_id = await _await_pending(approval_tool)
        assert approval_tool.resolve_approval_status(request_id, False, "policy says no") == (
            "accepted",
            False,
        )

        with pytest.raises(ApprovalRejectedError, match="policy says no"):
            await asyncio.wait_for(task, timeout=5)

        assert manager.call_tool.await_count == 1
        assert approval_tool.get_pending() == []
        assert approval_tool.get_approval_status(request_id)["status"] == "rejected"

    @pytest.mark.asyncio
    async def test_gate_409_expiry_is_terminal_and_queryable(self, context):
        approval_tool = ApprovalAgentTool(timeout_seconds=5)

        async def _call(name, arguments, headers):
            raise _gate_error("read_file", expiresAt=_future_iso(0.15))

        manager = _fake_manager(approval_tool=approval_tool)
        manager.call_tool = AsyncMock(side_effect=_call)
        tool = MCPAgentTool(_stub_tool("read_file"), manager)

        with pytest.raises(ApprovalExpiredError):
            await asyncio.wait_for(tool.execute({}, context), timeout=5)

        assert manager.call_tool.await_count == 1
        assert approval_tool.get_pending() == []
        status = approval_tool.get_approval_status("apr-00000001")
        assert status is not None
        assert status["status"] == "expired"
        # A late decision cannot revive an expired CP gate request.
        assert approval_tool.resolve_approval_status("apr-00000001", True) == ("expired", None)

    @pytest.mark.asyncio
    async def test_second_gate_409_fails_closed_without_third_call(self, context):
        approval_tool = ApprovalAgentTool(timeout_seconds=5)
        manager = _fake_manager(
            approval_tool=approval_tool,
            side_effect=[_gate_error("read_file"), _gate_error("read_file")],
        )
        tool = MCPAgentTool(_stub_tool("read_file"), manager)

        task = asyncio.create_task(tool.execute({}, context))
        request_id = await _await_pending(approval_tool)
        assert approval_tool.resolve_approval_status(request_id, True) == ("accepted", True)

        with pytest.raises(ApprovalRetryFailedError):
            await asyncio.wait_for(task, timeout=5)

        assert manager.call_tool.await_count == 2
        assert approval_tool.get_pending() == []

    @pytest.mark.asyncio
    async def test_retry_side_generic_mcp_error_fails_closed(self, context):
        """403/grant-mismatch surface as non-approval MCP errors; the retry must not loop."""
        approval_tool = ApprovalAgentTool(timeout_seconds=5)
        manager = _fake_manager(
            approval_tool=approval_tool,
            side_effect=[
                _gate_error("read_file"),
                MCPError(-32603, "Server returned an error response", data=None),
            ],
        )
        tool = MCPAgentTool(_stub_tool("read_file"), manager)

        task = asyncio.create_task(tool.execute({}, context))
        request_id = await _await_pending(approval_tool)
        assert approval_tool.resolve_approval_status(request_id, True) == ("accepted", True)

        with pytest.raises(ApprovalRetryFailedError):
            await asyncio.wait_for(task, timeout=5)

        assert manager.call_tool.await_count == 2

    @pytest.mark.asyncio
    async def test_gate_retry_path_publishes_no_local_approval_event(self):
        """PLAN-0337 M2：闸门路径下 Agent 不发布任何本地审批事件（sink 保持空）。"""
        approval_tool = ApprovalAgentTool(timeout_seconds=5)
        context, published = _publishing_context("session-gate-only")
        calls: list[dict[str, str]] = []

        async def _call(name, arguments, headers):
            calls.append(headers)
            if len(calls) == 1:
                raise _gate_error("write_file")
            return _tool_result("write-ok")

        manager = _fake_manager(approval_tool=approval_tool)
        manager.call_tool = AsyncMock(side_effect=_call)
        tool = MCPAgentTool(_stub_tool("write_file"), manager)

        task = asyncio.create_task(tool.execute({"path": "a.md", "content": "x"}, context))
        cp_request_id = await _await_pending(approval_tool)
        assert approval_tool.resolve_approval_status(cp_request_id, True) == ("accepted", True)

        result = await asyncio.wait_for(task, timeout=5)

        assert "write-ok" in result["content"]
        assert len(calls) == 2
        assert APPROVAL_GRANT_HEADER not in calls[0]
        assert calls[1][APPROVAL_GRANT_HEADER] == cp_request_id
        assert published == [], "审批由 CP 闸门唯一触发，Agent 不得发布本地审批事件"

    @pytest.mark.asyncio
    @pytest.mark.parametrize(
        "overrides",
        [
            {"approvalRequestId": None},
            {"approvalRequestId": "bad id!"},
            {"approvalRequestId": "x" * 200},
            {"expiresAt": None},
            {"expiresAt": "not-a-timestamp"},
            {"tool": "write_file"},
            {"retryHeader": "X-Other-Header"},
            {"status": 403},
        ],
    )
    async def test_gate_409_malformed_signal_fails_closed_without_state(self, context, overrides):
        approval_tool = ApprovalAgentTool(timeout_seconds=5)
        manager = _fake_manager(approval_tool=approval_tool)
        problem_overrides = dict(overrides)
        signal_tool = problem_overrides.pop("tool", "read_file")
        manager.call_tool = AsyncMock(side_effect=_gate_error(signal_tool, **problem_overrides))
        tool = MCPAgentTool(_stub_tool("read_file"), manager)

        with pytest.raises(ApprovalProtocolError):
            await asyncio.wait_for(tool.execute({}, context), timeout=5)

        assert manager.call_tool.await_count == 1
        assert approval_tool.coordinator.pending_requests == {}
        assert approval_tool.coordinator.pending_payloads == {}

    @pytest.mark.asyncio
    async def test_gate_409_without_structured_payload_fails_closed(self, context):
        approval_tool = ApprovalAgentTool(timeout_seconds=5)
        manager = _fake_manager(approval_tool=approval_tool)
        manager.call_tool = AsyncMock(
            side_effect=MCPError(-32003, "APPROVAL_REQUIRED", data=None)
        )
        tool = MCPAgentTool(_stub_tool("read_file"), manager)

        with pytest.raises(ApprovalProtocolError):
            await asyncio.wait_for(tool.execute({}, context), timeout=5)

        assert manager.call_tool.await_count == 1
        assert approval_tool.coordinator.pending_requests == {}

    @pytest.mark.asyncio
    async def test_unknown_mcp_error_keeps_legacy_tool_error(self, context):
        """W1 note: when CP keeps the legacy problem+json 409 (no durable row), the SDK
        synthesizes a generic -32603 with no data; the Agent must not wait or retry."""
        approval_tool = ApprovalAgentTool(timeout_seconds=5)
        manager = _fake_manager(approval_tool=approval_tool)
        manager.call_tool = AsyncMock(
            side_effect=MCPError(-32603, "Server returned an error response", data=None)
        )
        tool = MCPAgentTool(_stub_tool("read_file"), manager)

        result = await asyncio.wait_for(tool.execute({}, context), timeout=5)

        assert result["content"].startswith("Tool error:")
        assert manager.call_tool.await_count == 1
        assert approval_tool.coordinator.pending_requests == {}

    @pytest.mark.asyncio
    async def test_gate_wait_cancellation_cleans_pending(self, context):
        approval_tool = ApprovalAgentTool(timeout_seconds=5)
        manager = _fake_manager(approval_tool=approval_tool)
        manager.call_tool = AsyncMock(side_effect=_gate_error("read_file"))
        tool = MCPAgentTool(_stub_tool("read_file"), manager)

        task = asyncio.create_task(tool.execute({}, context))
        request_id = await _await_pending(approval_tool)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

        assert approval_tool.coordinator.pending_requests == {}
        assert approval_tool.coordinator.pending_payloads == {}
        assert approval_tool.resolve_approval_status(request_id, True) == ("not_found", None)

    @pytest.mark.asyncio
    async def test_gate_paths_never_log_raw_arguments_or_bodies(self, context, log_sink):
        secret = "TOP-SECRET-MARKER"
        approval_tool = ApprovalAgentTool(timeout_seconds=5)
        calls: list[dict[str, str]] = []

        async def _call(name, arguments, headers):
            calls.append(headers)
            if len(calls) == 1:
                raise _gate_error("read_file", rawArguments={"content": secret})
            return _tool_result("gate-ok")

        manager = _fake_manager(approval_tool=approval_tool)
        manager.call_tool = AsyncMock(side_effect=_call)
        tool = MCPAgentTool(_stub_tool("read_file"), manager)

        task = asyncio.create_task(
            tool.execute({"path": "a.md", "content": secret}, context)
        )
        request_id = await _await_pending(approval_tool)
        assert approval_tool.resolve_approval_status(request_id, True) == ("accepted", True)
        await asyncio.wait_for(task, timeout=5)

        text = "\n".join(log_sink)
        assert secret not in text
        # Positive control: the safe identifier is logged for cross-hop tracing.
        assert "approvalRequestId=apr-00000001" in text

    @pytest.mark.asyncio
    async def test_malformed_signal_error_message_never_echoes_payload(self, context, log_sink):
        secret = "TOP-SECRET-MARKER"
        approval_tool = ApprovalAgentTool(timeout_seconds=5)
        manager = _fake_manager(approval_tool=approval_tool)
        manager.call_tool = AsyncMock(
            side_effect=_gate_error("read_file", approvalRequestId=None, rawArguments={"content": secret})
        )
        tool = MCPAgentTool(_stub_tool("read_file"), manager)

        with pytest.raises(ApprovalProtocolError) as error:
            await asyncio.wait_for(tool.execute({}, context), timeout=5)

        assert secret not in str(error.value)
        assert secret not in "\n".join(log_sink)


class TestApprovalGateClassifier:
    def test_returns_none_for_unrelated_failures(self):
        assert classify_approval_gate_failure(RuntimeError("boom"), "read_file") is None
        assert classify_approval_gate_failure(TimeoutError("slow"), "read_file") is None
        other_code = MCPError(
            -32002, "FORBIDDEN", data={"status": 403, "code": "FORBIDDEN"}
        )
        assert classify_approval_gate_failure(other_code, "read_file") is None
        generic = MCPError(-32603, "Server returned an error response", data=None)
        assert classify_approval_gate_failure(generic, "read_file") is None

    def test_parses_nested_and_string_payloads(self):
        problem = _gate_problem("read_file")
        wrapped = MCPError(-32001, "APPROVAL_REQUIRED", data={"error": {"data": problem}})
        signal = classify_approval_gate_failure(wrapped, "read_file")
        assert signal is not None
        assert signal.request_id == "apr-00000001"
        assert signal.tool == "read_file"
        assert signal.expires_at.tzinfo is not None

        as_string = MCPError(-32001, "APPROVAL_REQUIRED", data=json.dumps(problem))
        assert classify_approval_gate_failure(as_string, "read_file").request_id == "apr-00000001"

    def test_missing_request_id_fails_closed(self):
        exc = _gate_error("read_file", approvalRequestId="")
        with pytest.raises(ApprovalProtocolError, match="approvalRequestId"):
            classify_approval_gate_failure(exc, "read_file")
