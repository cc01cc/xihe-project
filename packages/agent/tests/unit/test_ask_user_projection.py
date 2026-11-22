import asyncio
from unittest.mock import AsyncMock

import pytest
from langchain_core.tools import BaseTool, ToolException

from xihe_agent.adapters.user_question_tool import USER_QUESTION_EVENT_SINK_KEY, UserQuestionTool
from xihe_agent.agent_runner.tool_adapter import LCToolAdapter
from xihe_agent.interfaces.context import AgentContext


def _adapter():
    tool = UserQuestionTool()
    context = AgentContext.empty("session-1")
    context.metadata.update({"runId": "run-1", "sessionId": "session-1"})
    published = []
    ready = asyncio.Event()

    async def publish(payload):
        published.append(payload)
        ready.set()

    context.metadata[USER_QUESTION_EVENT_SINK_KEY] = publish
    return tool, LCToolAdapter(tool, context, None), published, ready


@pytest.mark.asyncio
@pytest.mark.parametrize("timeout", [None, 30])
async def test_framework_ask_waits_and_accepts_answer(timeout):
    tool, adapter, published, ready = _adapter()
    args = {"question": "Choose?"}
    if timeout is not None:
        args["timeoutSeconds"] = timeout
    task = asyncio.create_task(adapter.arun(args, tool_call_id="call-1"))
    await asyncio.wait_for(ready.wait(), timeout=2)
    assert len(published) == 1
    assert ("expiresAt" in published[0]) is (timeout is not None)
    assert "run-1" in tool.coordinator.pending_by_run
    assert tool.resolve_answer("question-1", "session-1", "run-1", "answer")[0] == "accepted"
    result = await asyncio.wait_for(task, timeout=2)
    assert result.status == "success"
    assert '"status":"answered"' in result.content.replace(" ", "")


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "extra",
    [{"timeoutSeconds": None}, {"timeoutSeconds": "30"}, {"timeoutSeconds": True}, {"unexpected": 1}],
)
async def test_framework_rejects_invalid_input_without_executing(extra):
    tool, adapter, published, _ready = _adapter()
    tool.execute = AsyncMock()
    result = await adapter.arun({"question": "Choose?", **extra}, tool_call_id="call-1")
    assert result.status == "error"
    assert result.content == "INVALID_TOOL_ARGUMENTS"
    tool.execute.assert_not_awaited()
    assert published == []
    assert tool.coordinator.pending_by_run == {}


@pytest.mark.asyncio
async def test_framework_rejects_string_input_without_executing():
    tool, adapter, published, _ready = _adapter()
    tool.execute = AsyncMock()
    result = await adapter.arun('{"question":"Choose?"}', tool_call_id="call-1")
    assert result.status == "error"
    assert result.content == "INVALID_TOOL_ARGUMENTS"
    tool.execute.assert_not_awaited()
    assert published == []
    assert tool.coordinator.pending_by_run == {}


def test_framework_optional_default_is_injected_and_adapter_filters_it():
    """task-113: pin the upstream behavior behind the window-2 ask_user crash.

    LangChain fills an omitted optional field with the Pydantic default (None),
    so the strict checkpoint-safe projection would reject a call whose raw args
    carried only ``question``. The adapter override must drop that injected
    default before dispatch.
    """
    _tool, adapter, _published, _ready = _adapter()

    framework = BaseTool._parse_input(adapter, {"question": "Choose?"}, "call-1")
    assert framework["timeoutSeconds"] is None

    parsed = adapter._parse_input({"question": "Choose?"}, "call-1")
    assert parsed == {"question": "Choose?", "tool_call_id": "call-1"}


@pytest.mark.asyncio
async def test_pre_fix_framework_default_becomes_structured_error(monkeypatch):
    """The pre-task-143 path now ends as an error ToolMessage, not a ValueError."""
    tool, adapter, published, _ready = _adapter()
    tool.execute = AsyncMock()
    monkeypatch.setattr(LCToolAdapter, "_parse_input", BaseTool._parse_input)

    result = await adapter.arun({"question": "Choose?"}, tool_call_id="call-1")

    assert result.status == "error"
    assert result.content == "INVALID_TOOL_ARGUMENTS"
    tool.execute.assert_not_awaited()
    assert published == []
    assert tool.coordinator.pending_by_run == {}


@pytest.mark.asyncio
async def test_dispatch_projection_failure_is_a_tool_exception():
    """Dispatch-time guard: no stream-fatal ValueError escapes the adapter."""
    tool, adapter, _published, _ready = _adapter()
    tool.execute = AsyncMock()

    with pytest.raises(ToolException) as raised:
        await adapter._arun(question="Choose?", timeoutSeconds=None, tool_call_id="call-1")

    assert str(raised.value) == "INVALID_TOOL_ARGUMENTS"
    tool.execute.assert_not_awaited()
