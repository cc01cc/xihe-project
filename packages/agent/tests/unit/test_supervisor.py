from typing import Any
from unittest.mock import AsyncMock, MagicMock

import pytest
from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessage, BaseMessage, HumanMessage
from langchain_core.outputs import ChatGeneration, ChatResult
from langchain_core.tools import tool

from xihe_agent.agent.supervisor import (
    CODE_PROMPT,
    GENERAL_PROMPT,
    RESEARCH_PROMPT,
    SUPERVISOR_NODE,
    build_supervisor,
)


def test_prompts_defined():
    assert len(GENERAL_PROMPT) > 50
    assert len(RESEARCH_PROMPT) > 50
    assert len(CODE_PROMPT) > 50


@tool
def mock_tool() -> str:
    """A mock tool for testing."""
    return "mock result"


class ScriptedChatModel(BaseChatModel):
    """Minimal chat model that replays a fixed script (one entry per call).

    Only used to prove the handoff wiring: the graph must route a
    ``transfer_to_<worker>`` tool call into the worker node and come back to the
    supervisor for the final answer.
    """

    script: list[AIMessage]
    calls: int = 0

    @property
    def _llm_type(self) -> str:
        return "scripted"

    def bind_tools(self, tools: Any, **kwargs: Any) -> "ScriptedChatModel":
        return self

    def _generate(
        self,
        messages: list[BaseMessage],
        stop: Any = None,
        run_manager: Any = None,
        **kwargs: Any,
    ) -> ChatResult:
        message = self.script[min(self.calls, len(self.script) - 1)]
        self.calls += 1
        return ChatResult(generations=[ChatGeneration(message=message)])


@pytest.mark.asyncio
async def test_build_supervisor_no_registry():
    model = MagicMock()
    model.agenerate = AsyncMock()
    supervisor = build_supervisor(model, [mock_tool], [])
    assert supervisor is not None


def test_build_supervisor_wires_supervisor_worker_nodes_without_checkpointer():
    """PLAN-0633 batch E: built in-house, no langgraph-supervisor, no checkpointer."""
    model = MagicMock()
    model.agenerate = AsyncMock()
    supervisor = build_supervisor(model, [mock_tool], [])

    nodes = set(supervisor.get_graph().nodes)
    assert SUPERVISOR_NODE in nodes
    assert {"general_agent", "research_agent", "code_agent"} <= nodes
    # checkpoint_saver.SAFE_REACT_NODE_NAMES does not cover supervisor nodes,
    # so v1 must not attach the CP-mediated saver (module docstring).
    assert supervisor.checkpointer is None


def test_handoff_routes_to_specialist_and_returns_to_supervisor():
    script = [
        AIMessage(content="", tool_calls=[{"name": "transfer_to_research_agent", "args": {}, "id": "call-1"}]),
        AIMessage(content="specialist answer"),
        AIMessage(content="final answer"),
    ]
    model = ScriptedChatModel(script=script)
    supervisor = build_supervisor(model, [mock_tool], [])

    result = supervisor.invoke({"messages": [HumanMessage(content="hi")]})

    messages = result["messages"]
    assert [getattr(message, "name", None) for message in messages] == [
        None,  # the user turn
        "research_agent",
        SUPERVISOR_NODE,
    ]
    assert messages[1].content == "specialist answer"
    assert messages[-1].content == "final answer"
