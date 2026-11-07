"""PLAN-0624 M1: judge decide endpoint core (provider-agnostic seam tests).

The transport itself (ApiSender over a redeemed lease) is covered by the llm transport
suite; these tests pin the judge-specific behavior: raw verdict pass-through, metered
facts (unknown counters stay None per PLAN-0416 T2.3), and the invalid-response gate.
"""

from __future__ import annotations

import asyncio

import pytest

from xihe_agent.api.judge import _run_judge
from xihe_agent.llm.api_request import ApiRequestError
from xihe_agent.llm.api_sender import NativeResponse


class _FakeSender:
    def __init__(self, responses):
        self._responses = responses
        self.seen_body = None

    async def stream(self, body):
        self.seen_body = body
        for item in self._responses:
            yield item


def _grant() -> dict:
    return {
        "operation": "chat",
        "apiTypeId": "openai-chat-completions",
        "apiTypeVersion": 1,
        "baseUrl": "https://dashscope.aliyuncs.com/compatible-mode/v1",
        "apiKey": "leased-key",
        "toolsSupported": False,
        "visionSupported": False,
    }


def test_run_judge_returns_raw_verdict_and_metered_facts():
    response = NativeResponse(
        text='{"speak": true, "reason": "direct question"}',
        usage={"input_tokens": 3180, "output_tokens": 12, "total_tokens": 3192},
        provider_usage={"input_tokens": 3180, "output_tokens": 12},
    )
    sender = _FakeSender([("text", "", response)])

    async def scenario():
        return await _run_judge(
            _grant(), "decision-model-preview", "should this participant respond?",
            "req-1", sender_factory=lambda grant: sender, clock=_clock(),
        )

    result = asyncio.run(scenario())
    assert result["verdictText"] == '{"speak": true, "reason": "direct question"}'
    assert result["promptTokens"] == 3180
    assert result["completionTokens"] == 12
    assert result["latencyMs"] == 125
    # One-shot completion shape: single user message, bounded spend, deterministic sampling.
    assert sender.seen_body["model"] == "decision-model-preview"
    assert sender.seen_body["messages"] == [
        {"role": "user", "content": "should this participant respond?"}
    ]
    assert sender.seen_body["max_tokens"] == 400
    assert sender.seen_body["temperature"] == 0


def test_run_judge_keeps_absent_counters_unknown_not_zero():
    response = NativeResponse(
        text="{\"speak\": false}",
        usage={"input_tokens": 0, "output_tokens": 0, "total_tokens": 0},
        provider_usage={},  # provider returned no counters — unknown, never synthesized
    )
    sender = _FakeSender([("text", "", response)])

    async def scenario():
        return await _run_judge(
            _grant(), "decision-model-preview", "p", "req-2",
            sender_factory=lambda grant: sender, clock=_clock(),
        )

    result = asyncio.run(scenario())
    assert result["promptTokens"] is None
    assert result["completionTokens"] is None


def test_run_judge_rejects_empty_provider_response():
    sender = _FakeSender([])

    async def scenario():
        await _run_judge(
            _grant(), "decision-model-preview", "p", "req-3",
            sender_factory=lambda grant: sender, clock=_clock(),
        )

    with pytest.raises(ApiRequestError) as excinfo:
        asyncio.run(scenario())
    assert excinfo.value.code == "AGENT_STREAM_FAILED"


def _clock():
    ticks = iter([10.0, 10.125])

    def clock() -> float:
        return next(ticks)

    return clock

def test_run_judge_builds_native_dashscope_body():
    from xihe_agent.llm.api_request import CHAT_TYPES

    sender = _FakeSender(
        [("text", "", NativeResponse(text="{\"speak\": false}", usage={"input_tokens": 9, "output_tokens": 2, "total_tokens": 11}, provider_usage={"input_tokens": 9, "output_tokens": 2}))]
    )

    async def scenario():
        native_grant = dict(_grant(), apiTypeId="dashscope-generation", apiTypeVersion=1)
        return await _run_judge(
            native_grant, "decision-model-preview", "p", "req-4",
            sender_factory=lambda grant: sender,
            clock=_clock(),
        )

    result = asyncio.run(scenario())
    # D24-04 native shape: model + input.messages + parameters (no top-level messages/max_tokens).
    assert sender.seen_body["model"] == "decision-model-preview"
    assert sender.seen_body["input"]["messages"] == [{"role": "user", "content": "p"}]
    assert sender.seen_body["parameters"] == {"max_tokens": 400, "temperature": 0}
    assert "messages" not in sender.seen_body
    assert CHAT_TYPES["dashscope-generation"].path == "/services/aigc/text-generation/generation"


def test_parse_response_understands_native_dashscope_shape():
    from xihe_agent.llm.api_request import CHAT_TYPES
    from xihe_agent.llm.api_sender import parse_response

    native = {
        "output": {
            "choices": [
                {
                    "message": {"role": "assistant", "content": "{\"speak\": true}"},
                    "finish_reason": "stop",
                }
            ]
        },
        "usage": {"input_tokens": 3180, "output_tokens": 12, "total_tokens": 3192},
        "request_id": "req-native-1",
    }
    parsed = parse_response(native, CHAT_TYPES["dashscope-generation"])
    assert parsed.text == "{\"speak\": true}"
    assert parsed.provider_usage == {"input_tokens": 3180, "output_tokens": 12}
    assert parsed.usage["total_tokens"] == 3192


def test_judge_limits_are_env_injectable_and_logged(monkeypatch):
    """T1.4 AG-1: bounded-call limits come from env and are evidence-visible."""
    from loguru import logger

    monkeypatch.setenv("XIHE_JUDGE_TIMEOUT_SECONDS", "1.5")
    monkeypatch.setenv("XIHE_JUDGE_MAX_TOKENS", "120")
    response = NativeResponse(
        text='{"speak": true}',
        usage={"input_tokens": 7, "output_tokens": 3, "total_tokens": 10},
        provider_usage={"input_tokens": 7, "output_tokens": 3},
    )
    sender = _FakeSender([("text", "", response)])
    messages: list[str] = []
    handler = logger.add(lambda message: messages.append(str(message)), level="INFO", format="{message}")
    grant = dict(_grant(), baseUrl="http://127.0.0.1:12680/openai/v1?api_key=secret")
    try:
        async def scenario():
            return await _run_judge(
                grant, "decision-model-preview", "p", "req-env",
                sender_factory=lambda g: sender, clock=_clock(),
            )

        result = asyncio.run(scenario())
    finally:
        logger.remove(handler)

    assert sender.seen_body["max_tokens"] == 120
    assert result["promptTokens"] == 7
    joined = "\n".join(messages)
    assert "requestId=req-env" in joined
    assert "endpoint=http://127.0.0.1:12680" in joined
    assert "timeoutSeconds=1.5" in joined
    assert "maxCompletionTokens=120" in joined
    assert "secret" not in joined


def test_provider_endpoint_keeps_only_scheme_host_port():
    from xihe_agent.api.judge import _provider_endpoint

    assert _provider_endpoint("http://127.0.0.1:12680/openai/v1") == (
        "http://127.0.0.1:12680"
    )
    assert _provider_endpoint("http://user:pass@127.0.0.1:12680/x?token=t") == (
        "http://127.0.0.1:12680"
    )
    assert _provider_endpoint(None) == "-"
    assert _provider_endpoint("not-a-url") == "<invalid>"


def test_default_sender_factory_uses_injected_timeout(monkeypatch):
    """T1.4 AG-1: the production ApiSender receives the env-injected timeout."""
    from xihe_agent.api import judge as judge_module

    monkeypatch.setenv("XIHE_JUDGE_TIMEOUT_SECONDS", "2.25")
    seen: dict[str, float] = {}

    class _RecordingSender:
        def __init__(self, api_type, grant, request_id, timeout):
            seen["timeout"] = timeout
            self._response = NativeResponse(
                text='{"speak": false}',
                usage={"input_tokens": 1, "output_tokens": 1},
                provider_usage={"input_tokens": 1, "output_tokens": 1},
            )

        async def stream(self, body):
            yield "text", "", self._response

    monkeypatch.setattr(judge_module, "ApiSender", _RecordingSender)

    async def scenario():
        return await _run_judge(
            _grant(), "decision-model-preview", "p", "req-timeout", clock=_clock(),
        )

    asyncio.run(scenario())
    assert seen["timeout"] == 2.25


def test_invalid_judge_limit_env_keeps_frozen_defaults(monkeypatch):
    from xihe_agent.api.judge import _judge_max_completion_tokens, _judge_timeout_seconds

    monkeypatch.setenv("XIHE_JUDGE_TIMEOUT_SECONDS", "0")
    monkeypatch.setenv("XIHE_JUDGE_MAX_TOKENS", "abc")
    assert _judge_timeout_seconds() == 8.0
    assert _judge_max_completion_tokens() == 400
