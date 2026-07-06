"""Tests for xihe_agent.agent_runner.langgraph_runner."""

import pytest

from xihe_agent.adapters.sse_adapter import LangGraphEventAdapter
from xihe_agent.agent_runner import LangGraphRunner
from xihe_agent.interfaces.agent_runner import AgentEvent, RunnerConfig
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

    assert all(e.type == "token" and e.data.get("content") == "custom" for e in events)


@pytest.mark.asyncio
async def test_langgraph_runner_default_adapter_is_langgraph_adapter():
    runner = LangGraphRunner(model_factory=lambda _model: create_llm())
    assert isinstance(runner._event_adapter, LangGraphEventAdapter)
