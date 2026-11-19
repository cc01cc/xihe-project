"""task-27 / Q-45: CONTEXT_OVERFLOW must be reachable through the real chain.

The card forbids a "point patch" proof: the test drives the real ``ApiSender``
against a real loopback HTTP server that answers with the provider's own error
body, through the real ``ApiChatModel``, into the real ``LangGraphRunner``, and
asserts the *terminal* event the CP consumes. Nothing here mocks the classifier:
if the classification were still ``status == 400 -> LLM_REQUEST_REJECTED``, the
first test fails on the code, not on a helper's return value.
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

import pytest
from langchain_core.messages import HumanMessage

import xihe_agent.agent_runner.langgraph_runner as langgraph_runner_module
from xihe_agent.adapters.api_chat_model import ApiChatModel
from xihe_agent.agent_runner import LangGraphRunner
from xihe_agent.interfaces.agent_runner import RunnerConfig
from xihe_agent.interfaces.context import AgentContext
from xihe_agent.interfaces.message import TextMessage
from xihe_agent.llm.api_request import chat_type

OVERFLOW_BODY = {
    "error": {
        "message": "This model's maximum context length is 8192 tokens, however your messages resulted in 2400 tokens.",
        "type": "invalid_request_error",
        "param": "messages",
        "code": "context_length_exceeded",
    }
}

REJECTED_BODY = {
    "error": {
        "message": "Invalid value for 'temperature': 3",
        "type": "invalid_request_error",
        "param": "temperature",
        "code": "invalid_value",
    }
}

TRUNCATED_BODY = {
    "choices": [{"message": {"role": "assistant", "content": ""}, "finish_reason": "length"}],
    "usage": {"prompt_tokens": 1048570, "completion_tokens": 0},
}

VALUES = {
    "model": "fixture",
    "user_input": "hello",
    "agent_instructions": "",
    "conversation_history": [],
    "tools": [],
}


def _grant(base: str) -> dict:
    return {
        "apiTypeId": "openai-chat-completions",
        "apiTypeVersion": 1,
        "operation": "chat",
        "apiKey": "fixture-only",
        "baseUrl": base,
        "toolsSupported": True,
        "visionSupported": True,
    }


def _body_source() -> str:
    return json.dumps(
        {
            "model": "${xh.model}",
            "messages": ["${xh.conversation_history}", {"role": "user", "content": "${xh.user_input}"}],
            "stream": False,
        }
    )


@asynccontextmanager
async def provider(status: int, payload: dict) -> AsyncIterator[str]:
    """A one-answer loopback provider; yields its base URL."""
    raw = json.dumps(payload).encode()
    captured: list[bytes] = []

    async def handle(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        request = await reader.readuntil(b"\r\n\r\n")
        length = 0
        for line in request.split(b"\r\n"):
            if line.lower().startswith(b"content-length:"):
                length = int(line.split(b":", 1)[1])
        if length:
            captured.append(await reader.readexactly(length))
        writer.write(
            b"HTTP/1.1 " + str(status).encode() + b" ERROR\r\n"
            b"content-type: application/json\r\n"
            b"content-length: " + str(len(raw)).encode() + b"\r\n"
            b"connection: close\r\n\r\n" + raw
        )
        await writer.drain()
        writer.close()

    server = await asyncio.start_server(handle, "127.0.0.1", 0)
    port = server.sockets[0].getsockname()[1]
    try:
        # The sender requires the grant's base URL to end in /v1 (the API path is
        # appended by the renderer); the recorder is path-agnostic.
        yield f"http://127.0.0.1:{port}/v1"
    finally:
        server.close()
        await server.wait_closed()


def _model(base: str) -> ApiChatModel:
    return ApiChatModel(
        api_type=chat_type("openai-chat-completions", 1),
        grant=_grant(base),
        body_source=_body_source(),
        values=VALUES,
        request_id="request-overflow",
        timeout=3,
    )


async def _run_to_terminal(monkeypatch: pytest.MonkeyPatch, model: ApiChatModel) -> list:
    """Drive the real runner; the fake graph only calls the model like a real node would."""

    class CallingAgent:
        async def astream_events(self, _inputs, version, **_kwargs):
            assert version == "v2"
            await model.ainvoke([HumanMessage(content="hello")])
            if False:  # pragma: no cover - keeps this an async generator
                yield {}

    monkeypatch.setattr(
        langgraph_runner_module, "build_react_graph", lambda _model, tools, **_kwargs: CallingAgent()
    )
    runner = LangGraphRunner(model_factory=lambda _name: model)
    events = []
    async for event in runner.stream(
        [TextMessage(role="human", content="hello")],
        RunnerConfig(model="fixture", system_prompt="fixture", tools=[], context=AgentContext.empty("session-fixture")),
    ):
        events.append(event)
    return events


async def test_provider_overflow_body_becomes_the_terminal_overflow_event(monkeypatch):
    async with provider(400, OVERFLOW_BODY) as base:
        events = await _run_to_terminal(monkeypatch, _model(base))
    errors = [event for event in events if event.type == "error"]
    assert len(errors) == 1
    assert errors[0].data["code"] == "CONTEXT_OVERFLOW"
    assert errors[0].data["retryable"] is True
    assert errors[0].data["error"] == "CONTEXT_OVERFLOW"


async def test_ordinary_provider_400_stays_a_non_retryable_rejection(monkeypatch):
    """The discriminator is the body, not a constant: same status, different answer."""
    async with provider(400, REJECTED_BODY) as base:
        events = await _run_to_terminal(monkeypatch, _model(base))
    errors = [event for event in events if event.type == "error"]
    assert len(errors) == 1
    assert errors[0].data["code"] == "LLM_REQUEST_REJECTED"
    assert errors[0].data["retryable"] is False


async def test_silent_200_truncation_is_reported_but_never_an_overflow(monkeypatch):
    async with provider(200, TRUNCATED_BODY) as base:
        events = await _run_to_terminal(monkeypatch, _model(base))
    errors = [event for event in events if event.type == "error"]
    assert len(errors) == 1
    assert errors[0].data["code"] == "LLM_OUTPUT_TRUNCATED"
    assert errors[0].data["retryable"] is False
    assert all(event.data.get("code") != "CONTEXT_OVERFLOW" for event in events if event.type == "error")
