"""G3-a「checkpoint_safe_schema」— agent-side acceptance tests (task-208 draft).

Covers 判据 1 (both ToolSpecs declare a checkpoint_safe_schema), 判据 3 (every
return path produces envelope content that passes project_output, and the adapter
emits the CHECKPOINT_SAFE_OUTPUT_SCHEMA_KEY ToolMessage on every path), 判据 4
(the output envelope never carries the question/action body), the resume 认领
logic (draft A2/A3: runId → CP durable row), and A4 (adapter safe-branch
reachability, including that refusal/error envelopes are not intercepted).
"""

from __future__ import annotations

import asyncio
import json
import re
from datetime import UTC, datetime, timedelta

import pytest
from langchain_core.messages import ToolMessage

from xihe_agent.adapters.approval_tool import (
    APPROVAL_RESUME_LOOKUP_KEY,
    REQUEST_APPROVAL_ENVELOPE_VERSION,
    ApprovalAgentTool,
    ApprovalExpiredError,
    ApprovalProtocolError,
    ApprovalRejectedError,
)
from xihe_agent.adapters.user_question_tool import (
    ASK_USER_ENVELOPE_VERSION,
    USER_QUESTION_EVENT_SINK_KEY,
    USER_QUESTION_RESUME_LOOKUP_KEY,
    CODE_SUBAGENT_QUESTION_REFUSED,
    PendingQuestion,
    UserQuestionTool,
)
from xihe_agent.agent_runner.tool_adapter import LCToolAdapter
from xihe_agent.interfaces.context import AgentContext
from xihe_agent.interfaces.tool import (
    CHECKPOINT_SAFE_OUTPUT_PREFIX,
    CHECKPOINT_SAFE_OUTPUT_SCHEMA_KEY,
    CHECKPOINT_SAFE_OUTPUT_SUFFIX,
)

_VERSION_PATTERN = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]*\.v[1-9][0-9]*")


def _context(run_id: str = "run-1", session_id: str = "session-1") -> AgentContext:
    context = AgentContext.empty(session_id)
    context.metadata.update(
        {"runId": run_id, "sessionId": session_id, "workspaceId": "workspace-1"}
    )
    return context


def _publishing_sink(published: list[dict], ready: asyncio.Event | None = None):
    async def publish(payload: dict) -> None:
        published.append(payload)
        if ready is not None:
            ready.set()

    return publish


def _envelope_of(result: dict) -> dict:
    """The model/durable payload is exactly the canonical JSON envelope."""
    return json.loads(result["content"])


async def _await_until(predicate, timeout: float = 2.0) -> None:
    deadline = asyncio.get_event_loop().time() + timeout
    while not predicate():
        if asyncio.get_event_loop().time() > deadline:
            raise AssertionError("condition was not met in time")
        await asyncio.sleep(0.005)


# ---------------------------------------------------------------------------
# 判据 1 — both waiting primitives declare a checkpoint_safe_schema
# ---------------------------------------------------------------------------


def test_ask_user_spec_declares_checkpoint_safe_schema() -> None:
    schema = UserQuestionTool().spec.checkpoint_safe_schema
    assert schema is not None
    assert schema.version == ASK_USER_ENVELOPE_VERSION
    assert _VERSION_PATTERN.fullmatch(schema.version)


def test_request_approval_spec_declares_checkpoint_safe_schema() -> None:
    schema = ApprovalAgentTool().spec.checkpoint_safe_schema
    assert schema is not None
    assert schema.version == REQUEST_APPROVAL_ENVELOPE_VERSION
    assert _VERSION_PATTERN.fullmatch(schema.version)


def test_ask_user_schema_roundtrips_live_args_and_envelope() -> None:
    schema = UserQuestionTool().spec.checkpoint_safe_schema
    projected = schema.project_input({"question": "Which database?", "timeoutSeconds": 30})
    assert projected == {"question": "Which database?", "timeoutSeconds": 30}
    envelope = schema.project_output(
        {"questionId": "q-1", "status": "answered", "answer": "PostgreSQL", "code": ""}
    )
    assert envelope["answer"] == "PostgreSQL"


def test_request_approval_schema_roundtrips_live_args_and_envelope() -> None:
    schema = ApprovalAgentTool().spec.checkpoint_safe_schema
    assert schema.project_input({"action": "delete file", "details": "README.md"}) == {
        "action": "delete file",
        "details": "README.md",
    }
    envelope = schema.project_output(
        {"requestId": "r-1", "status": "approved", "feedback": ""}
    )
    assert envelope["status"] == "approved"


def test_ask_user_input_schema_covers_the_invalid_question_path() -> None:
    """判据 2/3: an oversize question is a live arg that must become an
    INVALID_QUESTION envelope — the schema bound must not reject it first."""
    schema = UserQuestionTool().spec.checkpoint_safe_schema
    oversize = "x" * 2001
    assert schema.project_input({"question": oversize}) == {"question": oversize}


def test_output_envelope_whitelists_match_the_draft_baseline() -> None:
    ask_schema = UserQuestionTool().spec.checkpoint_safe_schema
    approval_schema = ApprovalAgentTool().spec.checkpoint_safe_schema
    assert set(ask_schema.output_schema["properties"]) == {
        "questionId",
        "status",
        "answer",
        "code",
    }
    assert set(approval_schema.output_schema["properties"]) == {
        "requestId",
        "status",
        "feedback",
    }
    # 判据 4 (static): no prompt/action/details body field in the output schema.
    for name in ("question", "action", "details"):
        assert name not in ask_schema.output_schema["properties"]
        assert name not in approval_schema.output_schema["properties"]


# ---------------------------------------------------------------------------
# 判据 3 — every ask_user return path produces a schema-valid envelope
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_ask_user_answered_path_envelope() -> None:
    tool = UserQuestionTool()
    context = _context()
    published: list[dict] = []
    ready = asyncio.Event()
    context.metadata[USER_QUESTION_EVENT_SINK_KEY] = _publishing_sink(published, ready)

    task = asyncio.create_task(tool.execute({"question": "Which env?"}, context))
    await ready.wait()
    assert tool.resolve_answer("cp-q-1", "session-1", "run-1", "staging")[0] == "accepted"
    result = await task

    envelope = _envelope_of(result)
    tool.spec.checkpoint_safe_schema.project_output(envelope)  # must not raise
    assert envelope == {
        "questionId": "cp-q-1",  # the CP-owned id learned from the answer push
        "status": "answered",
        "answer": "staging",
        "code": "",
    }
    # 判据 4: the question body never appears in the output envelope.
    assert "Which env?" not in result["content"]


@pytest.mark.asyncio
async def test_ask_user_no_answer_paths_envelope() -> None:
    tool = UserQuestionTool()
    context = _context()
    published: list[dict] = []
    context.metadata[USER_QUESTION_EVENT_SINK_KEY] = _publishing_sink(published)

    result = await tool.execute({"question": "Continue?", "timeoutSeconds": 0.02}, context)
    envelope = _envelope_of(result)
    tool.spec.checkpoint_safe_schema.project_output(envelope)
    assert envelope["status"] == "no_answer"
    assert envelope["answer"] == "" and envelope["code"] == ""
    assert result["reason"] == "timeout"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("payload", "code"),
    [
        ({}, "INVALID_QUESTION"),
        ({"question": "   "}, "INVALID_QUESTION"),
        ({"question": "x" * 2001}, "INVALID_QUESTION"),
        ({"question": "q", "timeoutSeconds": 0}, "INVALID_TIMEOUT"),
        ({"question": "q", "timeoutSeconds": -1}, "INVALID_TIMEOUT"),
        ({"question": "q", "timeoutSeconds": 7200}, None),  # clamped, waits
    ],
)
async def test_ask_user_validation_paths_envelope(payload, code) -> None:
    tool = UserQuestionTool(wait_ceiling_seconds=0.02)
    context = _context()
    published: list[dict] = []
    context.metadata[USER_QUESTION_EVENT_SINK_KEY] = _publishing_sink(published)
    if code is None:
        payload = {**payload, "timeoutSeconds": 0.02}  # clamp path still resolves

    result = await tool.execute(payload, context)
    envelope = _envelope_of(result)
    tool.spec.checkpoint_safe_schema.project_output(envelope)
    if code is None:
        assert envelope["status"] == "no_answer"  # clamped to a real deadline
    else:
        assert envelope["status"] == "error"
        assert envelope["code"] == code
        assert envelope["questionId"] == ""


@pytest.mark.asyncio
async def test_ask_user_refusal_paths_envelope() -> None:
    # 子会话门
    tool = UserQuestionTool()
    context = _context()
    context.metadata["parentRunId"] = "parent-run-1"
    result = await tool.execute({"question": "Which env?"}, context)
    envelope = _envelope_of(result)
    tool.spec.checkpoint_safe_schema.project_output(envelope)
    assert envelope["status"] == "refused"
    assert envelope["code"] == CODE_SUBAGENT_QUESTION_REFUSED

    # QUESTION_ALREADY_PENDING
    tool2 = UserQuestionTool()
    context2 = _context()
    tool2.coordinator.pending_by_run["run-1"] = PendingQuestion(
        local_id="x", run_id="run-1", session_id="session-1", payload={}
    )
    result2 = await tool2.execute({"question": "second"}, context2)
    envelope2 = _envelope_of(result2)
    tool2.spec.checkpoint_safe_schema.project_output(envelope2)
    assert envelope2["status"] == "refused"
    assert envelope2["code"] == "QUESTION_ALREADY_PENDING"

    # CP 409 via the sink
    tool3 = UserQuestionTool()
    context3 = _context()

    class _Resp:
        status_code = 409

        def json(self):
            return {"code": "QUESTION_NOT_FOUND"}

    class _409(Exception):
        def __init__(self):
            super().__init__("409")
            self.response = _Resp()

    async def refusing_sink409(payload: dict) -> None:
        raise _409()

    context3.metadata[USER_QUESTION_EVENT_SINK_KEY] = refusing_sink409
    result3 = await tool3.execute({"question": "Which env?"}, context3)
    envelope3 = _envelope_of(result3)
    tool3.spec.checkpoint_safe_schema.project_output(envelope3)
    assert envelope3["status"] == "refused"
    assert envelope3["code"] == "QUESTION_NOT_FOUND"
    assert envelope3["questionId"]  # the ask had been delivered: the local id is known


# ---------------------------------------------------------------------------
# 判据 3/7 — approval: approved path envelopes; rejected/expired stay terminal
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_approval_approved_path_envelope() -> None:
    tool = ApprovalAgentTool(timeout_seconds=1)
    context = _context()
    published: list[dict] = []
    context.metadata["_approval_event_sink"] = _publishing_sink(published)

    task = asyncio.create_task(tool.execute({"action": "delete file"}, context))
    await _await_until(lambda: len(published) == 1)
    tool.resolve_approval(published[0]["requestId"], True)
    result = await task

    envelope = _envelope_of(result)
    tool.spec.checkpoint_safe_schema.project_output(envelope)
    assert envelope == {
        "requestId": published[0]["requestId"],
        "status": "approved",
        "feedback": "",
    }
    # 判据 4: the action body never appears in the output envelope.
    assert "delete file" not in result["content"]


@pytest.mark.asyncio
async def test_approval_rejection_and_expiry_stay_terminal() -> None:
    tool = ApprovalAgentTool(timeout_seconds=1)
    context = _context()
    published: list[dict] = []
    context.metadata["_approval_event_sink"] = _publishing_sink(published)

    task = asyncio.create_task(tool.execute({"action": "delete file"}, context))
    await _await_until(lambda: len(published) == 1)
    tool.resolve_approval_status(published[0]["requestId"], False, "not now")
    with pytest.raises(ApprovalRejectedError, match="not now"):
        await task

    tool2 = ApprovalAgentTool(timeout_seconds=0.01)
    context2 = _context()
    published2: list[dict] = []
    context2.metadata["_approval_event_sink"] = _publishing_sink(published2)
    with pytest.raises(ApprovalExpiredError):
        await tool2.execute({"action": "rotate key"}, context2)


# ---------------------------------------------------------------------------
# A2/A3 — resume 认领: the runId lookup claims the CP durable row
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_ask_user_resume_answered_row_returns_envelope_without_republish() -> None:
    tool = UserQuestionTool()
    context = _context()
    published: list[dict] = []
    context.metadata[USER_QUESTION_EVENT_SINK_KEY] = _publishing_sink(published)

    async def lookup(run_id: str):
        assert run_id == "run-1"
        return {"questionId": "cp-q-9", "state": "answered", "answer": "blue", "expiresAt": None}

    context.metadata[USER_QUESTION_RESUME_LOOKUP_KEY] = lookup
    result = await tool.execute({"question": "Which colour?"}, context)

    envelope = _envelope_of(result)
    tool.spec.checkpoint_safe_schema.project_output(envelope)
    assert envelope["status"] == "answered"
    assert envelope["questionId"] == "cp-q-9"
    assert envelope["answer"] == "blue"
    assert published == []  # the user never sees a second question
    # Idempotent replay of the same CP question id resolves.
    assert tool.resolve_answer("cp-q-9", "session-1", "run-1", "blue")[0] == "already_delivered"


@pytest.mark.asyncio
async def test_ask_user_resume_pending_row_rearms_without_republish() -> None:
    tool = UserQuestionTool()
    context = _context()
    published: list[dict] = []
    context.metadata[USER_QUESTION_EVENT_SINK_KEY] = _publishing_sink(published)
    expires = (datetime.now(UTC) + timedelta(seconds=60)).isoformat().replace("+00:00", "Z")

    async def lookup(run_id: str):
        return {"questionId": "cp-q-10", "state": "pending", "expiresAt": expires}

    context.metadata[USER_QUESTION_RESUME_LOOKUP_KEY] = lookup
    task = asyncio.create_task(tool.execute({"question": "again?"}, context))
    await _await_until(lambda: tool.get_pending() != [])
    assert published == []

    assert tool.resolve_answer("cp-q-10", "session-1", "run-1", "yes")[0] == "accepted"
    result = await task
    envelope = _envelope_of(result)
    assert envelope["status"] == "answered"
    assert envelope["questionId"] == "cp-q-10"
    assert envelope["answer"] == "yes"


@pytest.mark.asyncio
async def test_ask_user_resume_expired_row_returns_no_answer() -> None:
    tool = UserQuestionTool()
    context = _context()
    published: list[dict] = []
    context.metadata[USER_QUESTION_EVENT_SINK_KEY] = _publishing_sink(published)

    async def lookup(run_id: str):
        return {"questionId": "cp-q-11", "state": "expired", "expiresAt": None}

    context.metadata[USER_QUESTION_RESUME_LOOKUP_KEY] = lookup
    result = await tool.execute({"question": "too late?"}, context)
    envelope = _envelope_of(result)
    assert envelope["status"] == "no_answer"
    assert result["reason"] == "resume_expired"
    assert published == []


@pytest.mark.asyncio
async def test_ask_user_resume_pending_past_deadline_returns_no_answer() -> None:
    tool = UserQuestionTool()
    context = _context()
    published: list[dict] = []
    context.metadata[USER_QUESTION_EVENT_SINK_KEY] = _publishing_sink(published)
    past = (datetime.now(UTC) - timedelta(seconds=5)).isoformat().replace("+00:00", "Z")

    async def lookup(run_id: str):
        return {"questionId": "cp-q-12", "state": "pending", "expiresAt": past}

    context.metadata[USER_QUESTION_RESUME_LOOKUP_KEY] = lookup
    result = await tool.execute({"question": "past?"}, context)
    assert _envelope_of(result)["status"] == "no_answer"
    assert result["reason"] == "resume_expired"


@pytest.mark.asyncio
async def test_ask_user_resume_lookup_failure_falls_back_to_fresh_ask() -> None:
    tool = UserQuestionTool()
    context = _context()
    published: list[dict] = []
    ready = asyncio.Event()
    context.metadata[USER_QUESTION_EVENT_SINK_KEY] = _publishing_sink(published, ready)

    async def broken_lookup(run_id: str):
        raise RuntimeError("cp unreachable")

    context.metadata[USER_QUESTION_RESUME_LOOKUP_KEY] = broken_lookup
    task = asyncio.create_task(tool.execute({"question": "fresh?"}, context))
    await ready.wait()
    assert len(published) == 1  # fail-closed degradation: a fresh ask
    assert tool.resolve_answer("cp-q-13", "session-1", "run-1", "ok")[0] == "accepted"
    assert _envelope_of(await task)["status"] == "answered"


@pytest.mark.asyncio
async def test_ask_user_resume_unknown_state_falls_through_to_fresh_ask() -> None:
    tool = UserQuestionTool()
    context = _context()
    published: list[dict] = []
    ready = asyncio.Event()
    context.metadata[USER_QUESTION_EVENT_SINK_KEY] = _publishing_sink(published, ready)

    async def lookup(run_id: str):
        return {"questionId": "cp-q-14", "state": "mystery"}

    context.metadata[USER_QUESTION_RESUME_LOOKUP_KEY] = lookup
    task = asyncio.create_task(tool.execute({"question": "fresh?"}, context))
    await ready.wait()
    assert len(published) == 1
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task


@pytest.mark.asyncio
async def test_approval_resume_approved_row_returns_envelope_without_republish() -> None:
    tool = ApprovalAgentTool(timeout_seconds=1)
    context = _context()
    published: list[dict] = []
    context.metadata["_approval_event_sink"] = _publishing_sink(published)

    async def lookup(run_id: str):
        return {"requestId": "cp-r-9", "state": "approved", "feedback": None, "expiresAt": None}

    context.metadata[APPROVAL_RESUME_LOOKUP_KEY] = lookup
    result = await tool.execute({"action": "deploy"}, context)

    envelope = _envelope_of(result)
    tool.spec.checkpoint_safe_schema.project_output(envelope)
    assert envelope == {"requestId": "cp-r-9", "status": "approved", "feedback": ""}
    assert published == []
    assert tool.coordinator.resolve_status("cp-r-9", True) == ("already_decided", True)


@pytest.mark.asyncio
async def test_approval_resume_rejected_row_reraises_terminal_with_feedback() -> None:
    tool = ApprovalAgentTool(timeout_seconds=1)
    context = _context()
    published: list[dict] = []
    context.metadata["_approval_event_sink"] = _publishing_sink(published)

    async def lookup(run_id: str):
        return {"requestId": "cp-r-10", "state": "rejected", "feedback": "no way"}

    context.metadata[APPROVAL_RESUME_LOOKUP_KEY] = lookup
    with pytest.raises(ApprovalRejectedError, match="no way"):
        await tool.execute({"action": "deploy"}, context)
    assert published == []
    assert tool.coordinator.resolve_status("cp-r-10", False) == ("already_decided", False)


@pytest.mark.asyncio
async def test_approval_resume_expired_row_reraises_terminal() -> None:
    tool = ApprovalAgentTool(timeout_seconds=1)
    context = _context()
    published: list[dict] = []
    context.metadata["_approval_event_sink"] = _publishing_sink(published)

    async def lookup(run_id: str):
        return {"requestId": "cp-r-11", "state": "expired", "expiresAt": None}

    context.metadata[APPROVAL_RESUME_LOOKUP_KEY] = lookup
    with pytest.raises(ApprovalExpiredError):
        await tool.execute({"action": "deploy"}, context)
    assert published == []


@pytest.mark.asyncio
async def test_approval_resume_pending_row_rearms_wait() -> None:
    tool = ApprovalAgentTool(timeout_seconds=1)
    context = _context()
    published: list[dict] = []
    context.metadata["_approval_event_sink"] = _publishing_sink(published)
    expires = (datetime.now(UTC) + timedelta(seconds=60)).isoformat().replace("+00:00", "Z")

    async def lookup(run_id: str):
        return {"requestId": "cp-r-12", "state": "pending", "expiresAt": expires}

    context.metadata[APPROVAL_RESUME_LOOKUP_KEY] = lookup
    task = asyncio.create_task(tool.execute({"action": "deploy"}, context))
    await _await_until(lambda: "cp-r-12" in tool.coordinator.pending_requests)
    assert published == []  # 判据 7: never a second approval request

    tool.resolve_approval_status("cp-r-12", True, None)
    result = await task
    envelope = _envelope_of(result)
    assert envelope == {"requestId": "cp-r-12", "status": "approved", "feedback": ""}


@pytest.mark.asyncio
async def test_approval_resume_pending_malformed_expiry_is_protocol_error() -> None:
    tool = ApprovalAgentTool(timeout_seconds=1)
    context = _context()
    published: list[dict] = []
    context.metadata["_approval_event_sink"] = _publishing_sink(published)

    async def lookup(run_id: str):
        return {"requestId": "cp-r-13", "state": "pending", "expiresAt": "not-a-date"}

    context.metadata[APPROVAL_RESUME_LOOKUP_KEY] = lookup
    with pytest.raises(ApprovalProtocolError):
        await tool.execute({"action": "deploy"}, context)
    assert published == []


# ---------------------------------------------------------------------------
# A4 — adapter safe-branch reachability for the envelope tools
# ---------------------------------------------------------------------------


def _safe_output_of(message: ToolMessage) -> dict:
    assert message.additional_kwargs == {
        CHECKPOINT_SAFE_OUTPUT_SCHEMA_KEY: ASK_USER_ENVELOPE_VERSION
    }
    assert message.status == "success"
    inner = message.content[
        len(CHECKPOINT_SAFE_OUTPUT_PREFIX) : -len(CHECKPOINT_SAFE_OUTPUT_SUFFIX)
    ]
    return json.loads(inner)


@pytest.mark.asyncio
async def test_adapter_emits_safe_tool_message_for_answered_ask() -> None:
    tool = UserQuestionTool()
    context = _context()
    published: list[dict] = []
    ready = asyncio.Event()
    context.metadata[USER_QUESTION_EVENT_SINK_KEY] = _publishing_sink(published, ready)
    adapter = LCToolAdapter(tool, context, None)

    task = asyncio.create_task(
        adapter._arun(question="Which env?", tool_call_id="origin-ask-1")
    )
    await ready.wait()
    tool.resolve_answer("cp-q-20", "session-1", "run-1", "staging")
    output, artifact = await task

    assert artifact is None
    envelope = _safe_output_of(output)
    assert envelope["status"] == "answered"
    assert envelope["answer"] == "staging"
    # The durable body carries no question text and passes the output schema.
    assert "Which env?" not in output.content
    tool.spec.checkpoint_safe_schema.project_output(envelope)


@pytest.mark.asyncio
async def test_adapter_emits_safe_tool_message_for_no_answer_ask() -> None:
    tool = UserQuestionTool()
    context = _context()
    published: list[dict] = []
    context.metadata[USER_QUESTION_EVENT_SINK_KEY] = _publishing_sink(published)
    adapter = LCToolAdapter(tool, context, None)

    output, _artifact = await adapter._arun(
        question="hi?", timeoutSeconds=0.02, tool_call_id="origin-ask-2"
    )
    envelope = _safe_output_of(output)
    assert envelope["status"] == "no_answer"


@pytest.mark.asyncio
async def test_adapter_emits_safe_tool_message_for_refusal_and_error_paths() -> None:
    # 子会话门 → refused envelope rides the safe branch (not the is_error path).
    tool = UserQuestionTool()
    context = _context()
    context.metadata["parentRunId"] = "parent-run-1"
    adapter = LCToolAdapter(tool, context, None)
    output, _ = await adapter._arun(question="Which env?", tool_call_id="origin-ask-3")
    envelope = _safe_output_of(output)
    assert envelope["status"] == "refused"
    assert envelope["code"] == CODE_SUBAGENT_QUESTION_REFUSED

    # INVALID_QUESTION → error envelope on the safe branch too.
    tool2 = UserQuestionTool()
    adapter2 = LCToolAdapter(tool2, _context(), None)
    output2, _ = await adapter2._arun(question="   ", tool_call_id="origin-ask-4")
    envelope2 = _safe_output_of(output2)
    assert envelope2["status"] == "error"
    assert envelope2["code"] == "INVALID_QUESTION"


@pytest.mark.asyncio
async def test_adapter_emits_safe_tool_message_for_approved_request() -> None:
    tool = ApprovalAgentTool(timeout_seconds=1)
    context = _context()
    published: list[dict] = []
    context.metadata["_approval_event_sink"] = _publishing_sink(published)
    adapter = LCToolAdapter(tool, context, None)

    task = asyncio.create_task(
        adapter._arun(action="delete file", tool_call_id="origin-appr-1")
    )
    await _await_until(lambda: len(published) == 1)
    tool.resolve_approval(published[0]["requestId"], True)
    output, artifact = await task

    assert artifact is None
    assert output.additional_kwargs == {
        CHECKPOINT_SAFE_OUTPUT_SCHEMA_KEY: REQUEST_APPROVAL_ENVELOPE_VERSION
    }
    inner = output.content[
        len(CHECKPOINT_SAFE_OUTPUT_PREFIX) : -len(CHECKPOINT_SAFE_OUTPUT_SUFFIX)
    ]
    envelope = json.loads(inner)
    assert envelope["status"] == "approved"
    assert "delete file" not in output.content
    tool.spec.checkpoint_safe_schema.project_output(envelope)
