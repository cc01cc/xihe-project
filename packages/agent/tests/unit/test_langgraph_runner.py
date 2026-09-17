"""Tests for xihe_agent.agent_runner.langgraph_runner."""

import asyncio
from datetime import UTC
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

import xihe_agent.agent_runner.langgraph_runner as langgraph_runner_module
from xihe_agent.adapters.approval_tool import ApprovalAgentTool
from xihe_agent.adapters.sse_adapter import LangGraphEventAdapter
from xihe_agent.agent_runner import LangGraphRunner
from xihe_agent.interfaces.agent_runner import AgentEvent, RunnerConfig
from xihe_agent.interfaces.context import AgentContext, ContextEpoch
from xihe_agent.interfaces.event_adapter import EventAdapter
from xihe_agent.interfaces.message import TextMessage
from xihe_agent.interfaces.tool import ToolSpec
from xihe_agent.llm.base import MockChatModel, create_llm


class FakeTool:
    """Minimal BaseAgentTool implementation for unit tests."""

    def __init__(self, name: str = "fake_tool"):
        self._spec = ToolSpec(
            name=name,
            description="A fake tool",
            input_schema={
                "type": "object",
                "properties": {"query": {"type": "string"}},
                "required": ["query"],
            },
        )

    @property
    def spec(self) -> ToolSpec:
        return self._spec

    async def execute(self, input: dict, context: dict) -> dict:
        return {"content": f"result for {input.get('query', '')}"}


@pytest.mark.asyncio
async def test_langgraph_runner_stream_yields_agent_events():
    runner = LangGraphRunner(model_factory=lambda _model: create_llm())
    config = RunnerConfig(
        model="mock",
        system_prompt="test",
        tools=[FakeTool()],
    )
    messages = [TextMessage(role="human", content="Hello")]

    events = []
    async for event in runner.stream(messages, config):
        events.append(event)

    assert len(events) > 0
    assert all(isinstance(e, AgentEvent) for e in events)
    token_events = [e for e in events if e.type == "token"]
    assert len(token_events) > 0


@pytest.mark.asyncio
async def test_langgraph_runner_uses_custom_event_adapter():
    class CustomAdapter(EventAdapter):
        def translate(self, raw_event: dict):
            if raw_event.get("event") == "on_chat_model_stream":
                return AgentEvent(type="token", data={"content": "custom"})
            return None

    runner = LangGraphRunner(
        model_factory=lambda _model: create_llm(),
        event_adapter=CustomAdapter(),
    )
    config = RunnerConfig(model="mock", system_prompt="test", tools=[])
    messages = [TextMessage(role="human", content="Hello")]

    events = []
    async for event in runner.stream(messages, config):
        events.append(event)

    assert all(
        e.type == "token" and e.data.get("content") == "custom"
        for e in events
        if e.type != "usage"
    )
    assert any(e.type == "usage" for e in events)


@pytest.mark.asyncio
async def test_langgraph_runner_default_adapter_is_langgraph_adapter():
    runner = LangGraphRunner(model_factory=lambda _model: create_llm())
    assert isinstance(runner._event_adapter, LangGraphEventAdapter)


@pytest.mark.asyncio
async def test_prompt_event_uses_timezone_aware_utc_timestamp():
    event_store = MagicMock()
    event_store.append = AsyncMock()
    runner = LangGraphRunner(
        model_factory=lambda _model: create_llm(),
        event_store=event_store,
    )

    await runner._append_prompt_admitted(
        [TextMessage(role="human", content="Hello")],
        AgentContext.empty("session-1"),
    )

    event = event_store.append.await_args.args[0]
    assert event.created_at.tzinfo is UTC
    assert event.created_at.utcoffset().total_seconds() == 0


@pytest.mark.asyncio
async def test_runner_fans_in_approval_event_before_blocked_tool_completes(monkeypatch):
    approval_tool = ApprovalAgentTool(timeout_seconds=1)

    class FakeAgent:
        def __init__(self, tools):
            self.tools = tools

        def astream_events(self, _inputs, version):
            assert version == "v2"
            adapted_tool = self.tools[0]

            async def events():
                yield {
                    "event": "on_tool_start",
                    "name": "request_approval",
                    "data": {"input": {"action": "delete file"}},
                    "run_id": "tool-run",
                }
                request_task = asyncio.create_task(adapted_tool._arun(action="delete file"))
                while not approval_tool.pending_payloads:
                    await asyncio.sleep(0)
                result = await request_task
                yield {
                    "event": "on_tool_end",
                    "name": "request_approval",
                    "data": {"output": result},
                    "run_id": "tool-run",
                }
                yield {"event": "on_chain_end", "name": "LangGraph", "data": {}, "run_id": "graph-run"}

            return events()

    monkeypatch.setattr(
        langgraph_runner_module,
        "create_react_agent",
        lambda _model, tools: FakeAgent(tools),
    )
    runner = LangGraphRunner(model_factory=lambda _model: object())
    context = AgentContext.empty("session-1")
    context.metadata.update({"runId": "run-1", "sessionId": "session-1", "workspaceId": "workspace-1"})

    received = []
    async for event in runner.stream(
        [TextMessage(role="human", content="delete the file")],
        RunnerConfig(model="fake", system_prompt="", tools=[approval_tool], context=context),
    ):
        received.append(event)
        if event.type == "approval_request":
            approval_tool.resolve_approval(event.data["requestId"], True)

    types = [event.type for event in received]
    # PLAN-0326 决策 #8：审批原语的 tool_call/tool_result 事件被抑制（其正规记录 =
    # 审批项），只保留 approval_request 事件本身；"先于工具放行"的语义由
    # approval_request 出现即代表阻塞成立来保证。
    assert "approval_request" in types
    assert "tool_result" not in types
    assert received[types.index("approval_request")].data["runId"] == "run-1"


def test_system_messages_inject_baseline_and_append_epoch_summary():
    """PLAN-0307 T2.19 (decision #28): baseline is never compressed; summary appends."""
    runner = LangGraphRunner(model_factory=lambda _model: create_llm())
    config = RunnerConfig(model="mock", system_prompt="BASELINE-INSTRUCTIONS", tools=[])
    context = AgentContext(
        aggregate_id="session-1",
        epoch=ContextEpoch(
            epoch_id="epoch-1",
            baseline_hash="hash-1",
            system_messages=["Conversation summary of compacted history:", "SUMMARY"],
        ),
    )

    messages = runner._build_system_messages(config, context)

    assert [m.content for m in messages] == [
        "BASELINE-INSTRUCTIONS",
        # PLAN-0340: L1b env always present (semi-trusted facts).
        next(m.content for m in messages if "Workspace environment" in m.content),
        "Conversation summary of compacted history:",
        "SUMMARY",
    ]


def test_system_messages_without_epoch_only_baseline():
    runner = LangGraphRunner(model_factory=lambda _model: create_llm())
    config = RunnerConfig(model="mock", system_prompt="BASELINE", tools=[])

    messages = runner._build_system_messages(config, AgentContext.empty("s"))

    assert messages[0].content == "BASELINE"
    assert any("Workspace environment" in m.content for m in messages)


def test_system_messages_warn_when_baseline_missing_with_summary():
    runner = LangGraphRunner(model_factory=lambda _model: create_llm())
    config = RunnerConfig(model="mock", system_prompt="", tools=[])
    context = AgentContext.empty("s").set_epoch(
        ContextEpoch(epoch_id="e", baseline_hash="h", system_messages=["SUMMARY"])
    )

    with patch.object(langgraph_runner_module.logger, "warning") as warn:
        messages = runner._build_system_messages(config, context)

    contents = [m.content for m in messages]
    assert "SUMMARY" in contents
    assert any("Workspace environment" in c for c in contents)
    assert warn.called


# ── PLAN-0308 M1 收尾：MCP 工具参数类型映射（冒烟抓出的缺陷） ──────────────────


def test_args_schema_maps_json_types_and_validates_numeric_args():
    """非字符串参数（integer/array/union）不得被校验层拒绝。

    缺陷复现（修复前）：所有字段一律 `str`，pydantic v2 不再隐式把数字转字符串，
    `execute_command {command, timeout: 90}` 校验失败 → LangGraph 吞成 ToolMessage，
    工具从未执行而 run 仍报 success。
    """
    spec = ToolSpec(
        name="execute_command",
        description="Execute a shell command",
        input_schema={
            "type": "object",
            "properties": {
                "command": {"type": "string"},
                "args": {"type": "array", "items": {"type": "string"}, "default": []},
                "timeout": {"type": ["integer", "null"], "minimum": 0},
                "truncate_limit": {"anyOf": [{"type": "integer"}, {"type": "null"}]},
                "flag": {"type": "boolean"},
            },
            "required": ["command"],
        },
    )

    schema = langgraph_runner_module._build_args_schema(spec)
    model = schema(command="sleep 45", timeout=90, args=["x"], flag=True)

    assert model.command == "sleep 45"
    assert model.timeout == 90
    assert model.args == ["x"]
    assert model.flag is True
    assert model.truncate_limit is None


def test_args_schema_keeps_string_fields_strict_for_numbers():
    """字符串字段仍不接受数字（保持原有的失败可见性，不回归成静默强转）。"""
    spec = ToolSpec(
        name="write_file",
        description="write",
        input_schema={
            "type": "object",
            "properties": {"path": {"type": "string"}},
            "required": ["path"],
        },
    )

    with pytest.raises(Exception):
        langgraph_runner_module._build_args_schema(spec)(path=123)


def test_args_schema_accepts_numeric_strings_for_integer_fields():
    """宽松模式：LLM 常把数字发成字符串，integer 字段应接受 "90"。"""
    spec = ToolSpec(
        name="read_file_range",
        description="read",
        input_schema={
            "type": "object",
            "properties": {"offset": {"type": "integer"}},
            "required": ["offset"],
        },
    )

    assert langgraph_runner_module._build_args_schema(spec)(offset="90").offset == 90
