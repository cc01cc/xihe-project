"""PLAN-301 M2: per-call toolTimeoutOverrides wiring (decision #2).

MCPAgentTool.execute consults `context.runtime_state["toolTimeoutOverrides"]`
(tool name -> seconds) before falling back to the configured default. A
caller-specified timeout is a stronger intent than any configured default;
invalid values degrade to the default with a warning.
"""

import asyncio
from typing import Any

import pytest

from xihe_agent.adapters.mcp_client import MCPAgentTool
from xihe_agent.interfaces.context import AgentContext


class FakeTool:
    """Minimal BaseTool stand-in that records the awaiting time."""

    def __init__(self, name: str, sleep_s: float = 0.0):
        self.name = name
        self._sleep_s = sleep_s

    async def ainvoke(self, payload: dict) -> str:
        if self._sleep_s > 0:
            await asyncio.sleep(self._sleep_s)
        return "ok"


def _make_tool(name: str = "list_directory", sleep_s: float = 0.0) -> MCPAgentTool:
    return MCPAgentTool(FakeTool(name, sleep_s), call_timeout_s=30)


def _context(overrides: dict | None) -> AgentContext:
    ctx = AgentContext.empty(aggregate_id="test-session")
    if overrides is not None:
        ctx.runtime_state["toolTimeoutOverrides"] = overrides
    return ctx


@pytest.mark.asyncio
async def test_override_takes_precedence_over_default():
    tool = _make_tool()
    ctx = _context({"list_directory": 90})
    # A 90s bound must not raise TimeoutError for an instant call.
    assert await tool.execute({}, ctx) == {"content": "ok"}


@pytest.mark.asyncio
async def test_override_can_shorten_bound():
    # execute() converts a timeout into a structured tool-error result (the
    # model sees it as a tool result, not a crash) — assert on that contract.
    tool = _make_tool(sleep_s=5)
    ctx = _context({"list_directory": 0.1})
    result = await tool.execute({}, ctx)
    assert "timed out" in result["content"]


@pytest.mark.asyncio
async def test_invalid_override_value_falls_back_to_default():
    tool = _make_tool()
    ctx = _context({"list_directory": "not-a-number"})
    assert await tool.execute({}, ctx) == {"content": "ok"}


@pytest.mark.asyncio
async def test_non_positive_override_falls_back_to_default():
    tool = _make_tool()
    ctx = _context({"list_directory": 0})
    assert await tool.execute({}, ctx) == {"content": "ok"}


@pytest.mark.asyncio
async def test_no_overrides_uses_default():
    tool = _make_tool()
    assert await tool.execute({}, _context(None)) == {"content": "ok"}


@pytest.mark.asyncio
async def test_override_only_applies_to_named_tool():
    tool = _make_tool(name="grep")
    ctx = _context({"list_directory": 0.1})  # bound for another tool
    assert await tool.execute({}, ctx) == {"content": "ok"}


@pytest.mark.asyncio
async def test_cold_start_grace_triples_first_call():
    """PLAN-301 M3: first tool call after materialization gets 3x the bound."""
    from xihe_agent.adapters.mcp_client import DEFAULT_MCP_TOOL_TIMEOUT_S

    tool = _make_tool(sleep_s=DEFAULT_MCP_TOOL_TIMEOUT_S + 0.5)  # >30s, <90s
    ctx = _context(None)
    ctx.runtime_state["firstToolCallDone"] = False
    # Without grace this times out at 30s; with 3x grace (90s) it completes.
    result = await tool.execute({}, ctx)
    assert result == {"content": "ok"}


@pytest.mark.asyncio
async def test_grace_is_one_shot():
    from xihe_agent.adapters.mcp_client import DEFAULT_MCP_TOOL_TIMEOUT_S

    tool = _make_tool(sleep_s=DEFAULT_MCP_TOOL_TIMEOUT_S + 0.5)
    ctx = _context(None)
    ctx.runtime_state["firstToolCallDone"] = False
    # First call uses the grace window and flips the marker...
    assert await tool.execute({}, ctx) == {"content": "ok"}
    assert ctx.runtime_state["firstToolCallDone"] is True
    # ...second call exceeding the steady-state bound now times out.
    result = await tool.execute({}, ctx)
    assert "timed out" in result["content"]


@pytest.mark.asyncio
async def test_explicit_override_skips_grace_multiplier():
    from xihe_agent.adapters.mcp_client import DEFAULT_MCP_TOOL_TIMEOUT_S

    tool = _make_tool(sleep_s=DEFAULT_MCP_TOOL_TIMEOUT_S + 0.5)
    ctx = _context(None)
    ctx.runtime_state["firstToolCallDone"] = False
    # Explicit per-call override: stronger intent, no grace multiplier.
    ctx.runtime_state["toolTimeoutOverrides"] = {"list_directory": 1.0}
    result = await tool.execute({}, ctx)
    assert "timed out" in result["content"]
