"""PLAN-0649 M1: refusal/status metadata crosses the run boundary instead of the body.

Contract: `plans/PLAN-0649-XH-tool-result-observability/spec/tool-refusal-observability.md`
§1 (fields/venues) and §2 (invariants I1–I3). The tests here pin the three things M1
promises and nothing more:

- the refusal code is taken from CP's structured envelope and shape-checked;
- `status`/`refusalCode` reach both the durable `tool.result` payload and the
  `tool_result` SSE event, while every body-carrying field keeps the fixed placeholder;
- a malformed/unstructured code degrades to "no code" instead of being repaired.
"""

import json
from unittest.mock import AsyncMock, MagicMock

import pytest
from langchain_core.messages import ToolMessage

from xihe_agent.adapters.sse_adapter import LangGraphEventAdapter
from xihe_agent.agent_runner import tool_adapter as tool_adapter_module
from xihe_agent.agent_runner.tool_adapter import LCToolAdapter
from xihe_agent.interfaces.context import AgentContext
from xihe_agent.interfaces.tool import (
    TOOL_RESULT_REFUSAL_CODE_KEY,
    TOOL_RESULT_STATUS_KEY,
    UNSAFE_DURABLE_TOOL_RESULT_PLACEHOLDER,
    ToolSpec,
    normalize_tool_refusal_code,
    normalize_tool_result_status,
)

REFUSAL_CODE = "DELEGATION_LIMIT_EXCEEDED"
EVENT_WRITER_V2_ENV = tool_adapter_module.EVENT_WRITER_V2_ENV


# --- §2 I3: shape gate ----------------------------------------------------


@pytest.mark.parametrize(
    "value",
    ["DELEGATION_LIMIT_EXCEEDED", "A", "A1_B2", "X" * 64, "SPAWN_EXECUTION_FAILED"],
)
def test_refusal_code_shape_accepts_cp_codes(value):
    assert normalize_tool_refusal_code(value) == value


@pytest.mark.parametrize(
    "value",
    [
        "delegation_limit_exceeded",
        "DELEGATION LIMIT",
        "DELEGATION:LIMIT",
        "DELEGATION_LIMIT\nEXCEEDED",
        "X" * 65,
        "拒绝",
        "1DELEGATION",
        "",
        " DELEGATION_LIMIT_EXCEEDED",
        None,
        123,
        b"DELEGATION_LIMIT_EXCEEDED",
    ],
)
def test_refusal_code_shape_rejects_everything_else(value):
    assert normalize_tool_refusal_code(value) is None


@pytest.mark.parametrize("value", ["completed", "failed"])
def test_result_status_shape_accepts_frozen_values(value):
    assert normalize_tool_result_status(value) == value


@pytest.mark.parametrize("value", ["", "running", "success", "FAILED", None, 1])
def test_result_status_shape_rejects_unknown_values(value):
    assert normalize_tool_result_status(value) is None


# --- adapter: durable payload + returned message ---------------------------


class _Tool:
    """Fake `BaseAgentTool` publishing a fixed result dict."""

    def __init__(self, result: dict, *, needs_call_id: bool = True) -> None:
        self._result = dict(result)
        self._spec = ToolSpec(
            name="spawn_agent",
            description="spawn a child agent",
            input_schema={"type": "object", "properties": {"prompt": {"type": "string"}}},
            requires_originating_tool_call_id=needs_call_id,
        )

    @property
    def spec(self) -> ToolSpec:
        return self._spec

    async def execute(self, input: dict, context: AgentContext) -> dict:
        return dict(self._result)


def _adapter(tool: _Tool) -> tuple[LCToolAdapter, MagicMock]:
    event_store = MagicMock()
    event_store.append = AsyncMock()
    context = AgentContext.empty("session-1")
    context.metadata["runId"] = "run-1"
    return LCToolAdapter(tool, context, event_store), event_store


def _payloads(event_store: MagicMock) -> tuple[dict, dict]:
    events = [call.args[0] for call in event_store.append.await_args_list]
    called = next(event for event in events if event.type == "tool.called")
    result = next(event for event in events if event.type == "tool.result")
    return called.payload, result.payload


@pytest.mark.asyncio
async def test_refusal_metadata_reaches_durable_payload_and_message(monkeypatch):
    monkeypatch.delenv(EVENT_WRITER_V2_ENV, raising=False)
    adapter, event_store = _adapter(
        _Tool({"content": f"Tool error: {REFUSAL_CODE}", "is_error": True, "refusal_code": REFUSAL_CODE})
    )

    content, artifact = await adapter._arun(prompt="child", tool_call_id="call-9")

    _, result_payload = _payloads(event_store)
    # I1: the body channel is byte-identical to today (the fixed placeholder).
    assert result_payload["result"] == UNSAFE_DURABLE_TOOL_RESULT_PLACEHOLDER
    assert result_payload["status"] == "failed"
    assert result_payload["refusalCode"] == REFUSAL_CODE
    assert artifact is None

    assert isinstance(content, ToolMessage)
    assert content.tool_call_id == "call-9"
    assert content.additional_kwargs[TOOL_RESULT_STATUS_KEY] == "failed"
    assert content.additional_kwargs[TOOL_RESULT_REFUSAL_CODE_KEY] == REFUSAL_CODE
    # Model wire is the same untrusted envelope as before; no extra tool body.
    assert "<untrusted-tool-output>" in content.content
    assert REFUSAL_CODE in content.content


@pytest.mark.asyncio
async def test_plain_tool_error_marks_failed_without_inventing_a_code(monkeypatch):
    """An `is_error` without CP's structured code is a failure, not a refusal.

    PLAN-0649 M2 (Lead 2026-11-03 ruling): the durable `status` widens from
    "refusal only" to **every** `is_error` — a failed call is failed whether or
    not CP attached a code, so durable history and the card agree. `refusalCode`
    stays the narrower, CP-decided signal and is never invented from the text
    (spec I2). Legacy gate OFF writes `status` exactly when it is not
    `completed`, so this payload grows the key and nothing else.
    """
    monkeypatch.delenv(EVENT_WRITER_V2_ENV, raising=False)
    adapter, event_store = _adapter(_Tool({"content": "Tool error: something broke", "is_error": True}))

    content, _ = await adapter._arun(prompt="child", tool_call_id="call-9")

    _, result_payload = _payloads(event_store)
    assert "refusalCode" not in result_payload
    assert result_payload["status"] == "failed"
    assert isinstance(content, ToolMessage)
    assert content.additional_kwargs[TOOL_RESULT_STATUS_KEY] == "failed"
    assert TOOL_RESULT_REFUSAL_CODE_KEY not in content.additional_kwargs


@pytest.mark.asyncio
@pytest.mark.parametrize("bad_code", ["delegation_limit_exceeded", "DELEGATION LIMIT", "拒绝", "X" * 65])
async def test_adapter_drops_a_malformed_code_instead_of_repairing_it(monkeypatch, bad_code):
    monkeypatch.delenv(EVENT_WRITER_V2_ENV, raising=False)
    adapter, event_store = _adapter(
        _Tool({"content": "Tool error: whatever", "is_error": True, "refusal_code": bad_code})
    )

    content, _ = await adapter._arun(prompt="child", tool_call_id="call-9")

    _, result_payload = _payloads(event_store)
    assert "refusalCode" not in result_payload
    assert isinstance(content, ToolMessage)
    assert TOOL_RESULT_REFUSAL_CODE_KEY not in content.additional_kwargs


@pytest.mark.asyncio
async def test_successful_call_keeps_legacy_return_shape(monkeypatch):
    monkeypatch.delenv(EVENT_WRITER_V2_ENV, raising=False)
    adapter, event_store = _adapter(_Tool({"content": "child session created"}))

    content, _ = await adapter._arun(prompt="child", tool_call_id="call-9")

    _, result_payload = _payloads(event_store)
    assert result_payload["result"] == UNSAFE_DURABLE_TOOL_RESULT_PLACEHOLDER
    assert "status" not in result_payload  # legacy gate OFF: completed stays unwritten
    assert "refusalCode" not in result_payload
    assert isinstance(content, str)


@pytest.mark.asyncio
async def test_v2_gate_carries_refusal_code(monkeypatch):
    monkeypatch.setenv(EVENT_WRITER_V2_ENV, "1")
    adapter, event_store = _adapter(
        _Tool({"content": f"Tool error: {REFUSAL_CODE}", "is_error": True, "refusal_code": REFUSAL_CODE})
    )

    await adapter._arun(prompt="child", tool_call_id="call-9")

    _, result_payload = _payloads(event_store)
    assert result_payload["schemaVersion"] == 2
    assert result_payload["status"] == "failed"
    assert result_payload["refusalCode"] == REFUSAL_CODE
    assert result_payload["result"] == {
        "preview": UNSAFE_DURABLE_TOOL_RESULT_PLACEHOLDER,
        "truncated": False,
    }


@pytest.mark.asyncio
async def test_refusal_without_originating_call_id_falls_back_to_string(monkeypatch):
    """Fail-closed: no correlation id ⇒ no metadata channel, never a guessed one."""
    monkeypatch.delenv(EVENT_WRITER_V2_ENV, raising=False)
    adapter, event_store = _adapter(
        _Tool(
            {"content": f"Tool error: {REFUSAL_CODE}", "is_error": True, "refusal_code": REFUSAL_CODE},
            needs_call_id=False,
        )
    )

    content, _ = await adapter._arun(prompt="child")

    _, result_payload = _payloads(event_store)
    assert result_payload["refusalCode"] == REFUSAL_CODE
    assert isinstance(content, str)


# --- SSE: the streamed event carries the metadata, never the body ---------


def _translate_tool_end(output: object, *, name: str = "spawn_agent") -> dict:
    adapter = LangGraphEventAdapter()
    event = adapter.translate(
        {
            "event": "on_tool_end",
            "name": name,
            "data": {"output": output},
            "run_id": "run-7",
        }
    )
    assert event is not None
    return event.data


def test_sse_tool_result_publishes_status_and_refusal_code():
    output = ToolMessage(
        content="whatever the tool produced",
        tool_call_id="call-9",
        name="spawn_agent",
        additional_kwargs={
            TOOL_RESULT_STATUS_KEY: "failed",
            TOOL_RESULT_REFUSAL_CODE_KEY: REFUSAL_CODE,
        },
    )

    data = _translate_tool_end(output)

    assert data["result"] == UNSAFE_DURABLE_TOOL_RESULT_PLACEHOLDER
    assert data["status"] == "failed"
    assert data["refusalCode"] == REFUSAL_CODE
    assert json.dumps(data).count(REFUSAL_CODE) == 1  # code appears only as the code


def test_sse_tool_result_without_metadata_keeps_legacy_payload_shape():
    output = ToolMessage(content="body", tool_call_id="call-9", name="read_file")

    data = _translate_tool_end(output, name="read_file")

    assert data["result"] == UNSAFE_DURABLE_TOOL_RESULT_PLACEHOLDER
    assert "status" not in data
    assert "refusalCode" not in data


@pytest.mark.parametrize(
    "metadata",
    [
        {TOOL_RESULT_STATUS_KEY: "exploded", TOOL_RESULT_REFUSAL_CODE_KEY: "bad code"},
        {TOOL_RESULT_STATUS_KEY: "running"},
        {TOOL_RESULT_REFUSAL_CODE_KEY: "lowercase_code"},
        {},
    ],
)
def test_sse_tool_result_drops_malformed_metadata(metadata):
    output = ToolMessage(
        content="body",
        tool_call_id="call-9",
        name="spawn_agent",
        additional_kwargs=dict(metadata),
    )

    data = _translate_tool_end(output)

    assert "status" not in data
    assert "refusalCode" not in data


def test_sse_string_output_carries_no_metadata():
    data = _translate_tool_end("plain tool string output")

    assert data["result"] == UNSAFE_DURABLE_TOOL_RESULT_PLACEHOLDER
    assert "status" not in data
    assert "refusalCode" not in data
