"""PLAN-0605 M1: vision capability gate matrix (unit only, no provider calls).

The gate is evaluated after ``validate_body`` and before ``begin_attempt()``, so a
rejected run must never produce an outbound attempt (PLAN-0591 D5 analogue).
"""

from __future__ import annotations

from typing import Any

import pytest

from xihe_agent.llm.api_request import ApiRequestError, chat_type
from xihe_agent.llm.api_sender import (
    VISION_RENDERERS,
    ApiSender,
    images_non_empty,
    vision_route_supported,
)


def _grant(type_id: str, base: str = "http://fixture.invalid/v1", vision: bool = True) -> dict:
    grant = {
        "apiTypeId": type_id,
        "apiTypeVersion": 1,
        "operation": "chat",
        "apiKey": "fixture-only",
        "baseUrl": base,
        "toolsSupported": True,
        "visionSupported": vision,
    }
    return grant


def _body(type_id: str, *, image: bool, tools: bool = False) -> dict:
    """Minimal body that passes ``validate_body`` for each apiType."""
    user_content: Any = "describe this"
    if image:
        user_content = [
            {"type": "text", "text": "describe this"},
            {
                "type": "image_url",
                "image_url": {"url": "data:image/png;base64,AAAA"},
            },
        ]
    body: dict = {"model": "fixture-model", "stream": True}
    if type_id == "mimo-responses":
        body["input"] = [{"role": "user", "content": user_content}]
    else:
        body["messages"] = [{"role": "user", "content": user_content}]
    if type_id == "anthropic-messages":
        body["max_tokens"] = 64
    if tools:
        body["tools"] = [{"type": "function", "function": {"name": "read_file"}}]
    return body


# ---------------------------------------------------------------- pure helpers


@pytest.mark.parametrize(
    ("body", "expected"),
    [
        ({"messages": [{"role": "user", "content": "hi"}]}, False),
        ({"messages": [{"role": "user", "content": [{"type": "text", "text": "hi"}]}]}, False),
        (
            {
                "messages": [
                    {
                        "role": "user",
                        "content": [
                            {"type": "text", "text": "hi"},
                            {"type": "image_url", "image_url": {"url": "data:image/png;base64,AA"}},
                        ],
                    }
                ]
            },
            True,
        ),
        ({"messages": [{"role": "user", "content": [{"type": "image", "source": {}}]}]}, True),
        ({"messages": [{"role": "user", "content": [{"type": "input_image"}]}]}, True),
        ({"input": [{"role": "user", "content": [{"type": "image_url"}]}]}, True),
        ({"input": [{"role": "user", "content": "text only"}]}, False),
        ({}, False),
    ],
)
def test_images_non_empty_detection(body, expected):
    assert images_non_empty(body) is expected


@pytest.mark.parametrize(
    ("api_type_id", "supported", "expected"),
    [
        ("openai-chat-completions", True, True),
        ("openai-chat-completions", False, False),
        # capability data true but this build has no renderer -> fail closed
        ("mimo-responses", True, False),
        ("anthropic-messages", True, False),
        ("mimo-responses", False, False),
    ],
)
def test_vision_route_supported_matrix(api_type_id, supported, expected):
    assert vision_route_supported(api_type_id, supported) is expected
    assert ("openai-chat-completions" in VISION_RENDERERS) is True


# ------------------------------------------------------ wired gate (no network)


@pytest.mark.parametrize("type_id", ["openai-chat-completions", "mimo-responses", "anthropic-messages"])
async def test_vision_gate_rejects_unsupported_before_transport(type_id):
    sender = ApiSender(chat_type(type_id, 1), _grant(type_id, vision=False), "request-1", 3)
    with pytest.raises(ApiRequestError, match="LLM_VISION_ROUTE_UNSUPPORTED"):
        _ = [part async for part in sender.stream(_body(type_id, image=True))]


@pytest.mark.parametrize("type_id", ["mimo-responses", "anthropic-messages"])
async def test_vision_gate_rejects_when_capability_true_but_no_renderer(type_id):
    """V2 判据：数据 true 但无渲染实现也必须拒绝，不得静默丢图。"""
    sender = ApiSender(chat_type(type_id, 1), _grant(type_id, vision=True), "request-1", 3)
    assert sender.vision_supported is True
    with pytest.raises(ApiRequestError, match="LLM_VISION_ROUTE_UNSUPPORTED"):
        _ = [part async for part in sender.stream(_body(type_id, image=True))]


async def test_vision_gate_allows_renderable_route_to_reach_transport_boundary():
    """No rejection at the gate; the attempt opens (fixture URL then fails on connect)."""
    sender = ApiSender(
        chat_type("openai-chat-completions", 1),
        _grant("openai-chat-completions", base="http://127.0.0.1:9/v1", vision=True),
        "request-1",
        1,
    )
    with pytest.raises(Exception) as excinfo:
        _ = [part async for part in sender.stream(_body("openai-chat-completions", image=True))]
    assert "LLM_VISION_ROUTE_UNSUPPORTED" not in str(excinfo.value)


def test_missing_vision_supported_defaults_to_unsupported_and_warns():
    from loguru import logger

    messages = []
    sink_id = logger.add(lambda message: messages.append(str(message)), level="WARNING")
    try:
        grant = _grant("openai-chat-completions")
        grant.pop("visionSupported")
        sender = ApiSender(chat_type("openai-chat-completions", 1), grant, "request-1", 3)
    finally:
        logger.remove(sink_id)
    assert sender.vision_supported is False
    assert any("visionSupported" in message for message in messages)


def test_vision_route_unsupported_code_is_terminal_and_stable():
    assert ApiRequestError("LLM_VISION_ROUTE_UNSUPPORTED").terminal_code == "LLM_VISION_ROUTE_UNSUPPORTED"


async def test_tools_gate_precedes_vision_gate():
    """Ordering: tools gate first (0591 behaviour preserved)."""
    sender = ApiSender(
        chat_type("mimo-responses", 1),
        {**_grant("mimo-responses", vision=False), "toolsSupported": False},
        "request-1",
        3,
    )
    with pytest.raises(ApiRequestError, match="LLM_TOOL_ROUTE_UNSUPPORTED"):
        _ = [part async for part in sender.stream(_body("mimo-responses", image=True, tools=True))]



