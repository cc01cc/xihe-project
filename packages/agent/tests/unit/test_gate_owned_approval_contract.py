"""PLAN-0337 M2 —— CP 闸门唯一审批权威的 Agent 侧契约（修复后形态，当前代码 RED）。

契约（本文件编码「修复后」应恒真的三条）：

1. **dispatch 路径不再调用本地审批工具**：Agent 对任何写类工具都不得自行弹审批，
   首个 MCP 调用必须直接到达 CP 闸门（不带任何本地 grant 头）；
2. **Agent 不持有本地硬编码审批清单**：审批与否由 CP 的策略/闸门决定，Agent 不再
   维护 `REQUIRE_APPROVAL_TOOLS` 这类本地 allowlist；
3. **gate 信号路径仍完整**：CP 闸门以 `-32003 / APPROVAL_REQUIRED` 回信号时，
   Agent 仍注册 waiter 等服务端决定，批准后**只重试一次**且携带
   `X-Xihe-Approval-Request-Id`，重试体与首次调用逐字节相同。

当前（未修复）代码下，写类工具在 `MCPAgentTool.execute` 里先做本地前置审批，
上述 1/2/3 的对应断言都会失败 —— 它们是本 PLAN 缺陷的 RED 锚点，不要为了让它们变绿
而放宽断言；修复方向见 PLAN-0337 M2 与 `packages/agent/tests/unit/test_tool_registry_contract.py`。
"""

from __future__ import annotations

import asyncio
import contextlib
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest
from mcp.shared.exceptions import MCPError
from mcp.types import TextContent

from xihe_agent.adapters import mcp_client as mcp_client_module
from xihe_agent.adapters.approval_tool import ApprovalAgentTool
from xihe_agent.adapters.mcp_client import (
    APPROVAL_GRANT_HEADER,
    MCPAgentTool,
)
from xihe_agent.interfaces.context import AgentContext

# 与 GatewayToolRegistryContractTest#gatewayMutationTools_requireApproval 冻结的
# 11 个 Gateway 公开 mutation 工具一致（PLAN-292 T4）。修复后这些工具仍必须经 CP 闸门审批，
# 只是审批决策不再由 Agent 本地前置产生。
_MUTATION_TOOLS = (
    "write_file",
    "edit_file",
    "delete_file",
    "delete_directory",
    "move_file",
    "copy_file",
    "mkdir",
    "execute_command",
    "start_background_process",
    "cancel_background_process",
    "apply_patch",
)
_READ_ONLY_TOOL = "read_file"


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
            "shape": "structured",
        },
    }
    problem.update(overrides)
    return problem


def _gate_error(tool: str, **overrides) -> MCPError:
    return MCPError(-32003, "APPROVAL_REQUIRED", data=_gate_problem(tool, **overrides))


def _publishing_context(session_id: str = "session-gate") -> tuple[AgentContext, list[dict]]:
    context = AgentContext.empty(session_id)
    context.metadata.update(
        {
            "sessionId": session_id,
            "workspaceId": "workspace-1",
            "runId": "run-1",
            "operationId": "operation-1",
            "operationItemId": "item-1",
        }
    )
    published: list[dict] = []

    async def publish(payload):
        published.append(payload)

    context.metadata["_approval_event_sink"] = publish
    return context, published


async def _drain(task: asyncio.Task, approval_tool: ApprovalAgentTool | None, resolved: list[str]):
    """把任务推进到终态：出现待决审批（本地或 CP）就批准，直到任务完成。"""
    for _ in range(5000):
        if task.done():
            return
        if approval_tool is not None:
            pending = [rid for rid in approval_tool.coordinator.pending_requests if rid not in resolved]
            if pending:
                rid = pending[0]
                resolved.append(rid)
                assert approval_tool.resolve_approval_status(rid, True) == ("accepted", True)
                continue
        await asyncio.sleep(0)
    raise AssertionError("tool.execute 未能在轮询预算内推进")


@pytest.mark.asyncio
async def test_dispatch_never_runs_a_local_pre_approval_for_mutation_tools():
    """契约 1：写类工具首个 MCP 调用直达 CP 闸门，不出现任何本地前置审批。"""
    offenders: list[str] = []
    for tool_name in _MUTATION_TOOLS:
        context, published = _publishing_context()
        approval_tool = ApprovalAgentTool(timeout_seconds=5)
        manager = _fake_manager(approval_tool=approval_tool, result=_tool_result("ok"))
        tool = MCPAgentTool(_stub_tool(tool_name), manager)

        task = asyncio.create_task(tool.execute({"path": "notes/a.md"}, context))
        for _ in range(500):
            if published or manager.call_tool.await_count:
                break
            await asyncio.sleep(0)

        try:
            if published or manager.call_tool.await_count == 0:
                offenders.append(
                    f"{tool_name}: 首调用前出现本地前置审批 "
                    f"(published={len(published)}, calls={manager.call_tool.await_count})"
                )
                continue
            headers = manager.call_tool.await_args_list[0].args[2]
            if APPROVAL_GRANT_HEADER in headers:
                offenders.append(f"{tool_name}: 首个 MCP 调用携带本地 grant 头")
        finally:
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task

        assert approval_tool.coordinator.pending_requests == {}, f"{tool_name}: 取消后不得残留本地审批等待者"

    assert offenders == [], (
        "dispatch 路径必须由 CP 闸门唯一裁决：写类工具不得在 Agent 侧先弹审批。\n  - " + "\n  - ".join(offenders)
    )


@pytest.mark.asyncio
async def test_agent_dispatch_layer_holds_no_local_approval_allowlist():
    """契约 2：Agent 不再持有本地硬编码审批清单（审批权收敛到 CP）。"""
    local_allowlist = getattr(mcp_client_module, "REQUIRE_APPROVAL_TOOLS", frozenset())
    assert not local_allowlist, (
        f"Agent dispatch 层不得再持有本地审批清单（修复后应删除该符号或保持为空）；当前仍为: {sorted(local_allowlist)}"
    )


@pytest.mark.asyncio
async def test_gate_signal_path_waits_and_retries_exactly_once_with_grant():
    """契约 3：gate 信号驱动的「等待 + 只重试一次 + 携 grant」路径完整。"""
    approval_tool = ApprovalAgentTool(timeout_seconds=5)
    calls: list[dict[str, str]] = []

    async def _call(name, arguments, headers):
        calls.append(dict(headers))
        if len(calls) == 1:
            raise _gate_error("write_file")
        return _tool_result("gate-ok")

    manager = _fake_manager(approval_tool=approval_tool)
    manager.call_tool = AsyncMock(side_effect=_call)
    context, _published = _publishing_context()
    arguments = {"path": "notes/a.md", "content": "gate-owned"}
    tool = MCPAgentTool(_stub_tool("write_file"), manager)

    task = asyncio.create_task(tool.execute(arguments, context))
    resolved: list[str] = []
    await _drain(task, approval_tool, resolved)
    result = await asyncio.wait_for(task, timeout=5)

    assert "gate-ok" in result["content"]
    assert len(calls) == 2, "CP 闸门批准后只允许重试一次（不得成环）"
    assert APPROVAL_GRANT_HEADER not in calls[0], (
        "首个 dispatch 必须无 grant 头：审批权在 CP 闸门，Agent 不得先自行取得本地 grant"
    )
    assert calls[1][APPROVAL_GRANT_HEADER] == "apr-00000001", "重试必须携带 CP 闸门下发的 grant"
    assert manager.call_tool.await_args_list[0].args[1] == manager.call_tool.await_args_list[1].args[1], (
        "重试必须是同一次 MCP 调用（JSON-RPC 绑定体逐字节相同）"
    )
    assert approval_tool.get_pending() == []
