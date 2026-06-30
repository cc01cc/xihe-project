import pytest
from langchain_core.messages import AIMessage, HumanMessage
from langchain_core.tools import BaseTool
from pydantic import BaseModel, Field

from xihe_agent.agent.executor import (
    DEFAULT_MAX_ITERATIONS,
    format_system_message,
    stream_agent_events,
)
from xihe_agent.llm.base import MockChatModel


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


def test_format_system_message():
    msg = format_system_message(
        user_name="TestUser",
        instructions="test instructions",
    )
    assert "TestUser" in msg.content
    assert "test instructions" in msg.content


def test_default_max_iterations():
    assert DEFAULT_MAX_ITERATIONS == 4


@pytest.mark.asyncio
async def test_agent_creation_with_tools():
    model = MockChatModel()
    tool = FakeTool()

    events = []
    async for event in stream_agent_events(
        model=model,
        tools=[tool],
        input_text="Hello",
        user_name="Tester",
        instructions="test",
        max_iterations=1,
    ):
        events.append(event)

    assert len(events) > 0


@pytest.mark.asyncio
async def test_agent_stream_produces_events():
    model = MockChatModel()
    tool = FakeTool()

    events = []
    async for event in stream_agent_events(
        model=model,
        tools=[tool],
        input_text="What can you do?",
        user_name="User",
        instructions="testing",
        max_iterations=2,
    ):
        events.append(event)

    event_types = {e.get("event") for e in events}
    assert len(events) > 0


@pytest.mark.asyncio
async def test_agent_with_chat_history():
    model = MockChatModel()
    history = [HumanMessage(content="Previous question"), AIMessage(content="Previous answer")]

    events = []
    async for event in stream_agent_events(
        model=model,
        tools=[],
        input_text="Follow up",
        chat_history=history,
        max_iterations=1,
    ):
        events.append(event)

    assert len(events) > 0


@pytest.mark.asyncio
async def test_agent_no_tools():
    model = MockChatModel()

    events = []
    async for event in stream_agent_events(
        model=model,
        tools=[],
        input_text="Hello without tools",
        max_iterations=1,
    ):
        events.append(event)

    assert len(events) > 0
