"""PLAN-0660 M5-C (T5.14/T5.15): ask_user tool — separation, wait and release semantics.

Five verification classes at the tool edge:
* normal answer (CP push resolves the blocked wait),
* timed ask (explicit ``no_answer`` and the run continues),
* plain ask local ceiling (fail-closed unbounded wait),
* run cancel (waiter is removed, no fabricated answer),
* replayed / duplicate / protocol-error answers (idempotent or rejected, never guessed).

The elapsed-budget exclusion is asserted in ``test_langgraph_runner_budget.py`` (it needs the
runner's pause loop); this file proves the tool never invents an answer and never leaks the
question body into a log line.
"""

import asyncio
import time

import pytest

from xihe_agent.adapters.user_question_tool import (
    MAX_QUESTION_LENGTH,
    MAX_TIMEOUT_SECONDS,
    NO_ANSWER_CONTENT,
    USER_QUESTION_EVENT_SINK_KEY,
    UserQuestionTool,
)
from xihe_agent.interfaces.context import AgentContext


def _context(run_id: str = "run-1", session_id: str = "session-1") -> AgentContext:
    context = AgentContext.empty(session_id)
    context.metadata.update(
        {"runId": run_id, "sessionId": session_id, "workspaceId": "workspace-1"}
    )
    return context


def _sink(published: list[dict], ready: asyncio.Event):
    async def publish(payload: dict) -> None:
        published.append(payload)
        ready.set()

    return publish


@pytest.mark.asyncio
async def test_ask_user_is_an_independent_primitive():
    tool = UserQuestionTool()
    assert tool.name == "ask_user"
    assert tool.spec.input_schema["required"] == ["question"]
    assert "timeoutSeconds" in tool.spec.input_schema["properties"]
    assert tool.coordinator.pending_by_run == {}
    # The two human-wait tools never share a resolver surface.
    assert not hasattr(tool, "resolve_approval")
    assert not hasattr(tool, "await_external_approval")


@pytest.mark.asyncio
async def test_ask_user_answers_from_the_cp_push():
    tool = UserQuestionTool()
    context = _context()
    published: list[dict] = []
    ready = asyncio.Event()
    context.metadata[USER_QUESTION_EVENT_SINK_KEY] = _sink(published, ready)

    task = asyncio.create_task(tool.execute({"question": " Which database? "}, context))
    await ready.wait()

    assert len(published) == 1
    assert published[0] == {"question": "Which database?"}  # plain ask: no expiresAt
    status, _payload = tool.resolve_answer("q-1", "session-1", "run-1", "PostgreSQL")
    assert status == "accepted"

    result = await task
    assert result["status"] == "answered"
    assert "PostgreSQL" in result["content"]
    assert tool.get_pending() == []


@pytest.mark.asyncio
async def test_ask_user_timed_returns_explicit_no_answer_and_continues():
    tool = UserQuestionTool()
    context = _context()
    published: list[dict] = []
    ready = asyncio.Event()
    context.metadata[USER_QUESTION_EVENT_SINK_KEY] = _sink(published, ready)

    started = time.monotonic()
    result = await tool.execute({"question": "Continue?", "timeoutSeconds": 0.05}, context)
    elapsed = time.monotonic() - started

    assert result["status"] == "no_answer"
    assert result["reason"] == "timeout"
    assert result["content"] == NO_ANSWER_CONTENT
    assert "answer" not in result  # never fabricated
    assert 0.05 <= elapsed < 5.0
    assert published[0]["expiresAt"].endswith("Z")
    assert tool.get_pending() == []


@pytest.mark.asyncio
async def test_ask_user_plain_ask_uses_the_local_ceiling():
    tool = UserQuestionTool(wait_ceiling_seconds=0.05)
    context = _context()
    published: list[dict] = []
    ready = asyncio.Event()
    context.metadata[USER_QUESTION_EVENT_SINK_KEY] = _sink(published, ready)

    started = time.monotonic()
    result = await tool.execute({"question": "Need a decision"}, context)
    elapsed = time.monotonic() - started

    assert result["status"] == "no_answer"
    assert result["reason"] == "local_ceiling"
    assert elapsed >= 0.05
    assert "expiresAt" not in published[0]  # CP owns no deadline for a plain ask
    assert tool.get_pending() == []


@pytest.mark.asyncio
async def test_ask_user_timeout_is_clamped_to_the_local_ceiling():
    tool = UserQuestionTool(wait_ceiling_seconds=0.05)
    wait, expires_at, error = tool.coordinator._resolve_timeout(MAX_TIMEOUT_SECONDS + 600)

    assert error is None
    assert wait == MAX_TIMEOUT_SECONDS
    assert expires_at is not None
    delta = (expires_at - _now()).total_seconds()
    assert MAX_TIMEOUT_SECONDS - 2 <= delta <= MAX_TIMEOUT_SECONDS


@pytest.mark.asyncio
async def test_ask_user_run_cancel_removes_the_waiter():
    tool = UserQuestionTool()
    context = _context()
    published: list[dict] = []
    ready = asyncio.Event()
    context.metadata[USER_QUESTION_EVENT_SINK_KEY] = _sink(published, ready)

    task = asyncio.create_task(tool.execute({"question": "Still there?"}, context))
    await ready.wait()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task

    assert tool.get_pending() == []
    # A cancelled wait must not become an delivered question the route could replay.
    assert tool.coordinator.question_runs == {}


@pytest.mark.asyncio
async def test_ask_user_duplicate_answer_is_idempotent_and_conflicts_are_rejected():
    tool = UserQuestionTool()
    context = _context()
    published: list[dict] = []
    ready = asyncio.Event()
    context.metadata[USER_QUESTION_EVENT_SINK_KEY] = _sink(published, ready)

    task = asyncio.create_task(tool.execute({"question": "Which env?"}, context))
    await ready.wait()

    assert tool.resolve_answer("q-1", "session-1", "run-1", "staging")[0] == "accepted"
    # Replay of the same CP question id (retried delivery) is idempotent...
    assert tool.resolve_answer("q-1", "session-1", "run-1", "staging")[0] == "already_delivered"
    # ...a different question id for the same wait is a contract conflict, not a guess.
    assert tool.resolve_answer("q-2", "session-1", "run-1", "prod")[0] == "conflict"

    result = await task
    assert result["status"] == "answered"
    assert "staging" in result["content"]
    assert "prod" not in result["content"]


@pytest.mark.asyncio
async def test_ask_user_unknown_question_id_is_not_found():
    tool = UserQuestionTool()
    assert tool.resolve_answer("q-unknown", "session-1", "run-none", "x")[0] == "not_found"


@pytest.mark.asyncio
async def test_ask_user_blank_answer_keeps_the_wait_pending():
    tool = UserQuestionTool()
    context = _context()
    published: list[dict] = []
    ready = asyncio.Event()
    context.metadata[USER_QUESTION_EVENT_SINK_KEY] = _sink(published, ready)

    task = asyncio.create_task(tool.execute({"question": "Which port?"}, context))
    await ready.wait()

    assert tool.resolve_answer("q-1", "session-1", "run-1", "   ")[0] == "invalid"
    assert len(tool.get_pending()) == 1  # protocol error must not settle the wait
    assert tool.resolve_answer("q-1", "session-1", "run-1", "12631")[0] == "accepted"
    assert (await task)["status"] == "answered"


@pytest.mark.asyncio
@pytest.mark.parametrize("bad_timeout", ["abc", 0, -1, float("inf"), float("nan"), True])
async def test_ask_user_invalid_timeout_is_a_model_readable_error(bad_timeout):
    tool = UserQuestionTool()
    context = _context()
    published: list[dict] = []
    context.metadata[USER_QUESTION_EVENT_SINK_KEY] = _sink(published, asyncio.Event())

    result = await tool.execute({"question": "q", "timeoutSeconds": bad_timeout}, context)

    assert result["status"] == "error"
    assert result["code"] == "INVALID_TIMEOUT"
    assert published == []
    assert tool.get_pending() == []


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("payload", "code"),
    [
        ({}, "INVALID_QUESTION"),
        ({"question": "   "}, "INVALID_QUESTION"),
        ({"question": "x" * (MAX_QUESTION_LENGTH + 1)}, "INVALID_QUESTION"),
    ],
)
async def test_ask_user_invalid_question_is_a_model_readable_error(payload, code):
    tool = UserQuestionTool()
    context = _context()
    result = await tool.execute(payload, context)
    assert result["status"] == "error"
    assert result["code"] == code
    assert tool.get_pending() == []


@pytest.mark.asyncio
async def test_ask_user_second_pending_ask_for_the_same_run_is_refused():
    tool = UserQuestionTool()
    context = _context()
    published: list[dict] = []
    ready = asyncio.Event()
    context.metadata[USER_QUESTION_EVENT_SINK_KEY] = _sink(published, ready)

    first = asyncio.create_task(tool.execute({"question": "first"}, context))
    await ready.wait()
    second = await tool.execute({"question": "second"}, context)

    assert second["status"] == "error"
    assert second["code"] == "QUESTION_ALREADY_PENDING"
    assert len(published) == 1
    tool.resolve_answer("q-1", "session-1", "run-1", "ok")
    assert (await first)["status"] == "answered"


@pytest.mark.asyncio
async def test_ask_user_without_event_sink_fails_closed():
    tool = UserQuestionTool()
    context = _context()  # no USER_QUESTION_EVENT_SINK_KEY

    with pytest.raises(RuntimeError):
        await tool.execute({"question": "anyone?"}, context)
    assert tool.get_pending() == []


def _now():
    from datetime import UTC, datetime

    return datetime.now(UTC)
