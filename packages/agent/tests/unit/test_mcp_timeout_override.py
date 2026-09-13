"""PLAN-0308 M1（spec S1/S2）：Agent 侧"三条判断"的取值语义。

MCPAgentTool.execute 不做任何计算——等待值由 CP 计算并随 run payload 下发
（`toolWaits` / `toolWaitOrigins`），本模块只判断：
per-call（压过本模块 ENV）→ 本模块 ENV → 下发值 → 代码默认。
冷启动增量由 CP 计入下发值，本模块不再有本地乘法（旧 ×3 宽限已废除）。
"""

import asyncio

import pytest
from loguru import logger

from xihe_agent import main
from xihe_agent.adapters.mcp_client import MCPAgentTool, _resolve_tool_wait
from xihe_agent.interfaces.context import AgentContext


@pytest.fixture
def log_sink():
    messages = []
    sink_id = logger.add(messages.append, level="INFO")
    yield messages
    logger.remove(sink_id)


class FakeTool:
    """Minimal BaseTool stand-in that records the awaiting time."""

    def __init__(self, name: str, sleep_s: float = 0.0, result: str = "ok"):
        self.name = name
        self._sleep_s = sleep_s
        self._result = result

    async def ainvoke(self, payload: dict) -> str:
        if self._sleep_s > 0:
            await asyncio.sleep(self._sleep_s)
        return self._result


def _make_tool(name: str = "list_directory", sleep_s: float = 0.0) -> MCPAgentTool:
    return MCPAgentTool(FakeTool(name, sleep_s), call_timeout_s=30)


def _context(
    waits: dict[str, float] | None = None,
    origins: dict[str, str] | None = None,
) -> AgentContext:
    ctx = AgentContext.empty(aggregate_id="test-session")
    if waits is not None:
        ctx.runtime_state["toolWaits"] = waits
    if origins is not None:
        ctx.runtime_state["toolWaitOrigins"] = origins
    return ctx


def test_delivered_config_value_used_without_env(monkeypatch):
    monkeypatch.delenv("XIHE_MCP_TOOL_TIMEOUT_S", raising=False)
    wait = _resolve_tool_wait("list_directory", _context({"list_directory": 94}))
    assert wait.seconds == 94
    assert wait.source == "cp"
    assert wait.value_origin == "config"
    assert wait.overridden_seconds is None


def test_env_beats_delivered_config(monkeypatch):
    monkeypatch.setenv("XIHE_MCP_TOOL_TIMEOUT_S", "60")
    wait = _resolve_tool_wait("list_directory", _context({"list_directory": 94}))
    assert wait.seconds == 60
    assert wait.source == "env"
    assert wait.overridden_seconds == 94


def test_per_call_delivered_beats_env(monkeypatch):
    monkeypatch.setenv("XIHE_MCP_TOOL_TIMEOUT_S", "60")
    wait = _resolve_tool_wait(
        "list_directory",
        _context({"list_directory": 124}, {"list_directory": "per-call"}),
    )
    assert wait.seconds == 124
    assert wait.source == "cp"
    assert wait.value_origin == "per-call"
    assert wait.overridden_seconds == 60


def test_system_tool_wait_covers_unmapped_tools(monkeypatch):
    """系统工具统一值：无 per-tool 条目时作为下发 config 值（冷缓存仍可下发）。"""
    monkeypatch.delenv("XIHE_MCP_TOOL_TIMEOUT_S", raising=False)
    ctx = _context()
    ctx.runtime_state["systemToolWait"] = 94
    wait = _resolve_tool_wait("execute_command", ctx)
    assert wait.seconds == 94
    assert wait.source == "cp"
    assert wait.value_origin == "config"


def test_env_only_and_default_fallback(monkeypatch):
    monkeypatch.setenv("XIHE_MCP_TOOL_TIMEOUT_S", "45")
    env_wait = _resolve_tool_wait("list_directory", _context())
    assert (env_wait.seconds, env_wait.source) == (45, "env")

    monkeypatch.delenv("XIHE_MCP_TOOL_TIMEOUT_S", raising=False)
    fallback = _resolve_tool_wait("list_directory", _context())
    assert fallback.source == "default"
    assert fallback.seconds > 0


def test_invalid_delivered_value_is_ignored(monkeypatch):
    monkeypatch.delenv("XIHE_MCP_TOOL_TIMEOUT_S", raising=False)
    for bad in ("not-a-number", 0, -3, None, True):
        wait = _resolve_tool_wait("list_directory", _context({"list_directory": bad}))
        assert wait.source == "default", bad


def test_delivered_value_only_applies_to_named_tool(monkeypatch):
    monkeypatch.delenv("XIHE_MCP_TOOL_TIMEOUT_S", raising=False)
    wait = _resolve_tool_wait("grep", _context({"list_directory": 94}))
    assert wait.source == "default"


@pytest.mark.asyncio
async def test_delivered_value_bounds_call_without_multiplier(monkeypatch):
    """下发值即最终等待：首调不再本地乘 3（冷启动增量已由 CP 计入）。"""
    monkeypatch.delenv("XIHE_MCP_TOOL_TIMEOUT_S", raising=False)
    tool = _make_tool(sleep_s=0.9)
    ctx = _context({"list_directory": 0.2})
    result = await tool.execute({}, ctx)
    assert "timed out" in result["content"]
    # 若仍在乘 3，上面会在 0.6 秒内完成并成功返回；同时不再写 firstToolCallDone。
    assert ctx.runtime_state.get("firstToolCallDone") is None


@pytest.mark.asyncio
async def test_timeout_error_carries_signature(monkeypatch):
    monkeypatch.delenv("XIHE_MCP_TOOL_TIMEOUT_S", raising=False)
    tool = _make_tool(sleep_s=5)
    ctx = _context({"list_directory": 0.1}, {"list_directory": "per-call"})
    result = await tool.execute({}, ctx)
    content = result["content"]
    assert "timed out" in content
    assert "source=cp" in content
    assert "valueOrigin=per-call" in content
    assert "gateway may be" not in content
    assert "unreachable" not in content


@pytest.mark.asyncio
async def test_delivered_value_allows_long_call(monkeypatch):
    monkeypatch.delenv("XIHE_MCP_TOOL_TIMEOUT_S", raising=False)
    tool = _make_tool(sleep_s=0.3)
    ctx = _context({"list_directory": 90})
    assert await tool.execute({}, ctx) == {"content": "ok"}


@pytest.mark.asyncio
async def test_env_shortens_delivered_value(monkeypatch):
    monkeypatch.setenv("XIHE_MCP_TOOL_TIMEOUT_S", "0.1")
    tool = _make_tool(sleep_s=0.9)
    ctx = _context({"list_directory": 90})
    result = await tool.execute({}, ctx)
    assert "timed out" in result["content"]
    assert "source=env" in result["content"]


# ── T1.9：run payload 的 per-call 原始值解析（Agent 只消费） ──────────────────


def test_normalize_tool_timeouts_keeps_valid_entries():
    normalized = main._normalize_tool_timeouts({"execute_command": 120, "read_file": 90.0})
    assert normalized == {"execute_command": 120, "read_file": 90}
    assert isinstance(normalized["read_file"], int)


def test_normalize_tool_timeouts_ignores_invalid_entries():
    normalized = main._normalize_tool_timeouts(
        {"execute_command": 0, "write_file": "abc", "grep": True, "ls": None, "cat": 12.5}
    )
    assert normalized == {}


def test_normalize_tool_timeouts_tolerates_missing_payload():
    assert main._normalize_tool_timeouts(None) == {}
    assert main._normalize_tool_timeouts([120]) == {}


# ── T1.8：toolCallId 与 origin 贯通（spec S5.1） ─────────────────────────────


def test_signature_carries_tool_call_id_from_metadata(monkeypatch):
    monkeypatch.delenv("XIHE_MCP_TOOL_TIMEOUT_S", raising=False)
    ctx = _context({"list_directory": 94})
    ctx.metadata["operationItemId"] = "call-abc-123"

    wait = _resolve_tool_wait("list_directory", ctx)

    assert "toolCallId=call-abc-123" in wait.signature()
    assert "toolCallId=call-abc-123" in wait.timeout_signature()
    assert wait.timeout_signature().endswith("origin=self")


def test_signature_omits_missing_tool_call_id(monkeypatch):
    monkeypatch.delenv("XIHE_MCP_TOOL_TIMEOUT_S", raising=False)
    wait = _resolve_tool_wait("list_directory", _context({"list_directory": 94}))
    assert "toolCallId=" not in wait.signature()


@pytest.mark.asyncio
async def test_tool_logs_carry_tool_call_id_and_outcome(monkeypatch, log_sink):
    monkeypatch.delenv("XIHE_MCP_TOOL_TIMEOUT_S", raising=False)
    tool = _make_tool(sleep_s=0.0)
    ctx = _context({"list_directory": 94})
    ctx.metadata["operationItemId"] = "call-log-1"

    await tool.execute({}, ctx)

    text = "\n".join(log_sink)
    assert "event=mcp_tool_wait" in text
    assert "toolCallId=call-log-1" in text
    assert "event=mcp_tool_ok" in text
    assert "outcome=ok" in text


@pytest.mark.asyncio
async def test_downstream_error_result_is_labeled(monkeypatch, log_sink):
    """下游（CP/Runtime）返回的错误：本跳未到界，只转发下游结论（origin=downstream）。"""
    monkeypatch.delenv("XIHE_MCP_TOOL_TIMEOUT_S", raising=False)
    tool = MCPAgentTool(
        FakeTool("list_directory", result="Tool error: layer=runtime_exec origin=self"),
        call_timeout_s=30,
    )
    ctx = _context({"list_directory": 94})
    ctx.metadata["operationItemId"] = "call-ds-1"

    result = await tool.execute({}, ctx)

    assert result["content"].startswith("Tool error:")
    text = "\n".join(log_sink)
    assert "event=mcp_tool_ok" in text
    assert "outcome=error" in text
    assert "origin=downstream" in text
    assert "toolCallId=call-ds-1" in text
