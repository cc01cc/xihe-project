import asyncio
from unittest.mock import AsyncMock

import pytest

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
