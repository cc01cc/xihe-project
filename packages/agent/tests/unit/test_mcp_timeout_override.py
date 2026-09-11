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
