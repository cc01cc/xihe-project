"""Tests for xihe_agent.agent_runner.langgraph_runner."""

import asyncio
from datetime import UTC
from unittest.mock import AsyncMock, MagicMock

import pytest

import xihe_agent.agent_runner.langgraph_runner as langgraph_runner_module
from xihe_agent.adapters.approval_tool import ApprovalAgentTool
from xihe_agent.adapters.sse_adapter import LangGraphEventAdapter
from xihe_agent.agent_runner import LangGraphRunner
from xihe_agent.interfaces.agent_runner import AgentEvent, RunnerConfig
from xihe_agent.interfaces.context import AgentContext
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
    assert types.index("approval_request") < types.index("tool_result")
    assert received[types.index("approval_request")].data["runId"] == "run-1"
