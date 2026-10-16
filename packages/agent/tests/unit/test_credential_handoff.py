"""Run-scoped credential delivery stays outside graph and durable state."""

from __future__ import annotations

import json

import pytest
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage

from xihe_agent.adapters.api_chat_model import ApiChatModel
from xihe_agent.agent_runner.credential_handoff import (
    CredentialHandoffError,
    RunScopedCredentialHandoff,
)
from xihe_agent.interfaces.tool import (
    ACQUIRE_CREDENTIAL_TOOL_NAME,
    CREDENTIAL_DELIVERED_PLACEHOLDER,
    CREDENTIAL_HANDOFF_REQUIRED_KEY,
)
from xihe_agent.llm.api_request import chat_type
from xihe_agent.llm.api_sender import NativeResponse

TYPE_IDS = ("openai-chat-completions", "anthropic-messages", "mimo-responses")
CANARY = "credential-canary-0510-stream-redaction"
MODEL_CONTENT = f'<untrusted-tool-output>\n{{"value":"{CANARY}"}}\n</untrusted-tool-output>'


def _model(type_id: str) -> ApiChatModel:
    input_field = "input" if type_id == "mimo-responses" else "messages"
    source = {
        "model": "${xh.model}",
        input_field: ["${xh.conversation_history}", {"role": "user", "content": "${xh.user_input}"}],
        "tools": ["${xh.tools}"],
        "stream": True,
    }
    if type_id == "anthropic-messages":
        source["max_tokens"] = 64
    return ApiChatModel(
        api_type=chat_type(type_id, 1),
        grant={
            "apiTypeId": type_id,
            "apiTypeVersion": 1,
            "operation": "chat",
            "apiKey": "unit-test-only",
            "baseUrl": "https://provider.invalid/v1",
        },
        body_source=json.dumps(source),
        values={
            "model": "fixture",
            "user_input": "question",
            "conversation_history": [],
            "tools": [],
        },
        request_id="handoff-test",
        timeout=1,
    )


def _state() -> list:
    return [
        HumanMessage(content="question"),
        AIMessage(
            content="",
            tool_calls=[
                {
                    "id": "originating-call-id",
                    "name": ACQUIRE_CREDENTIAL_TOOL_NAME,
                    "args": {"credentialId": "credential-id"},
                    "type": "tool_call",
                }
            ],
        ),
        ToolMessage(
            content=CREDENTIAL_DELIVERED_PLACEHOLDER,
            tool_call_id="originating-call-id",
            name=ACQUIRE_CREDENTIAL_TOOL_NAME,
            additional_kwargs={CREDENTIAL_HANDOFF_REQUIRED_KEY: True},
            status="success",
        ),
    ]


def _strings(value):
    if isinstance(value, str):
        return [value]
    if isinstance(value, dict):
        return [part for key, item in value.items() for part in _strings(key) + _strings(item)]
    if isinstance(value, (list, tuple)):
        return [part for item in value for part in _strings(item)]
    return []


@pytest.mark.parametrize("type_id", TYPE_IDS)
def test_each_provider_step_hydrates_a_copy_and_keeps_native_history_safe(type_id: str) -> None:
    handoff = RunScopedCredentialHandoff()
    handoff.store("originating-call-id", MODEL_CONTENT, secret_material={"value": CANARY})
    assert handoff.secrets_for_stream_filter() == (CANARY,)
    model = _model(type_id)
    model.set_credential_handoff(handoff)

    model._dispatch_body([HumanMessage(content="question")])
    state = _state()
    first_step = model._dispatch_body(state)
    next_step = model._dispatch_body([*state, AIMessage(content="continue safely")])

    assert MODEL_CONTENT in _strings(first_step)
    assert MODEL_CONTENT in _strings(next_step)
    assert state[-1].content == CREDENTIAL_DELIVERED_PLACEHOLDER
    assert CANARY not in json.dumps(model._current_suffix)

    model._check_response(NativeResponse(text="safe response", records=[{"type": "message", "text": "safe"}]))
    assert CANARY not in json.dumps(model.native_records)
    assert CREDENTIAL_DELIVERED_PLACEHOLDER in json.dumps(model.native_records)


def test_checkpoint_placeholder_without_this_run_handoff_fails_closed() -> None:
    model = _model(TYPE_IDS[0])
    model.set_credential_handoff(RunScopedCredentialHandoff())
    with pytest.raises(CredentialHandoffError, match="unavailable"):
        model._dispatch_body(_state())


@pytest.mark.asyncio
async def test_streaming_echo_is_redacted_even_when_secret_spans_chunks() -> None:
    handoff = RunScopedCredentialHandoff()
    handoff.store("originating-call-id", MODEL_CONTENT, secret_material={"value": CANARY})
    model = _model(TYPE_IDS[0])
    model.set_credential_handoff(handoff)
    model._dispatch_body([HumanMessage(content="question")])

    async def provider_stream(body):
        assert CANARY in json.dumps(body)
        midpoint = len(CANARY) // 2
        yield "answer before " + CANARY[:midpoint], "", None
        yield (
            CANARY[midpoint:] + " after",
            "",
            NativeResponse(
                text="safe final answer",
                usage={"input_tokens": 0, "output_tokens": 0, "total_tokens": 0},
            ),
        )

    model._sender.stream = provider_stream
    chunks = [chunk async for chunk in model._astream(_state(), run_manager=None)]
    visible = "".join(str(chunk.message.content) for chunk in chunks)

    assert CANARY not in visible
    assert "[credential redacted]" in visible
    assert CANARY not in json.dumps(model.native_records)


def test_response_echo_is_rejected_before_native_history_update() -> None:
    handoff = RunScopedCredentialHandoff()
    handoff.store("originating-call-id", MODEL_CONTENT, secret_material={"value": CANARY})
    model = _model(TYPE_IDS[0])
    model.set_credential_handoff(handoff)

    with pytest.raises(CredentialHandoffError, match="contains credential") as error:
        model._check_response(NativeResponse(text=f"echo {CANARY}"))
    assert CANARY not in str(error.value)
    assert model.native_records == []


def test_secret_scanner_keeps_all_duplicate_sensitive_json_values_without_buffering_object() -> None:
    handoff = RunScopedCredentialHandoff()
    raw = '{"token":"duplicate-secret-first","token":"duplicate-secret-last","description":"ordinary tool output"}'
    handoff.store("originating-call-id", "safe placeholder", secret_material=raw)

    fragments = set(handoff.secrets_for_stream_filter())

    assert fragments == {"duplicate-secret-first", "duplicate-secret-last"}
    assert raw not in fragments
