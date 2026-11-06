"""PLAN-0660 M5-C (T5.14–T5.16): ask_user tool — separation, wait and release semantics.

Six verification classes at the tool edge:
* normal answer (CP push resolves the blocked wait),
* timed ask (explicit ``no_answer`` and the run continues),
* plain ask local ceiling (fail-closed unbounded wait),
* run cancel (waiter is removed, no fabricated answer),
* replayed / duplicate / protocol-error answers (idempotent or rejected, never guessed),
* T5.16 refusal mapping (a child run's CP 409 ends the wait with a readable error, and only a
  recognised refusal becomes a result — unknown transport failures still raise).

The elapsed-budget exclusion is asserted in ``test_langgraph_runner_budget.py`` (it needs the
runner's pause loop); this file proves the tool never invents an answer and never leaks the
question body into a log line.
"""

import asyncio
import time

import pytest

from xihe_agent.adapters.user_question_tool import (
    CODE_SUBAGENT_QUESTION_REFUSED,
    MAX_QUESTION_LENGTH,
    MAX_TIMEOUT_SECONDS,
    NO_ANSWER_CONTENT,
    PARENT_RUN_ID_KEY,
    SUBAGENT_QUESTION_REFUSED_CONTENT,
    USER_QUESTION_EVENT_SINK_KEY,
    UserQuestionRefusedError,
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


# -- T5.16: CP dispatch marks a spawned (child) run, so the tool refuses at the door -------------


@pytest.mark.asyncio
async def test_ask_user_child_run_is_refused_before_any_event_is_published():
    """PLAN-0660 T5.16 (LD-16=A): ``parentRunId`` from the CP dispatch ends the ask locally."""
    tool = UserQuestionTool()
    context = _context()
    context.metadata[PARENT_RUN_ID_KEY] = "parent-run-1"
    published: list[dict] = []
    context.metadata[USER_QUESTION_EVENT_SINK_KEY] = _sink(published, asyncio.Event())

    result = await tool.execute({"question": "Which env?"}, context)

    assert result["status"] == "error"
    assert result["code"] == CODE_SUBAGENT_QUESTION_REFUSED
    assert result["content"] == SUBAGENT_QUESTION_REFUSED_CONTENT
    assert published == [], "a child run must not append session_question_asked"
    assert tool.coordinator.pending_by_run == {}
    assert tool.get_pending() == []


@pytest.mark.asyncio
async def test_ask_user_blank_parent_run_id_still_asks_as_a_root_run():
    """Absence and blank mean root run: the gate must not fire on an empty marker."""
    tool = UserQuestionTool()
    context = _context()
    context.metadata[PARENT_RUN_ID_KEY] = "   "
    published: list[dict] = []
    ready = asyncio.Event()
    context.metadata[USER_QUESTION_EVENT_SINK_KEY] = _sink(published, ready)

    task = asyncio.create_task(tool.execute({"question": "Which env?"}, context))
    await ready.wait()

    assert published == [{"question": "Which env?"}]
    assert tool.resolve_answer("q-1", "session-1", "run-1", "staging")[0] == "accepted"
    assert (await task)["status"] == "answered"


# -- T5.16: CP refusal mapping (a child run must not wait out the ceiling) -------------------


class _ProblemResponse:
    """``httpx.Response``-shaped double: only the two attributes the mapper reads."""

    status_code = 409

    def __init__(self, payload: dict) -> None:
        self._payload = payload

    def json(self) -> dict:
        return self._payload


class _Problem409Error(Exception):
    """``httpx.HTTPStatusError``-shaped double carrying a problem+json body."""

    def __init__(self, payload: dict) -> None:
        super().__init__("409 Conflict")
        self.response = _ProblemResponse(payload)


@pytest.mark.asyncio
async def test_ask_user_subagent_refusal_is_a_readable_error_not_a_wait():
    tool = UserQuestionTool()  # default 3600s ceiling: only the refusal can end this fast
    context = _context()

    async def refusing_sink(payload: dict) -> None:
        raise UserQuestionRefusedError(CODE_SUBAGENT_QUESTION_REFUSED)

    context.metadata[USER_QUESTION_EVENT_SINK_KEY] = refusing_sink

    started = time.monotonic()
    result = await tool.execute({"question": "Which env?"}, context)
    elapsed = time.monotonic() - started

    assert result["status"] == "error"
    assert result["code"] == "SUBAGENT_QUESTION_REFUSED"
    assert result["content"] == SUBAGENT_QUESTION_REFUSED_CONTENT
    assert "parent run" in result["content"]
    assert elapsed < 5.0  # never the local ceiling, never a hang
    assert tool.get_pending() == []
    assert tool.coordinator.question_runs == {}


@pytest.mark.asyncio
async def test_ask_user_refusal_leaves_no_waiter_and_the_run_can_ask_again():
    tool = UserQuestionTool()
    context = _context()
    published: list[dict] = []
    ready = asyncio.Event()

    async def flaky_sink(payload: dict) -> None:
        published.append(payload)
        if len(published) == 1:
            raise UserQuestionRefusedError(CODE_SUBAGENT_QUESTION_REFUSED)
        ready.set()

    context.metadata[USER_QUESTION_EVENT_SINK_KEY] = flaky_sink

    refused = await tool.execute({"question": "first"}, context)
    assert refused["status"] == "error"
    # A refused ask must not poison the run's next ask (no stale pending_by_run entry).
    assert tool.get_pending() == []

    retry = asyncio.create_task(tool.execute({"question": "second"}, context))
    await ready.wait()
    assert tool.resolve_answer("q-2", "session-1", "run-1", "staging")[0] == "accepted"
    assert (await retry)["status"] == "answered"


@pytest.mark.asyncio
async def test_ask_user_http_409_problem_code_is_mapped_to_the_cp_code():
    """A relay channel surfacing CP as an httpx-style 409 is mapped as well."""
    tool = UserQuestionTool()
    context = _context()

    async def refusing_sink(payload: dict) -> None:
        raise _Problem409Error({"code": CODE_SUBAGENT_QUESTION_REFUSED, "status": 409})

    context.metadata[USER_QUESTION_EVENT_SINK_KEY] = refusing_sink
    result = await tool.execute({"question": "Which env?"}, context)

    assert result["status"] == "error"
    assert result["code"] == CODE_SUBAGENT_QUESTION_REFUSED
    assert result["content"] == SUBAGENT_QUESTION_REFUSED_CONTENT


@pytest.mark.asyncio
async def test_ask_user_other_cp_refusal_code_is_reported_verbatim():
    tool = UserQuestionTool()
    context = _context()

    async def refusing_sink(payload: dict) -> None:
        raise UserQuestionRefusedError("QUESTION_NOT_FOUND")

    context.metadata[USER_QUESTION_EVENT_SINK_KEY] = refusing_sink
    result = await tool.execute({"question": "Which env?"}, context)

    assert result["status"] == "error"
    assert result["code"] == "QUESTION_NOT_FOUND"
    assert result["content"] != SUBAGENT_QUESTION_REFUSED_CONTENT


@pytest.mark.asyncio
async def test_ask_user_unknown_delivery_failure_is_not_swallowed():
    """Only a recognised refusal becomes a result — an unknown transport bug still raises."""
    tool = UserQuestionTool()
    context = _context()

    async def broken_sink(payload: dict) -> None:
        raise RuntimeError("transport exploded")

    context.metadata[USER_QUESTION_EVENT_SINK_KEY] = broken_sink
    with pytest.raises(RuntimeError, match="transport exploded"):
        await tool.execute({"question": "boom"}, context)
    assert tool.get_pending() == []


def _now():
    from datetime import UTC, datetime

    return datetime.now(UTC)
