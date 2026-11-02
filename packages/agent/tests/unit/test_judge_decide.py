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
