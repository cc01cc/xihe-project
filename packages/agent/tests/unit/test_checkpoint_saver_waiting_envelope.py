"""G3-a 判据 2 / A5 — waiting-run checkpoints persist; the latch stays for others.

checkpoint_saver mechanism is UNCHANGED (draft A5: tests only). These tests prove:
* a waiting AI message (ask_user / request_approval tool call, answer not yet
  arrived) passes the checkpoint projection and reaches the CP PUT — no
  CheckpointUnsafeStateError, no _unsafe_state_seen latch;
* the registration fact from draft §0-2 is explicit: the checkpoint input carries
  the question body (same trust domain as user_questions.prompt), while the
  output envelope ToolMessage never does (判据 4);
* an envelope ToolMessage round-trips through storage in canonical form;
* the negative control: the same-shaped state for a tool WITHOUT a schema still
  trips the latch (判据 2 对照负例 / 判据 8 — the mechanism is not relaxed).
"""

from __future__ import annotations

import base64
import json
from typing import Any
from uuid import uuid4

import pytest
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from langgraph.checkpoint.base import empty_checkpoint

from xihe_agent.adapters.approval_tool import (
    REQUEST_APPROVAL_ENVELOPE_VERSION,
    ApprovalAgentTool,
)
from xihe_agent.adapters.user_question_tool import (
    ASK_USER_ENVELOPE_VERSION,
    UserQuestionTool,
)
from xihe_agent.agent_runner.checkpoint_saver import CpAgentCheckpointSaver
from xihe_agent.interfaces.tool import (
    CHECKPOINT_SAFE_OUTPUT_PREFIX,
    CHECKPOINT_SAFE_OUTPUT_SCHEMA_KEY,
    CHECKPOINT_SAFE_OUTPUT_SUFFIX,
    ToolSpec,
)

ASK_SPEC: ToolSpec = UserQuestionTool().spec
APPROVAL_SPEC: ToolSpec = ApprovalAgentTool().spec

QUESTION_CANARY = "g3a-question-body-canary-7f2d"
ANSWER_CANARY = "g3a-answer-canary-9c41"


def _saver(*, tool_specs: tuple[ToolSpec, ...] = ()) -> CpAgentCheckpointSaver:
    saver = CpAgentCheckpointSaver(
        cp_url="http://cp.invalid",
        service_token="test-token",
        session_id=str(uuid4()),
        user_id=str(uuid4()),
        workspace_id=str(uuid4()),
        tool_specs=tool_specs,
    )
    saver._thread_id = str(uuid4())
    saver._lineage_id = str(uuid4())
    saver._schema_version = 1
    saver._trace_metadata = {
        "lineageId": saver._lineage_id,
        "sourceRunId": None,
        "sessionId": saver._owner["sessionId"],
        "branchId": str(uuid4()),
        "userId": saver._owner["userId"],
        "workspaceId": saver._owner["workspaceId"],
        "stateSchemaVersion": 1,
        "createdAt": "2026-11-18T00:00:00Z",
        "producerVersion": "0.1.0",
    }
    return saver


def _capture_put(monkeypatch: pytest.MonkeyPatch, saver: CpAgentCheckpointSaver) -> list[dict]:
    captured: list[dict] = []

    def capture(method: str, path: str, *, json: dict | None = None, **kwargs: Any):
        captured.append(json)
        return None

    monkeypatch.setattr(saver, "_request_sync", capture)
    return captured


def _waiting_checkpoint(tool_name: str, args: dict, call_id: str, checkpoint_id: str):
    """The LangGraph state after the model step: a pending AI tool call, no result."""
    assistant = AIMessage(
        content="",
        tool_calls=[{"name": tool_name, "args": args, "id": call_id, "type": "tool_call"}],
    )
    checkpoint = empty_checkpoint()
    checkpoint["id"] = checkpoint_id
    checkpoint["channel_values"] = {"messages": [HumanMessage(content="please ask"), assistant]}
    return checkpoint


def _persisted_payload(saver: CpAgentCheckpointSaver, body: dict):
    payload = base64.b64decode(body["payloadBase64"], validate=True)
    return saver.serde.loads_typed((body["payloadType"], payload)), payload


def test_waiting_ask_user_ai_message_persists_without_latching(monkeypatch: pytest.MonkeyPatch) -> None:
    saver = _saver(tool_specs=(ASK_SPEC,))
    captured = _capture_put(monkeypatch, saver)
    checkpoint = _waiting_checkpoint(
        "ask_user",
        {"question": QUESTION_CANARY, "timeoutSeconds": 30},
        "call-ask-waiting",
        "checkpoint-ask-waiting",
    )

    saver.put(
        {"configurable": {"thread_id": saver.thread_id, "checkpoint_ns": ""}},
        checkpoint,
        {"source": "loop", "step": 1},
        {},
    )

    # The waiting checkpoint reached CP: no Unsafe latch, no silent skip.
    assert len(captured) == 1
    assert not saver._unsafe_state_seen.is_set()
    persisted, raw = _persisted_payload(saver, captured[0])
    assert QUESTION_CANARY.encode() in raw  # draft §0-2 登记: input 投影含正文
    assistant = persisted["channel_values"]["messages"][1]
    assert assistant.tool_calls[0]["args"] == {
        "question": QUESTION_CANARY,
        "timeoutSeconds": 30,
    }


def test_waiting_request_approval_ai_message_persists_without_latching(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    saver = _saver(tool_specs=(APPROVAL_SPEC,))
    captured = _capture_put(monkeypatch, saver)
    checkpoint = _waiting_checkpoint(
        "request_approval",
        {"action": "delete file", "details": "README.md"},
        "call-appr-waiting",
        "checkpoint-appr-waiting",
    )

    saver.put(
        {"configurable": {"thread_id": saver.thread_id, "checkpoint_ns": ""}},
        checkpoint,
        {"source": "loop", "step": 1},
        {},
    )

    assert len(captured) == 1
    assert not saver._unsafe_state_seen.is_set()


@pytest.mark.asyncio
async def test_waiting_ask_user_checkpoint_persists_via_async_aput(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The runner's real path is aput — the waiting checkpoint must store there too."""
    saver = _saver(tool_specs=(ASK_SPEC,))
    captured: list[dict] = []

    async def capture(method: str, path: str, *, json: dict | None = None, **kwargs: Any):
        captured.append(json)
        return None

    monkeypatch.setattr(saver, "_arequest", capture)
    checkpoint = _waiting_checkpoint(
        "ask_user",
        {"question": QUESTION_CANARY},
        "call-ask-async",
        "checkpoint-ask-async",
    )

    await saver.aput(
        {"configurable": {"thread_id": saver.thread_id, "checkpoint_ns": ""}},
        checkpoint,
        {"source": "loop", "step": 2},
        {},
    )

    assert len(captured) == 1
    assert not saver._unsafe_state_seen.is_set()


def test_answered_envelope_tool_message_roundtrips_through_storage(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    saver = _saver(tool_specs=(ASK_SPEC, ApprovalAgentTool().spec))
    captured = _capture_put(monkeypatch, saver)
    envelope = {
        "questionId": "cp-q-30",
        "status": "answered",
        "answer": ANSWER_CANARY,
        "code": "",
    }
    assistant = AIMessage(
        content="",
        tool_calls=[
            {"name": "ask_user", "args": {"question": QUESTION_CANARY}, "id": "call-ask-done", "type": "tool_call"}
        ],
    )
    result = ToolMessage(
        content=(
            CHECKPOINT_SAFE_OUTPUT_PREFIX
            + f'{{"answer":"{ANSWER_CANARY}","code":"","questionId":"cp-q-30","status":"answered"}}'
            + CHECKPOINT_SAFE_OUTPUT_SUFFIX
        ),
        tool_call_id="call-ask-done",
        name="ask_user",
        additional_kwargs={CHECKPOINT_SAFE_OUTPUT_SCHEMA_KEY: ASK_USER_ENVELOPE_VERSION},
        status="success",
    )
    checkpoint = empty_checkpoint()
    checkpoint["id"] = "checkpoint-ask-done"
    checkpoint["channel_values"] = {"messages": [assistant, result]}

    saver.put(
        {"configurable": {"thread_id": saver.thread_id, "checkpoint_ns": ""}},
        checkpoint,
        {"source": "loop", "step": 3},
        {},
    )

    assert len(captured) == 1
    assert not saver._unsafe_state_seen.is_set()
    persisted, raw = _persisted_payload(saver, captured[0])
    stored: ToolMessage = persisted["channel_values"]["messages"][1]
    assert stored.additional_kwargs == {
        CHECKPOINT_SAFE_OUTPUT_SCHEMA_KEY: ASK_USER_ENVELOPE_VERSION
    }
    assert stored.status == "success"
    # Canonical form on the way in; the output envelope carries the answer but
    # never the question body (判据 4).
    inner = stored.content[len(CHECKPOINT_SAFE_OUTPUT_PREFIX) : -len(CHECKPOINT_SAFE_OUTPUT_SUFFIX)]
    assert ANSWER_CANARY in inner
    # 判据 4: the question body appears only in the AI-message input args (the
    # registered §0-2 fact); the stored output envelope never carries it.
    assert QUESTION_CANARY not in stored.content
    assert ASK_SPEC.checkpoint_safe_schema.project_output(json.loads(inner)) == envelope


def test_approved_envelope_tool_message_roundtrips_through_storage(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    saver = _saver(tool_specs=(APPROVAL_SPEC,))
    captured = _capture_put(monkeypatch, saver)
    assistant = AIMessage(
        content="",
        tool_calls=[
            {
                "name": "request_approval",
                "args": {"action": "g3a-action-canary"},
                "id": "call-appr-done",
                "type": "tool_call",
            }
        ],
    )
    result = ToolMessage(
        content=(
            CHECKPOINT_SAFE_OUTPUT_PREFIX
            + '{"feedback":"","requestId":"cp-r-30","status":"approved"}'
            + CHECKPOINT_SAFE_OUTPUT_SUFFIX
        ),
        tool_call_id="call-appr-done",
        name="request_approval",
        additional_kwargs={CHECKPOINT_SAFE_OUTPUT_SCHEMA_KEY: REQUEST_APPROVAL_ENVELOPE_VERSION},
        status="success",
    )
    checkpoint = empty_checkpoint()
    checkpoint["id"] = "checkpoint-appr-done"
    checkpoint["channel_values"] = {"messages": [assistant, result]}

    saver.put(
        {"configurable": {"thread_id": saver.thread_id, "checkpoint_ns": ""}},
        checkpoint,
        {"source": "loop", "step": 3},
        {},
    )

    assert len(captured) == 1
    assert not saver._unsafe_state_seen.is_set()
    persisted, _ = _persisted_payload(saver, captured[0])
    stored: ToolMessage = persisted["channel_values"]["messages"][1]
    assert stored.additional_kwargs == {
        CHECKPOINT_SAFE_OUTPUT_SCHEMA_KEY: REQUEST_APPROVAL_ENVELOPE_VERSION
    }


def test_same_shaped_waiting_state_without_schema_still_latches(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """判据 2 对照负例 + 判据 8: the latch mechanism is not relaxed — a
    same-shaped tool call with NO registered schema still trips it."""
    saver = _saver()  # no tool_specs: ask_user is unknown here
    captured = _capture_put(monkeypatch, saver)
    checkpoint = _waiting_checkpoint(
        "ask_user",
        {"question": QUESTION_CANARY},
        "call-ask-unknown",
        "checkpoint-ask-unknown",
    )

    saver.put(
        {"configurable": {"thread_id": saver.thread_id, "checkpoint_ns": ""}},
        checkpoint,
        {"source": "loop", "step": 1},
        {},
    )

    assert captured == []
    assert saver._unsafe_state_seen.is_set()
    # Once latched, later puts are no-ops too (checkpoint_saver.py:316-325).
    saver.put(
        {"configurable": {"thread_id": saver.thread_id, "checkpoint_ns": ""}},
        empty_checkpoint(),
        {"source": "loop", "step": 2},
        {},
    )
    assert captured == []


def test_oversize_question_args_still_persist_as_an_invalid_path(monkeypatch: pytest.MonkeyPatch) -> None:
    """A 2001-char question is a live arg: it must project (and become an
    INVALID_QUESTION envelope in the tool), not trip the latch."""
    saver = _saver(tool_specs=(ASK_SPEC,))
    captured = _capture_put(monkeypatch, saver)
    checkpoint = _waiting_checkpoint(
        "ask_user",
        {"question": "x" * 2001},
        "call-ask-oversize",
        "checkpoint-ask-oversize",
    )

    saver.put(
        {"configurable": {"thread_id": saver.thread_id, "checkpoint_ns": ""}},
        checkpoint,
        {"source": "loop", "step": 1},
        {},
    )

    assert len(captured) == 1
    assert not saver._unsafe_state_seen.is_set()
