import pytest
from langchain_core.messages import AIMessage, HumanMessage
from langchain_core.tools import BaseTool
from pydantic import BaseModel, Field

from xihe_agent.agent.executor import (
    DEFAULT_MAX_ITERATIONS,
    DEFAULT_RETRY_COUNT,
    stream_agent_events,
)
from xihe_agent.agent_runner import LangGraphRunner
from xihe_agent.interfaces.agent_runner import RunnerConfig
from xihe_agent.interfaces.message import Message, TextMessage
from xihe_agent.interfaces.tool import ToolSpec
from xihe_agent.llm.base import MockChatModel, create_llm


class FakeToolSchema(BaseModel):
    query: str = Field(description="Search query")


class FakeTool(BaseTool):
    name: str = "fake_search"
    description: str = "A fake search tool for testing"
    args_schema: type[BaseModel] = FakeToolSchema

    def _run(self, query: str) -> str:
        return f"Result for: {query}"

    async def _arun(self, query: str) -> str:
        return f"Result for: {query}"


class FakeAgentTool:
    """Simple BaseAgentTool-like object for the new AgentRunner path."""

    def __init__(self, tool: BaseTool):
        self._tool = tool
        from xihe_agent.interfaces.tool import ToolSpec
        self._spec = ToolSpec(
            name=tool.name,
            description=tool.description,
            input_schema={
                "type": "object",
                "properties": {"query": {"type": "string"}},
                "required": ["query"],
            },
        )

    @property
    def spec(self) -> "ToolSpec":
        return self._spec

    async def execute(self, input: dict, context: dict) -> dict:
        return {"content": self._tool._run(input.get("query", ""))}


def _make_runner() -> LangGraphRunner:
    return LangGraphRunner(model_factory=lambda _model: create_llm())


def test_default_max_iterations():
    assert DEFAULT_MAX_ITERATIONS == 4


def test_default_retry_count():
    assert DEFAULT_RETRY_COUNT == 3


@pytest.mark.asyncio
async def test_agent_creation_with_tools():
    runner = _make_runner()
    config = RunnerConfig(
        model="mock",
        system_prompt="test",
        tools=[FakeAgentTool(FakeTool())],
    )

    events = []
    async for event in stream_agent_events(
        runner=runner,
        config=config,
        input_text="Hello",
        retry_count=1,
    ):
        events.append(event)

    assert len(events) > 0


@pytest.mark.asyncio
async def test_agent_stream_produces_events():
    runner = _make_runner()
    config = RunnerConfig(
        model="mock",
        system_prompt="testing",
        tools=[FakeAgentTool(FakeTool())],
    )

    events = []
    async for event in stream_agent_events(
        runner=runner,
        config=config,
        input_text="What can you do?",
        retry_count=1,
    ):
        events.append(event)

    assert len(events) > 0


@pytest.mark.asyncio
async def test_agent_with_chat_history():
    runner = _make_runner()
    history = [
        TextMessage(role="human", content="Previous question"),
        TextMessage(role="ai", content="Previous answer"),
    ]

    config = RunnerConfig(
        model="mock",
        system_prompt="testing",
        tools=[FakeAgentTool(FakeTool())],
    )

    events = []
    async for event in stream_agent_events(
        runner=runner,
        config=config,
        input_text="Follow up",
        chat_history=history,
        retry_count=1,
    ):
        events.append(event)

    assert len(events) > 0


@pytest.mark.asyncio
async def test_agent_no_tools():
    runner = _make_runner()
    config = RunnerConfig(
        model="mock",
        system_prompt="testing",
        tools=[],
    )

    events = []
    async for event in stream_agent_events(
        runner=runner,
        config=config,
        input_text="Hello without tools",
        retry_count=1,
    ):
        events.append(event)

    assert len(events) > 0
