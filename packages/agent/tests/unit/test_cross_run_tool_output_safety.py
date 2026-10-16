from __future__ import annotations

import json

import pytest
from langchain_core.messages import ToolMessage

from xihe_agent.adapters.api_chat_model import native_history, native_message
from xihe_agent.adapters.sse_adapter import LangGraphEventAdapter
from xihe_agent.agent_runner.tool_adapter import LCToolAdapter
from xihe_agent.context.event_sourced_provider import EventSourcedContextProvider
from xihe_agent.context.loop_detection import LOOP_WINDOW_KEY, LoopObservationWindow, LoopThresholds, LoopVerdict
from xihe_agent.interfaces.chat_run_context import ChatRunContext
from xihe_agent.interfaces.context import AgentContext
from xihe_agent.interfaces.message import TextMessage
from xihe_agent.interfaces.tool import (
    CREDENTIAL_DELIVERED_PLACEHOLDER,
    UNSAFE_DURABLE_TOOL_RESULT_PLACEHOLDER,
    ToolSpec,
)
from xihe_agent.llm.api_request import ChatApiType

CANARY = "cross-run-tool-output-canary"


def _native_records(api_type_id: str) -> list[dict]:
    if api_type_id == "openai-chat-completions":
        return [
            {
                "role": "assistant",
                "content": None,
                "tool_calls": [
                    {"type": "function", "id": "call-1", "function": {"name": "read_file", "arguments": "{}"}}
                ],
            },
            {"role": "tool", "tool_call_id": "call-1", "content": CANARY},
        ]
    if api_type_id == "anthropic-messages":
        return [
            {"role": "assistant", "content": [{"type": "tool_use", "id": "call-1", "name": "read_file", "input": {}}]},
            {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "call-1", "content": CANARY}]},
        ]
    return [
        {"type": "function_call", "call_id": "call-1", "name": "read_file", "arguments": "{}"},
        {"type": "function_call_output", "call_id": "call-1", "output": CANARY},
    ]


@pytest.mark.parametrize(
    "api_type_id",
    ["openai-chat-completions", "anthropic-messages", "mimo-responses"],
)
def test_historical_native_outputs_are_masked_but_current_run_tool_message_is_unchanged(
    api_type_id: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    import sys
    import types

    # native_history imports this converter lazily; the test only exercises its
    # durable-carrier branch, so avoid loading the unrelated LiteLLM runtime.
    runner_module = types.ModuleType("xihe_agent.agent_runner.langgraph_runner")
    runner_module.to_langchain_messages = lambda _messages: []
    monkeypatch.setitem(sys.modules, "xihe_agent.agent_runner.langgraph_runner", runner_module)
    api_type = ChatApiType(api_type_id, "/fixture", "messages")
    carrier = {
        "role": "ai",
        "content": "done",
        "apiTypeId": api_type_id,
        "apiTypeVersion": 1,
        "nativeRecords": _native_records(api_type_id),
    }
    historical = native_history(
        [
            TextMessage(
                "ai",
                "done",
                api_type_id=api_type_id,
                api_type_version=1,
                native_records=tuple(carrier["nativeRecords"]),
            )
        ],
        api_type,
    )
    assert CANARY not in json.dumps(historical)
    assert UNSAFE_DURABLE_TOOL_RESULT_PLACEHOLDER in json.dumps(historical)

    # This converter is also used for a ToolMessage produced inside the active
    # graph step. That same-Run handoff must retain its actual content.
    current = native_message(ToolMessage(content=CANARY, tool_call_id="call-1"), api_type)
    assert CANARY in json.dumps(current)


class _SnapshotClient:
    def __init__(self, snapshot: dict) -> None:
        self.snapshot = snapshot

    async def get_context_snapshot(self, *_args, **_kwargs):
        return self.snapshot


def test_event_sourced_context_and_tool_history_builder_mask_legacy_preview() -> None:
    snapshot = {
        "aggregate_id": "session",
        "messages": [
            {
                "role": "ai",
                "content": "",
                "tool_calls": [{"call_id": "call-1", "tool_name": "read_file", "arguments": {}}],
            },
            {
                "role": "tool",
                "content": CANARY,
                "tool_call_id": "call-1",
                "tool_name": "read_file",
                "status": "failed",
                "truncated": True,
                "artifact_ref": "artifact-" + CANARY,
                "error_code": CANARY,
            },
        ],
    }
    context = _run_immediate(EventSourcedContextProvider(_SnapshotClient(snapshot)).load("session", run_id="run"))
    assert CANARY not in json.dumps([message.content for message in context.messages])
    assert context.messages[1].content == UNSAFE_DURABLE_TOOL_RESULT_PLACEHOLDER
    assert context.messages[1].artifact_ref == ""
    assert context.messages[1].error_code == ""

    instance_id = "61e3d9d0-71c7-4b53-9e55-6ca4211ed67c"
    template_id = "b441b5da-f94a-4d3d-bb76-67a55da8c647"
    run = ChatRunContext.from_request(
        {
            "runId": "run",
            "sessionId": "session",
            "requestId": "request",
            "instructions": "",
            "platformInstructions": "",
            "contextTemplateSnapshot": {
                "layer": "workspace",
                "templateId": template_id,
                "version": 1,
                "template": {
                    "id": template_id,
                    "version": 1,
                    "document": "{{component:" + instance_id + "}}",
                    "components": [
                        {
                            "instanceId": instance_id,
                            "type": "tool_history",
                            "config": {
                                "selection": "all_within_budget",
                                "maxTokens": 1000,
                                "resultMode": "preview",
                                "includeFailedCalls": True,
                                "parameterPolicy": "approved_redaction",
                            },
                        }
                    ],
                },
            },
        },
        context,
    )
    from xihe_agent.context.builder import _render

    component = run.template_snapshot["template"]["components"][0]
    _component_result, history = _render(component, run, [], token_counter=None)
    assert CANARY not in json.dumps([message.content for message in history])
    assert UNSAFE_DURABLE_TOOL_RESULT_PLACEHOLDER in json.dumps([message.content for message in history])


class _EventStore:
    def __init__(self) -> None:
        self.events = []

    async def append(self, event):
        self.events.append(event)
        return event


class _BrokenTool:
    spec = ToolSpec("unsafe_lookup", "test", {"type": "object", "properties": {}})

    async def execute(self, _input, _context):
        raise ValueError(CANARY)


def _run_immediate(awaitable):
    try:
        awaitable.send(None)
    except StopIteration as completed:
        return completed.value
    raise AssertionError("tool adapter attempted asynchronous I/O")


def test_tool_failure_persists_placeholder_and_does_not_log_or_raise_exception_text() -> None:
    store = _EventStore()
    adapter = LCToolAdapter(_BrokenTool(), AgentContext.empty("session"), store)

    with pytest.raises(RuntimeError) as failure:
        _run_immediate(adapter._arun())

    assert CANARY not in str(failure.value)
    assert failure.value.__cause__ is None
    result = next(event for event in store.events if event.type == "tool.result")
    assert CANARY not in json.dumps(result.payload)
    assert result.payload["result"] == UNSAFE_DURABLE_TOOL_RESULT_PLACEHOLDER
    assert result.payload["status"] == "failed"


def test_precheck_refusal_keeps_current_message_but_persists_only_placeholder() -> None:
    store = _EventStore()
    context = AgentContext.empty("session")
    window = LoopObservationWindow(
        LoopThresholds(repeat_warn=1, repeat_refuse=1, repeat_escalate=2), exempt_tools=set()
    )
    window.pre_check = lambda *_args: LoopVerdict(level="refuse", signal="repeat", message=CANARY)
    context.metadata[LOOP_WINDOW_KEY] = window
    adapter = LCToolAdapter(_BrokenTool(), context, store)

    output, _ = _run_immediate(adapter._arun())

    assert CANARY in output
    result = next(event for event in store.events if event.type == "tool.result")
    assert CANARY not in json.dumps(result.payload)
    assert result.payload["result"] == UNSAFE_DURABLE_TOOL_RESULT_PLACEHOLDER
    assert result.payload["status"] == "failed"


def test_public_tool_result_sse_masks_result_and_diagnostics() -> None:
    event = LangGraphEventAdapter().translate(
        {
            "event": "on_tool_end",
            "name": "read_file",
            "run_id": "tool-run",
            "data": {
                "output": ToolMessage(
                    content=CANARY,
                    tool_call_id="provider-call",
                    artifact={"diagnostics": {"items": [{"message": CANARY}]}},
                )
            },
        }
    )
    assert event is not None
    assert event.type == "tool_result"
    assert event.data["result"] == UNSAFE_DURABLE_TOOL_RESULT_PLACEHOLDER
    assert "diagnostics" not in event.data
    assert CANARY not in json.dumps(event.data)


def test_credential_history_keeps_only_fixed_credential_placeholder() -> None:
    messages = [TextMessage("tool", CANARY, tool_name="acquire_credential")]
    from xihe_agent.interfaces.history_safety import mask_historical_messages

    masked = mask_historical_messages(messages)
    assert masked[0].content == CREDENTIAL_DELIVERED_PLACEHOLDER
    assert CANARY not in masked[0].content
