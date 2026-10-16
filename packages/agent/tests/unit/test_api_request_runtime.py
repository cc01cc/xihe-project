"""Product renderer/sender tests; real ephemeral loopback recorder, no credentials."""

import asyncio
import json
from contextlib import asynccontextmanager

import pytest
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage

from xihe_agent.adapters.api_chat_model import ApiChatModel
from xihe_agent.llm.api_request import ApiRequestError, chat_type, render_request, strict_json, validate_snapshot
from xihe_agent.llm.api_sender import ApiSender

TYPES = ["openai-chat-completions", "anthropic-messages", "mimo-responses"]


def body(type_id, stream=True):
    key = "input" if type_id == "mimo-responses" else "messages"
    value = {
        "model": "${xh.model}",
        key: ["${xh.conversation_history}", {"role": "user", "content": "${xh.user_input}"}],
        "tools": ["${xh.tools}"],
        "stream": stream,
    }
    if type_id == "anthropic-messages":
        value["max_tokens"] = 64
    return value


VALUES = {
    "model": "fixture",
    "user_input": 'quote " slash \\ newline\n${xh.model}',
    "agent_instructions": "",
    "conversation_history": [],
    "tools": [],
}


def grant(type_id, base):
    return {"apiTypeId": type_id, "apiTypeVersion": 1, "operation": "chat", "apiKey": "fixture-only", "baseUrl": base}


@pytest.mark.parametrize("type_id", TYPES)
def test_renderer_escaping_once_and_order(type_id):
    source = json.dumps(body(type_id))
    result = render_request(source, chat_type(type_id, 1), VALUES)
    key = "input" if type_id == "mimo-responses" else "messages"
    assert result[key] == [{"role": "user", "content": VALUES["user_input"]}]
    assert list(result) == list(body(type_id))
    assert json.loads(json.dumps(result))[key] == result[key]


def test_history_native_records_escape_and_repeat():
    history = [
        {"type": "reasoning", "id": "r1", "summary": [], "encrypted_content": "native"},
        {"type": "function_call", "call_id": "c1", "name": "read_file", "arguments": "{}"},
    ]
    source = json.dumps(
        {
            "model": "${xh.model}",
            "input": ["${xh.conversation_history}", "${xh.conversation_history}"],
            "instructions": "$${xh.user_input}|$$${xh.model}|${other.name}|${xhost.name}",
        }
    )
    result = render_request(source, chat_type("mimo-responses", 1), {**VALUES, "conversation_history": history})
    assert result["input"] == history + history
    assert result["instructions"] == "${xh.user_input}|$${xh.model}|${other.name}|${xhost.name}"
    assert history[0]["id"] == "r1"


@pytest.mark.parametrize(
    "source,code",
    [
        ('{"a":1,"a":2}', "DUPLICATE_JSON_KEY"),
        ('{"a":{"x":1,"\\u0078":2}}', "DUPLICATE_JSON_KEY"),
        ('{"${xh.user_input}":1}', "VARIABLE_IN_OBJECT_KEY"),
        ('{"a":"${xh.user_input"}', "MALFORMED_XH_TOKEN"),
        ('{"a":"${xh.${xh.model}}"}', "MALFORMED_XH_TOKEN"),
        ('{"a":"${xh.unknown}"}', "UNKNOWN_VARIABLE"),
        ('{"a":"${xh.tools}"}', "WRONG_VARIABLE_LOCATION"),
        ('{"a":["${xh.conversation_history}"]}', "WRONG_VARIABLE_LOCATION"),
        ('{"messages":[["${xh.conversation_history}"]]}', "WRONG_VARIABLE_LOCATION"),
        ('{"messages":["prefix ${xh.conversation_history}"]}', "WRONG_VARIABLE_LOCATION"),
        ('{"model":"literal"}', "RUNTIME_FIELD_CONFLICT"),
        ('{"tools":[]}', "RUNTIME_FIELD_CONFLICT"),
        ('{"headers":{}}', "RUNTIME_FIELD_CONFLICT"),
        ('{"apiKey":"fixture"}', "RUNTIME_FIELD_CONFLICT"),
        ('{"a":"${xh.model}"}', "WRONG_VARIABLE_LOCATION"),
        ('{"a":NaN}', "INVALID_JSON"),
    ],
)
def test_renderer_rejects_without_sending(source, code):
    with pytest.raises(ApiRequestError, match=code):
        render_request(source, chat_type(TYPES[0], 1), VALUES)


def test_missing_and_wrong_type():
    for values, code in [({}, "MISSING_VARIABLE"), ({"model": []}, "WRONG_VARIABLE_TYPE")]:
        with pytest.raises(ApiRequestError, match=code):
            render_request(json.dumps(body(TYPES[0])), chat_type(TYPES[0], 1), values)


@asynccontextmanager
async def recorder(payload, *, status=200, stream=False, disconnect=False, hold=None):
    captures = []
    handlers = set()

    async def handle(reader, writer):
        task = asyncio.current_task()
        handlers.add(task)
        try:
            raw = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), 3)
            lines = raw.decode().split("\r\n")
            headers = dict(line.lower().split(": ", 1) for line in lines[1:] if ": " in line)
            data = await asyncio.wait_for(reader.readexactly(int(headers["content-length"])), 3)
            captures.append((lines[0], headers, json.loads(data)))
            if hold is not None:
                hold.set()
                await reader.read()
                return
            if disconnect:
                return
            outgoing = payload(len(captures)) if callable(payload) else payload
            content = outgoing.encode() if isinstance(outgoing, str) else json.dumps(outgoing).encode()
            mime = "text/event-stream" if stream else "application/json"
            writer.write(
                f"HTTP/1.1 {status} fixture\r\nContent-Type: {mime}\r\nContent-Length: {len(content)}\r\nConnection: close\r\n\r\n".encode()
                + content
            )
            await writer.drain()
        finally:
            writer.close()
            await writer.wait_closed()
            handlers.discard(task)

    server = await asyncio.start_server(handle, "127.0.0.1", 0)
    try:
        yield f"http://127.0.0.1:{server.sockets[0].getsockname()[1]}/v1", captures
    finally:
        server.close()
        await server.wait_closed()
        for task in list(handlers):
            task.cancel()
        if handlers:
            await asyncio.gather(*list(handlers), return_exceptions=True)


def response(type_id, tool=False):
    if type_id == TYPES[0]:
        message = {"role": "assistant", "content": "answer"}
        if tool:
            message["tool_calls"] = [
                {"id": "c1", "type": "function", "function": {"name": "read_file", "arguments": "{}"}}
            ]
        return {
            "choices": [{"message": message, "finish_reason": "tool_calls" if tool else "stop"}],
            "usage": {"prompt_tokens": 3, "completion_tokens": 2},
        }
    if type_id == TYPES[1]:
        blocks = [
            {"type": "thinking", "thinking": "reason", "signature": "signature"},
            {"type": "text", "text": "answer"},
        ]
        if tool:
            blocks.append({"type": "tool_use", "id": "c1", "name": "read_file", "input": {}})
        return {
            "role": "assistant",
            "content": blocks,
            "stop_reason": "tool_use" if tool else "end_turn",
            "usage": {"input_tokens": 3, "output_tokens": 2},
        }
    output = [
        {"type": "reasoning", "id": "r1", "summary": [], "encrypted_content": "preserve"},
        {"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "answer"}]},
    ]
    if tool:
        output.append({"type": "function_call", "call_id": "c1", "id": "fc1", "name": "read_file", "arguments": "{}"})
    return {"status": "completed", "output": output, "usage": {"input_tokens": 3, "output_tokens": 2}}


def event(kind, value):
    return f"event: {kind}\ndata: {json.dumps({'type': kind, **value})}\n\n"


def sse(type_id):
    if type_id == TYPES[0]:
        return 'data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"answer","tool_calls":[{"index":0,"id":"c1","function":{"name":"read_file","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n'
    if type_id == TYPES[1]:
        return (
            event("message_start", {"message": {"usage": {"input_tokens": 3}}})
            + event(
                "content_block_start",
                {"index": 0, "content_block": {"type": "thinking", "thinking": "", "signature": ""}},
            )
            + event("content_block_delta", {"index": 0, "delta": {"type": "thinking_delta", "thinking": "reason"}})
            + event("content_block_delta", {"index": 0, "delta": {"type": "signature_delta", "signature": "signature"}})
            + event("content_block_stop", {"index": 0})
            + event("content_block_start", {"index": 1, "content_block": {"type": "text", "text": ""}})
            + event("content_block_delta", {"index": 1, "delta": {"type": "text_delta", "text": "answer"}})
            + event("content_block_stop", {"index": 1})
            + event(
                "content_block_start",
                {"index": 2, "content_block": {"type": "tool_use", "id": "c1", "name": "read_file", "input": {}}},
            )
            + event("content_block_delta", {"index": 2, "delta": {"type": "input_json_delta", "partial_json": "{}"}})
            + event("content_block_stop", {"index": 2})
            + event("message_delta", {"delta": {"stop_reason": "tool_use"}, "usage": {"output_tokens": 2}})
            + event("message_stop", {})
        )
    return event("response.output_text.delta", {"delta": "answer"}) + event(
        "response.completed", {"response": response(type_id, True)}
    )


@pytest.mark.parametrize("type_id", TYPES)
@pytest.mark.parametrize("stream", [False, True])
async def test_real_recording_sender_native_response(type_id, stream):
    async with recorder(sse(type_id) if stream else response(type_id, True), stream=stream) as (base, captures):
        sender = ApiSender(chat_type(type_id, 1), grant(type_id, base), "request-1", 3)
        rendered = render_request(json.dumps(body(type_id, stream)), sender.api_type, VALUES)
        parts = [part async for part in sender.stream(rendered)]
        final = parts[-1][2]
        assert final.calls == [{"id": "c1", "name": "read_file", "args": {}, "type": "tool_call"}]
        assert final.text == "answer"
        assert len(captures) == 1
        assert captures[0][0] == f"POST /v1{sender.api_type.path} HTTP/1.1"
        assert captures[0][1]["x-request-id"] == "request-1"
        assert captures[0][2] == rendered
        auth = "x-api-key" if type_id == TYPES[1] else "api-key" if type_id == TYPES[2] else "authorization"
        assert captures[0][1][auth].endswith("fixture-only")
        if type_id == TYPES[1]:
            assert final.records[0]["content"][0]["signature"] == "signature"
        if type_id == TYPES[2]:
            assert final.records[0]["encrypted_content"] == "preserve"


async def test_openai_stream_explicit_null_tool_calls_tolerated():
    """openai-compat providers send `"tool_calls": null` in call-free chunks."""
    payload = (
        'data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"","tool_calls":null}}]}\n\n'
        'data: {"choices":[{"index":0,"delta":{"content":"answer","tool_calls":['
        '{"index":0,"id":"c1","function":{"name":"read_file","arguments":"{}"}}'
        ']},"finish_reason":"tool_calls"}]}\n\n'
        "data: [DONE]\n\n"
    )
    async with recorder(payload, stream=True) as (base, _captures):
        sender = ApiSender(chat_type(TYPES[0], 1), grant(TYPES[0], base), "request-1", 3)
        parts = [
            part
            async for part in sender.stream(
                render_request(json.dumps(body(TYPES[0], True)), sender.api_type, VALUES)
            )
        ]
        final = parts[-1][2]
        assert final.text == "answer"
        assert final.calls == [{"id": "c1", "name": "read_file", "args": {}, "type": "tool_call"}]


async def test_openai_stream_null_role_and_content_keepalive_tolerated():
    """openai-compat keep-alive chunks carry `"role": null, "content": null`."""
    payload = (
        'data: {"choices":[{"index":0,"delta":{"content":null,"role":null}}]}\n\n'
        'data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"answer"},'
        '"finish_reason":"stop"}]}\n\n'
        "data: [DONE]\n\n"
    )
    async with recorder(payload, stream=True) as (base, _captures):
        sender = ApiSender(chat_type(TYPES[0], 1), grant(TYPES[0], base), "request-1", 3)
        parts = [
            part
            async for part in sender.stream(
                render_request(json.dumps(body(TYPES[0], True)), sender.api_type, VALUES)
            )
        ]
        final = parts[-1][2]
        assert final.text == "answer"
        assert final.calls == []


async def test_openai_stream_null_function_fragment_fields_tolerated():
    """Continuation tool-call fragments may repeat `"name": null` and split arguments."""
    payload = (
        'data: {"choices":[{"index":0,"delta":{"role":"assistant","content":null,"tool_calls":['
        '{"index":0,"id":"c1","type":"function","function":{"name":"write_file","arguments":""}}'
        ']}}]}\n\n'
        'data: {"choices":[{"index":0,"delta":{"tool_calls":['
        '{"index":0,"function":{"name":null,"arguments":"{\\"content\\": "}}'
        ']}}]}\n\n'
        'data: {"choices":[{"index":0,"delta":{"tool_calls":['
        '{"index":0,"function":{"name":null,"arguments":"\\"hi\\"}"}}'
        ']},"finish_reason":"tool_calls"}]}\n\n'
        "data: [DONE]\n\n"
    )
    async with recorder(payload, stream=True) as (base, _captures):
        sender = ApiSender(chat_type(TYPES[0], 1), grant(TYPES[0], base), "request-1", 3)
        parts = [
            part
            async for part in sender.stream(
                render_request(json.dumps(body(TYPES[0], True)), sender.api_type, VALUES)
            )
        ]
        final = parts[-1][2]
        assert final.calls == [
            {"id": "c1", "name": "write_file", "args": {"content": "hi"}, "type": "tool_call"}
        ]


async def test_openai_stream_usage_only_chunk_without_choices_tolerated():
    """A final usage chunk may omit `choices` entirely."""
    payload = (
        'data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"answer"},'
        '"finish_reason":"stop"}]}\n\n'
        'data: {"usage":{"prompt_tokens":3,"completion_tokens":2}}\n\n'
        "data: [DONE]\n\n"
    )
    async with recorder(payload, stream=True) as (base, _captures):
        sender = ApiSender(chat_type(TYPES[0], 1), grant(TYPES[0], base), "request-1", 3)
        parts = [
            part
            async for part in sender.stream(
                render_request(json.dumps(body(TYPES[0], True)), sender.api_type, VALUES)
            )
        ]
        final = parts[-1][2]
        assert final.text == "answer"
        assert final.usage == {"input_tokens": 3, "output_tokens": 2, "total_tokens": 5}


async def test_openai_response_explicit_null_tool_calls_tolerated():
    """Non-stream messages may carry `"tool_calls": null` instead of omitting it."""
    payload = response(TYPES[0], tool=False)
    payload["choices"][0]["message"]["tool_calls"] = None
    async with recorder(payload, stream=False) as (base, _captures):
        sender = ApiSender(chat_type(TYPES[0], 1), grant(TYPES[0], base), "request-1", 3)
        parts = [
            part
            async for part in sender.stream(
                render_request(json.dumps(body(TYPES[0], False)), sender.api_type, VALUES)
            )
        ]
        final = parts[-1][2]
        assert final.text == "answer"
        assert final.calls == []


@pytest.mark.parametrize(
    "payload,status,stream,disconnect,code",
    [
        ({"error": "must-never-log-body"}, 401, False, False, "LLM_CREDENTIALS_INVALID"),
        ({"error": "must-never-log-body"}, 500, False, False, "LLM_PROVIDER_UNREACHABLE"),
        ("{broken", 200, False, False, "AGENT_STREAM_FAILED"),
        ("data: invalid\n\n", 200, True, False, "AGENT_STREAM_FAILED"),
        ('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n', 200, True, False, "AGENT_STREAM_FAILED"),
        ("", 200, True, True, "LLM_PROVIDER_UNREACHABLE"),
    ],
)
@pytest.mark.parametrize("type_id", TYPES)
async def test_single_attempt_failures(payload, status, stream, disconnect, code, type_id):
    async with recorder(payload, status=status, stream=stream, disconnect=disconnect) as (base, captures):
        sender = ApiSender(chat_type(type_id, 1), grant(type_id, base), "request-1", 3)
        with pytest.raises(ApiRequestError, match=code) as error:
            _ = [
                part
                async for part in sender.stream(
                    render_request(json.dumps(body(type_id, stream)), sender.api_type, VALUES)
                )
            ]
        assert len(captures) == 1
        assert "must-never-log-body" not in str(error.value)


@pytest.mark.parametrize("type_id", TYPES)
async def test_timeout_and_cancel_never_retry(type_id):
    for cancel in (False, True):
        received = asyncio.Event()
        async with recorder("", hold=received) as (base, captures):
            sender = ApiSender(chat_type(type_id, 1), grant(type_id, base), "request-1", 0.2 if not cancel else 3)

            async def consume():
                return [
                    part
                    async for part in sender.stream(render_request(json.dumps(body(type_id)), sender.api_type, VALUES))
                ]

            task = asyncio.create_task(consume())
            await asyncio.wait_for(received.wait(), 3)
            if cancel:
                task.cancel()
                with pytest.raises(asyncio.CancelledError):
                    await task
            else:
                with pytest.raises(ApiRequestError, match="LLM_PROVIDER_UNREACHABLE"):
                    await task
            assert len(captures) == 1


@pytest.mark.parametrize("type_id", TYPES)
async def test_adapter_base_once_suffix_preserves_native(type_id):
    async with recorder(response(type_id, True)) as (base, captures):
        tool = {"type": "function", "function": {"name": "read_file", "parameters": {"type": "object"}}}
        if type_id == TYPES[1]:
            tool = {"name": "read_file", "input_schema": {"type": "object"}}
        if type_id == TYPES[2]:
            tool = {"type": "function", "name": "read_file", "parameters": {"type": "object"}, "strict": False}
        model = ApiChatModel(
            api_type=chat_type(type_id, 1),
            grant=grant(type_id, base),
            body_source=json.dumps(body(type_id, False)),
            values={**VALUES, "tools": [tool]},
            request_id="request-1",
            timeout=3,
        )
        first = await model.ainvoke([HumanMessage(content=VALUES["user_input"])])
        await model.ainvoke(
            [HumanMessage(content=VALUES["user_input"]), first, ToolMessage(content="tool-result", tool_call_id="c1")]
        )
        key = "input" if type_id == TYPES[2] else "messages"
        assert captures[1][2][key][0] == captures[0][2][key][0]
        assert captures[1][2][key][1:-1] == first.additional_kwargs["nativeRecords"]
        assert len(captures[1][2][key]) == len(first.additional_kwargs["nativeRecords"]) + 2
        assert {k: v for k, v in captures[0][2].items() if k != key} == {
            k: v for k, v in captures[1][2].items() if k != key
        }


async def test_provider_cannot_invent_tool():
    async with recorder(response(TYPES[0], True)) as (base, captures):
        model = ApiChatModel(
            api_type=chat_type(TYPES[0], 1),
            grant=grant(TYPES[0], base),
            body_source=json.dumps(body(TYPES[0], False)),
            values=VALUES,
            request_id="request-1",
            timeout=3,
        )
        with pytest.raises(ApiRequestError, match="TOOL_NOT_AUTHORIZED"):
            await model.ainvoke([HumanMessage(content="hello")])
        assert len(captures) == 1


def snapshot_request(type_id):
    template_id = "11111111-1111-4111-8111-111111111111"
    return {
        "content": "hello",
        "sessionId": "session-fixture",
        "runId": "run-fixture",
        "provider": "fixture-provider",
        "model": "fixture",
        "providerConnectionId": "connection-fixture",
        "connectionRevision": 2,
        "credentialLease": "fixture-only",
        "toolMode": "none",
        # PLAN-0416 T3.1: instructions are CP-owned; the Agent has no fallback.
        "instructions": "Use the CP-selected instructions only.",
        "contextTemplateSnapshot": {
            "layer": "instance",
            "templateId": template_id,
            "version": 1,
            "providerConnectionId": "connection-fixture",
            "connectionRevision": 2,
            "apiTypeId": type_id,
            "apiTypeVersion": 1,
            "connectionKey": "default",
            "connectionScope": "USER",
            "template": {
                "id": template_id,
                "version": 1,
                "name": "fixture",
                "apiTypeId": type_id,
                "apiTypeVersion": 1,
                "bodySource": json.dumps(body(type_id)),
                "status": "published",
            },
        },
    }


@pytest.mark.parametrize("type_id", TYPES)
async def test_chat_route_uses_product_model_and_safe_terminal(monkeypatch, type_id):
    from unittest.mock import AsyncMock

    import httpx

    from xihe_agent.api import chat as route
    from xihe_agent.app_state import CP_API_TOKEN
    from xihe_agent.interfaces.context import AgentContext
    from xihe_agent.main import app

    # Only CP seams are substituted; HTTP sender, model and LangGraph Runner
    # are product implementations, exercised through the actual Chat route.
    retrieval = AsyncMock(side_effect=AssertionError("Default templates must not retrieve"))
    monkeypatch.setattr(route, "retrieve_chat_context", retrieval)
    payload = sse(type_id)
    if type_id == TYPES[0]:
        payload = 'data: {"choices":[{"delta":{"content":"answer"}}]}\n\ndata: [DONE]\n\n'
    if type_id == TYPES[1]:
        payload = (
            event("message_start", {"message": {"usage": {}}})
            + event("content_block_start", {"index": 0, "content_block": {"type": "text", "text": ""}})
            + event("content_block_delta", {"index": 0, "delta": {"type": "text_delta", "text": "answer"}})
            + event("content_block_stop", {"index": 0})
            + event("message_delta", {"delta": {"stop_reason": "end_turn"}})
            + event("message_stop", {})
        )
    if type_id == TYPES[2]:
        payload = event("response.output_text.delta", {"delta": "answer"}) + event(
            "response.completed", {"response": response(type_id)}
        )
    async with recorder(payload, stream=True) as (base, captures):
        lease = AsyncMock(
            return_value={
                **grant(type_id, base),
                "provider": "fixture-provider",
                "model": "fixture",
                "connectionRevision": 2,
            }
        )
        monkeypatch.setattr(route.config_client, "redeem_provider_lease", lease)
        monkeypatch.setattr(
            route.context_provider, "load", AsyncMock(return_value=AgentContext.empty("session-fixture"))
        )
        append = AsyncMock()
        monkeypatch.setattr(route.cp_event_store_client, "append", append)
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://agent-fixture") as client:
            result = await client.post(
                "/internal/v1/agent/chat",
                json=snapshot_request(type_id),
                headers={"Authorization": f"Bearer {CP_API_TOKEN}", "X-Request-Id": "request-fixture"},
            )
        assert result.status_code == 200
        assert '"outcome": "success"' in result.text
        assert result.text.count('"content": "answer"') == 1
        assert "event: error" not in result.text
        lease.assert_awaited_once()
        retrieval.assert_not_awaited()
        assert lease.await_args.kwargs["request_id"] == "request-fixture"
        assert len(captures) == 1
        assert captures[0][2]["model"] == "fixture"
        assert captures[0][1]["x-request-id"] == "request-fixture"
        assert {call.args[0].type for call in append.await_args_list} >= {"prompt.admitted", "assistant.responded"}


@pytest.mark.parametrize(
    "mutate,code",
    [
        (lambda data: data.pop("contextTemplateSnapshot"), "API_TYPE_REBIND_REQUIRED"),
        (lambda data: data.pop("credentialLease"), "API_TYPE_TEMPLATE_MISMATCH"),
        (
            lambda data: data["contextTemplateSnapshot"]["template"].update(bodySource='{"a":1,"a":2}'),
            "CONTEXT_BUILD_FAILED",
        ),
        (lambda data: data["contextTemplateSnapshot"].update(apiTypeVersion=2), "PROVIDER_API_TYPE_UNSUPPORTED"),
        # PLAN-0416 T3.1: instructions are CP-owned; no process fallback.
        (lambda data: data.pop("instructions"), "BASELINE_UNAUTHORIZED"),
        (lambda data: data.update(instructions="   "), "BASELINE_UNAUTHORIZED"),
        (lambda data: data.update(instructions=42), "BASELINE_UNAUTHORIZED"),
    ],
)
async def test_chat_fail_closed_before_lease(monkeypatch, mutate, code):
    from unittest.mock import AsyncMock

    import httpx

    from xihe_agent.api import chat as route
    from xihe_agent.app_state import CP_API_TOKEN
    from xihe_agent.main import app

    lease = AsyncMock()
    monkeypatch.setattr(route.config_client, "redeem_provider_lease", lease)
    data = snapshot_request(TYPES[0])
    mutate(data)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://agent-fixture") as client:
        result = await client.post(
            "/internal/v1/agent/chat", json=data, headers={"Authorization": f"Bearer {CP_API_TOKEN}"}
        )
    assert result.status_code in {400, 409}
    assert result.json()["code"] == code
    lease.assert_not_awaited()


async def test_config_client_preserves_problem_code_and_request_id(httpx_mock):
    from xihe_agent.config_client import ConfigClient, ProviderLeaseError

    httpx_mock.add_response(
        url="http://cp-fixture/internal/v1/provider-leases/redeem",
        status_code=409,
        headers={"Content-Type": "application/problem+json"},
        json={"code": "STALE_PROVIDER_CONNECTION", "detail": "must-never-copy"},
    )
    client = ConfigClient("http://cp-fixture", "fixture-only")
    with pytest.raises(ProviderLeaseError) as error:
        await client.redeem_provider_lease({}, request_id="request-fixture")
    assert error.value.code == "STALE_PROVIDER_CONNECTION"
    assert error.value.status == 409
    assert "must-never-copy" not in str(error.value)
    assert httpx_mock.get_request().headers["X-Request-Id"] == "request-fixture"


def test_repeated_readonly_tools_and_credential_optional_grant():
    fixture = body(TYPES[0])
    fixture["tools"] = ["${xh.tools}", "${xh.tools}"]
    tools = [{"type": "function", "function": {"name": "read_file", "parameters": {"type": "object"}}}]
    result = render_request(json.dumps(fixture), chat_type(TYPES[0], 1), {**VALUES, "tools": tools})
    assert result["tools"] == tools + tools
    sender = ApiSender(
        chat_type(TYPES[0], 1), {**grant(TYPES[0], "http://fixture.invalid/v1"), "apiKey": None}, "request-fixture", 3
    )
    assert "Authorization" not in sender.headers


def test_snapshot_rejects_authority_fields():
    data = snapshot_request(TYPES[0])
    data["agentPrincipalId"] = "must-not-be-accepted"
    with pytest.raises(ApiRequestError, match="INVALID_REQUEST"):
        validate_snapshot(data)


@pytest.mark.parametrize("type_id", TYPES)
@pytest.mark.parametrize("carrier_limit", [80000, 1])
async def test_real_runner_tool_loop_single_execution_and_native_suffix(type_id, carrier_limit):
    from unittest.mock import AsyncMock

    from xihe_agent.adapters.api_chat_model import native_tools
    from xihe_agent.agent_runner import LangGraphRunner
    from xihe_agent.interfaces.agent_runner import RunnerConfig
    from xihe_agent.interfaces.context import AgentContext
    from xihe_agent.interfaces.message import TextMessage
    from xihe_agent.interfaces.tool import ToolSpec

    class ReadTool:
        spec = ToolSpec("read_file", "read fixture", {"type": "object", "properties": {}})
        calls = 0

        async def execute(self, input, context):
            self.calls += 1
            return {"content": "tool-result"}

    tool = ReadTool()
    async with recorder(lambda index: response(type_id, index == 1)) as (base, captures):
        model = ApiChatModel(
            api_type=chat_type(type_id, 1),
            grant=grant(type_id, base),
            body_source=json.dumps(body(type_id, False)),
            values={**VALUES, "tools": native_tools([tool], chat_type(type_id, 1))},
            request_id="request-fixture",
            timeout=3,
        )
        context = AgentContext.empty("session-fixture")
        context.metadata.update(runId="run-fixture")
        store = type("Store", (), {"append": AsyncMock()})()
        runner = LangGraphRunner(model_factory=lambda name: model, event_store=store)
        events = [
            event
            async for event in runner.stream(
                [TextMessage("human", VALUES["user_input"])],
                RunnerConfig(
                    model="fixture",
                    system_prompt="",
                    tools=[tool],
                    context=context,
                    template_context=True,
                    admitted_prompt=VALUES["user_input"],
                    prune_window_chars=carrier_limit,
                ),
            )
        ]
        if carrier_limit == 1:
            assert [event.data["code"] for event in events if event.type == "error"] == ["CONTEXT_BUILD_FAILED"]
            assert not [call for call in store.append.await_args_list if call.args[0].type == "assistant.responded"]
            return
        assert not [event for event in events if event.type == "error"]
        assert tool.calls == 1
        assert len(captures) == 2
        key = "input" if type_id == TYPES[2] else "messages"
        assert captures[1][2][key][0] == captures[0][2][key][0]
        assert len([event for event in events if event.type == "tool_call"]) == 1
        tool_results = [event for event in events if event.type == "tool_result"]
        assert len(tool_results) == 1
        from xihe_agent.interfaces.tool import UNSAFE_DURABLE_TOOL_RESULT_PLACEHOLDER

        assert tool_results[0].data["result"] == UNSAFE_DURABLE_TOOL_RESULT_PLACEHOLDER
        assert "tool-result" not in json.dumps(tool_results[0].data)
        # The active graph turn still gives the real volatile result to the provider.
        assert "tool-result" in json.dumps(captures[1][2][key])
        responded = [
            call.args[0] for call in store.append.await_args_list if call.args[0].type == "assistant.responded"
        ]
        assert len(responded) == 1
        carrier = responded[0].payload["message"]
        assert carrier["apiTypeId"] == type_id
        assert carrier["apiTypeVersion"] == 1
        carrier_json = json.dumps(carrier["nativeRecords"])
        assert "tool-result" not in carrier_json
        assert UNSAFE_DURABLE_TOOL_RESULT_PLACEHOLDER in carrier_json
        from xihe_agent.adapters.api_chat_model import native_history
        from xihe_agent.interfaces.context import message_from_dict

        history = native_history([TextMessage("human", "first"), message_from_dict(carrier)], chat_type(type_id, 1))
        assert history[1:] == carrier["nativeRecords"]
        next_model = ApiChatModel(
            api_type=chat_type(type_id, 1),
            grant=grant(type_id, base),
            body_source=json.dumps(body(type_id, False)),
            values={**VALUES, "conversation_history": history},
            request_id="next-run",
            timeout=3,
        )
        await next_model.ainvoke([HumanMessage(content="next")])
        assert captures[-1][2][key][:-1] == history
        assert (
            native_history(
                AgentContext.from_snapshot({"aggregate_id": "session", "messages": [carrier]}).messages,
                chat_type(type_id, 1),
            )
            == carrier["nativeRecords"]
        )
        assert captures[1][2][key][1:-1] == (
            response(type_id, True)["output"]
            if type_id == TYPES[2]
            else [{"role": "assistant", "content": response(type_id, True)["content"]}]
            if type_id == TYPES[1]
            else [response(type_id, True)["choices"][0]["message"]]
        )


@pytest.mark.parametrize("type_id", TYPES)
def test_durable_native_bounds_type_mismatch_and_oversize(type_id):
    from xihe_agent.adapters.api_chat_model import durable_native_carrier, native_history
    from xihe_agent.interfaces.context import compact_json, message_from_dict
    from xihe_agent.llm.api_sender import parse_response

    model = ApiChatModel(
        api_type=chat_type(type_id, 1),
        grant=grant(type_id, "http://fixture.invalid/v1"),
        body_source=json.dumps(body(type_id, False)),
        values=VALUES,
        request_id="fixture",
        timeout=3,
    )
    model._native_turns = parse_response(response(type_id, True), model.api_type).records
    record = model._native_turns[-1]
    huge = {"text": "x" * 9000}
    if type_id == TYPES[0]:
        record["tool_calls"][0]["function"]["arguments"] = compact_json(huge)
    elif type_id == TYPES[1]:
        record["content"][-1]["input"] = huge
    else:
        record["arguments"] = compact_json(huge)
    carrier = durable_native_carrier(model, 80000)
    if type_id == TYPES[0]:
        bounded = strict_json(carrier["nativeRecords"][-1]["tool_calls"][0]["function"]["arguments"])
    elif type_id == TYPES[1]:
        bounded = carrier["nativeRecords"][-1]["content"][-1]["input"]
        assert carrier["nativeRecords"][0]["content"][0] == model.native_records[0]["content"][0]
    else:
        bounded = strict_json(carrier["nativeRecords"][-1]["arguments"])
    assert bounded["__xihe_truncated__"] is True
    assert len(compact_json(bounded)) <= 4096
    message = message_from_dict({"role": "ai", "content": "final", **carrier})
    with pytest.raises(ApiRequestError, match="API_TYPE_TEMPLATE_MISMATCH"):
        native_history([message], chat_type(TYPES[(TYPES.index(type_id) + 1) % 3], 1))
    with pytest.raises(ApiRequestError, match="CONTEXT_BUILD_FAILED"):
        durable_native_carrier(model, 1)


@pytest.mark.parametrize("type_id", TYPES)
def test_durable_native_carrier_masks_acquire_credential_output(type_id):
    """PLAN-0497 I5 (wave review): the durable replay carrier must never carry the
    delivered credential value — acquire_credential outputs keep their dedicated
    placeholder and all other tool outputs are withheld across API-type families."""
    from xihe_agent.adapters.api_chat_model import durable_native_carrier
    from xihe_agent.interfaces.tool import CREDENTIAL_DELIVERED_PLACEHOLDER, UNSAFE_DURABLE_TOOL_RESULT_PLACEHOLDER

    secret = "e2e-acquire-secret-1791901753580-ab12cd34"
    acquire_call = {"type": "function", "id": "a1", "function": {"name": "acquire_credential", "arguments": '{"credentialId":"x"}'}}
    read_call = {"type": "function", "id": "b1", "function": {"name": "read_file", "arguments": "{}"}}
    if type_id == TYPES[0]:
        records = [
            {"role": "assistant", "content": None, "tool_calls": [acquire_call, read_call]},
            {"role": "tool", "tool_call_id": "a1", "content": secret},
            {"role": "tool", "tool_call_id": "b1", "content": "plain-tool-output"},
        ]
    elif type_id == TYPES[1]:
        records = [
            {
                "role": "assistant",
                "content": [
                    {"type": "tool_use", "id": "a1", "name": "acquire_credential", "input": {}},
                    {"type": "tool_use", "id": "b1", "name": "read_file", "input": {}},
                ],
            },
            {
                "role": "user",
                "content": [
                    {"type": "tool_result", "tool_use_id": "a1", "content": secret},
                    {"type": "tool_result", "tool_use_id": "b1", "content": "plain-tool-output"},
                ],
            },
        ]
    else:
        records = [
            {"type": "function_call", "call_id": "a1", "name": "acquire_credential", "arguments": "{}"},
            {"type": "function_call", "call_id": "b1", "name": "read_file", "arguments": "{}"},
            {"type": "function_call_output", "call_id": "a1", "output": secret},
            {"type": "function_call_output", "call_id": "b1", "output": "plain-tool-output"},
        ]

    model = ApiChatModel(
        api_type=chat_type(type_id, 1),
        grant=grant(type_id, "http://fixture.invalid/v1"),
        body_source=json.dumps(body(type_id, False)),
        values=VALUES,
        request_id="fixture",
        timeout=3,
    )
    model._native_turns = records
    carrier = durable_native_carrier(model, 80000)
    serialized = json.dumps(carrier["nativeRecords"])
    assert secret not in serialized
    assert CREDENTIAL_DELIVERED_PLACEHOLDER in serialized
    assert "plain-tool-output" not in serialized
    assert UNSAFE_DURABLE_TOOL_RESULT_PLACEHOLDER in serialized


def test_native_replay_fork_prune_compaction_atomic():
    import hashlib
    from datetime import UTC, datetime

    from xihe_agent.agent_runner.langgraph_runner import prune_history_tool_results
    from xihe_agent.interfaces.context import AgentContext
    from xihe_agent.interfaces.event import Event
    from xihe_agent.interfaces.message import TextMessage

    records = [
        {"role": "assistant", "content": "final"},
        {"role": "tool", "tool_call_id": "native", "content": "secret-tool"},
    ]
    carrier = {"role": "ai", "content": "final", "apiTypeId": TYPES[0], "apiTypeVersion": 1, "nativeRecords": records}
    context = AgentContext.empty("session")

    def event(kind, payload, run="run-one"):
        return Event("session", context.latest_sequence + 1, kind, payload, datetime.now(UTC), correlation_id=run)

    context.apply_event(event("prompt.admitted", {"message": {"role": "human", "content": "first"}}))
    context.apply_event(event("tool.called", {"call_id": "callback", "tool_name": "read"}))
    context.apply_event(event("tool.result", {"call_id": "callback", "result": "secret-tool"}))
    context.apply_event(event("assistant.responded", {"message": carrier}))
    assert [message.role for message in context.messages] == ["human", "ai"]
    snapshot = context.to_snapshot()
    context.apply_event(
        event("context.prune", {"tombstones": [{"content_hash": hashlib.sha256(b"secret-tool").hexdigest()}]})
    )
    assert [message.role for message in context.messages] == ["human"]
    forked = AgentContext.empty("child")
    forked.apply_event(
        event("session.forked", {"summary_seed": {"messages": snapshot["messages"], "contextEpoch": "child"}})
    )
    assert forked.to_snapshot()["messages"] == snapshot["messages"]
    forked.apply_event(event("context.prune", {"tombstones": [{"content_hash": hashlib.sha256(b"final").hexdigest()}]}))
    assert [message.role for message in forked.messages] == ["human"]
    restored = AgentContext.from_snapshot(snapshot)
    restored.messages.extend(TextMessage("human", str(index)) for index in range(12))
    pruned = prune_history_tool_results(restored.messages, prune_window_chars=1)
    assert not any(getattr(message, "native_records", None) is not None for message in pruned.messages)
    assert pruned.tombstones[0].content_hash == hashlib.sha256(b"final").hexdigest()
    restored.apply_event(event("compaction.applied", {"summary": "compact", "summaryHash": "hash"}))
    assert not any(getattr(message, "native_records", None) is not None for message in restored.messages)


@pytest.mark.parametrize(
    "carrier", [{"apiTypeId": TYPES[0]}, {"apiTypeId": TYPES[0], "apiTypeVersion": True, "nativeRecords": []}]
)
def test_native_carrier_partial_fields_rejected(carrier):
    from xihe_agent.interfaces.context import message_from_dict

    with pytest.raises(ValueError, match="native history"):
        message_from_dict({"role": "ai", "content": "final", **carrier})


# --- PLAN-0416 T2.3: native-body budget estimate + provider usage truth ---


def _tool(type_id):
    tool = {"type": "function", "function": {"name": "read_file", "parameters": {"type": "object"}}}
    if type_id == TYPES[1]:
        tool = {"name": "read_file", "input_schema": {"type": "object"}}
    if type_id == TYPES[2]:
        tool = {"type": "function", "name": "read_file", "parameters": {"type": "object"}, "strict": False}
    return tool


def test_native_body_estimate_covers_more_than_the_prompt():
    from xihe_agent.app_state import _estimate_native_body_tokens

    prompt_only = {"model": "m", "messages": [{"role": "user", "content": "hello"}]}
    full = {
        **prompt_only,
        "tools": [
            {
                "type": "function",
                "function": {"name": "read_file", "description": "x" * 400, "parameters": {"type": "object"}},
            }
        ],
    }
    assert _estimate_native_body_tokens(prompt_only) > 0
    assert _estimate_native_body_tokens(full) > _estimate_native_body_tokens(prompt_only)


@pytest.mark.parametrize("type_id", TYPES)
async def test_estimate_is_taken_per_dispatched_step_and_aggregated(type_id):
    from xihe_agent.app_state import _estimate_native_body_tokens

    async with recorder(response(type_id, True)) as (base, captures):
        model = ApiChatModel(
            api_type=chat_type(type_id, 1),
            grant=grant(type_id, base),
            body_source=json.dumps(body(type_id, False)),
            values={**VALUES, "tools": [_tool(type_id)]},
            request_id="request-1",
            timeout=3,
            token_estimator=_estimate_native_body_tokens,
        )
        first = await model.ainvoke([HumanMessage(content=VALUES["user_input"])])
        await model.ainvoke(
            [HumanMessage(content=VALUES["user_input"]), first, ToolMessage(content="tool-result", tool_call_id="c1")]
        )

    assert model.estimated_step_count == 2
    # Each step's estimate is the body that actually went on the wire.
    step_estimates = [_estimate_native_body_tokens(captured[2]) for captured in captures]
    assert model.estimated_input_tokens == sum(step_estimates)
    assert model.estimated_input_tokens > 0


@pytest.mark.parametrize("type_id", TYPES)
async def test_provider_usage_truth_keeps_absent_counters_unknown(type_id):
    async with recorder(response(type_id, True)) as (base, _captures):
        model = ApiChatModel(
            api_type=chat_type(type_id, 1),
            grant=grant(type_id, base),
            body_source=json.dumps(body(type_id, False)),
            values={**VALUES, "tools": [_tool(type_id)]},
            request_id="request-1",
            timeout=3,
        )
        await model.ainvoke([HumanMessage(content=VALUES["user_input"])])

    assert model.provider_reported == {"input_tokens", "output_tokens"}
    # No provider reported a cache counter, so it is unknown - not a zero.
    assert model.provider_unknown == {"cache_read_input_tokens"}
    assert model.provider_usage_totals == {"input_tokens": 3, "output_tokens": 2}


async def test_absent_provider_usage_is_all_unknown_not_zero():
    payload = dict(response(TYPES[0], False))
    payload.pop("usage")
    async with recorder(payload) as (base, _captures):
        model = ApiChatModel(
            api_type=chat_type(TYPES[0], 1),
            grant=grant(TYPES[0], base),
            body_source=json.dumps(body(TYPES[0], False)),
            values=VALUES,
            request_id="request-1",
            timeout=3,
        )
        await model.ainvoke([HumanMessage(content="hello")])

    assert model.provider_reported == set()
    assert model.provider_usage_totals == {}
    assert model.provider_unknown == {"input_tokens", "output_tokens", "cache_read_input_tokens"}


async def test_usage_wire_separates_estimate_from_provider_counters():
    from xihe_agent.api.chat import _apply_provider_usage

    payload = dict(response(TYPES[1], False))
    payload["usage"] = {"input_tokens": 7, "output_tokens": 4, "cache_read_input_tokens": 5}
    async with recorder(payload) as (base, _captures):
        model = ApiChatModel(
            api_type=chat_type(TYPES[1], 1),
            grant=grant(TYPES[1], base),
            body_source=json.dumps(body(TYPES[1], False)),
            values=VALUES,
            request_id="request-1",
            timeout=3,
            token_estimator=lambda _body: 1234,
        )
        await model.ainvoke([HumanMessage(content="hello")])
    assert model.estimated_input_tokens == 1234

    usage = {
        "inputTokens": 0,
        "outputTokens": 0,
        "totalTokens": 0,
        "source": "real",
        "estimatedInputTokens": 1234,
    }
    _apply_provider_usage(usage, model)
    assert usage["estimatedInputTokens"] == 1234
    assert usage["inputTokens"] == 7
    assert usage["outputTokens"] == 4
    assert usage["totalTokens"] == 11
    assert usage["cacheReadInputTokens"] == 5
    assert usage["source"] == "real"
    assert "providerUnknownFields" not in usage

    # A counter the provider never returned must be dropped, not published as 0.
    payload = dict(response(TYPES[0], False))
    payload.pop("usage")
    unreported = {
        "inputTokens": 0,
        "outputTokens": 0,
        "totalTokens": 0,
        "source": "real",
        "estimatedInputTokens": 9,
    }
    async with recorder(payload) as (base, _captures):
        empty_model = ApiChatModel(
            api_type=chat_type(TYPES[0], 1),
            grant=grant(TYPES[0], base),
            body_source=json.dumps(body(TYPES[0], False)),
            values=VALUES,
            request_id="request-1",
            timeout=3,
            token_estimator=lambda _body: 9,
        )
        await empty_model.ainvoke([HumanMessage(content="hello")])
    _apply_provider_usage(unreported, empty_model)
    assert "inputTokens" not in unreported
    assert "outputTokens" not in unreported
    assert "totalTokens" not in unreported
    assert unreported["providerUnknownFields"] == ["cache_read_input_tokens", "input_tokens", "output_tokens"]
    assert unreported["source"] == "estimated"
    assert unreported["estimatedInputTokens"] == 9
