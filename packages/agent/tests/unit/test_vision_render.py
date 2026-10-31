"""PLAN-0605 M2: vision renderer post-transform (decision B) unit matrix.

Covers: ref validation, byte fetch (success + all failure classes must NOT degrade to
text), and the transform itself (text fidelity, last-user-message-only, renderer gating).
"""

from __future__ import annotations

import base64
from typing import Any

import pytest

from xihe_agent.llm import vision_render
from xihe_agent.llm.api_request import ApiRequestError
from xihe_agent.llm.vision_render import (
    apply_image_parts,
    fetch_image_data_urls,
    normalize_image_refs,
)

PNG_BYTES = b"\x89PNG\r\n\x1a\nfixture"
PNG_DATA_URL_PREFIX = "data:image/png;base64,"


def _ref(size: int = len(PNG_BYTES), mime: str = "image/png", attachment_id: str = "att-1") -> dict:
    return {"attachmentId": attachment_id, "mimeType": mime, "sizeBytes": size}


class _FakeResponse:
    def __init__(self, status_code: int, content: bytes = b"") -> None:
        self.status_code = status_code
        self.content = content


class _FakeClient:
    def __init__(self, responses: list[_FakeResponse]) -> None:
        self._responses = list(responses)
        self.calls: list[tuple[str, dict[str, Any]]] = []

    async def __aenter__(self) -> _FakeClient:
        return self

    async def __aexit__(self, *_exc: object) -> None:
        return None

    async def get(self, url: str, headers: dict[str, Any] | None = None) -> _FakeResponse:
        self.calls.append((url, headers or {}))
        return self._responses.pop(0)


def _patch_client(monkeypatch: pytest.MonkeyPatch, responses: list[_FakeResponse]) -> _FakeClient:
    client = _FakeClient(responses)
    monkeypatch.setattr(vision_render.httpx, "AsyncClient", lambda **_kwargs: client)
    return client


# ------------------------------------------------------------- ref validation


def test_normalize_absent_returns_empty():
    assert normalize_image_refs(None) == []
    assert normalize_image_refs([]) == []


def test_normalize_accepts_supported_refs():
    refs = normalize_image_refs([_ref(), _ref(mime="image/jpeg", attachment_id="att-2")])
    assert [ref["attachmentId"] for ref in refs] == ["att-1", "att-2"]
    assert refs[0]["mimeType"] == "image/png"


@pytest.mark.parametrize(
    ("raw", "code"),
    [
        ("not-a-list", "INVALID_REQUEST_SHAPE"),
        ([{"mimeType": "image/png", "sizeBytes": 1}], "INVALID_REQUEST_SHAPE"),
        ([_ref(mime="image/gif")], "LLM_VISION_ATTACHMENT_UNSUPPORTED"),
        ([_ref(size=vision_render.MAX_IMAGE_BYTES + 1)], "LLM_VISION_ATTACHMENT_TOO_LARGE"),
        ([_ref()] * 5, "LLM_VISION_ATTACHMENT_TOO_LARGE"),
    ],
)
def test_normalize_rejects_bad_refs(raw, code):
    with pytest.raises(ApiRequestError, match=code):
        normalize_image_refs(raw)


# -------------------------------------------------------------------- fetching


async def test_fetch_builds_data_urls_and_uses_run_bound_route(monkeypatch):
    client = _patch_client(monkeypatch, [_FakeResponse(200, PNG_BYTES)])
    urls = await fetch_image_data_urls(
        [_ref()], cp_url="http://cp.local/", service_token="svc", run_id="run-1", workspace_id="ws-1"
    )
    assert urls == [PNG_DATA_URL_PREFIX + base64.b64encode(PNG_BYTES).decode("ascii")]
    url, headers = client.calls[0]
    assert url == "http://cp.local/internal/v1/attachments/att-1/content?runId=run-1"
    assert headers["Authorization"] == "Bearer svc"
    assert headers["X-Workspace-Id"] == "ws-1"


@pytest.mark.parametrize("status", [401, 403, 404, 413, 500])
async def test_fetch_failures_do_not_degrade_to_text(monkeypatch, status):
    _patch_client(monkeypatch, [_FakeResponse(status)])
    with pytest.raises(ApiRequestError, match="LLM_VISION_ATTACHMENT_UNAVAILABLE"):
        await fetch_image_data_urls(
            [_ref()], cp_url="http://cp.local", service_token="svc", run_id="run-1", workspace_id=None
        )


async def test_fetch_rejects_oversized_payload(monkeypatch):
    _patch_client(monkeypatch, [_FakeResponse(200, b"x" * (vision_render.MAX_IMAGE_BYTES + 1))])
    with pytest.raises(ApiRequestError, match="LLM_VISION_ATTACHMENT_TOO_LARGE"):
        await fetch_image_data_urls(
            [_ref()], cp_url="http://cp.local", service_token="svc", run_id="run-1", workspace_id=None
        )


async def test_fetch_empty_refs_makes_no_calls(monkeypatch):
    client = _patch_client(monkeypatch, [])
    assert await fetch_image_data_urls(
        [], cp_url="http://cp.local", service_token="svc", run_id="run-1", workspace_id=None
    ) == []
    assert client.calls == []


# -------------------------------------------------------------------- transform


def _body(*messages: dict[str, Any]) -> dict[str, Any]:
    return {"model": "m", "stream": True, "messages": list(messages)}


def test_apply_preserves_text_and_appends_image_parts():
    body = _body({"role": "system", "content": "sys"}, {"role": "user", "content": "这张图片是什么颜色？"})
    data_url = PNG_DATA_URL_PREFIX + base64.b64encode(PNG_BYTES).decode("ascii")
    result = apply_image_parts(body, "openai-chat-completions", [data_url])
    user = result["messages"][-1]
    assert user["content"][0] == {"type": "text", "text": "这张图片是什么颜色？"}
    assert user["content"][1] == {"type": "image_url", "image_url": {"url": data_url}}
    assert result["messages"][0] == {"role": "system", "content": "sys"}


def test_apply_multiple_images_keeps_order():
    body = _body({"role": "user", "content": "两张图"})
    result = apply_image_parts(body, "openai-chat-completions", ["data:image/png;base64,AA", "data:image/jpeg;base64,BB"])
    parts = result["messages"][0]["content"]
    assert [part["type"] for part in parts] == ["text", "image_url", "image_url"]
    assert parts[1]["image_url"]["url"].endswith("AA")
    assert parts[2]["image_url"]["url"].endswith("BB")


def test_apply_without_images_is_a_noop_and_keeps_identity():
    body = _body({"role": "user", "content": "纯文本"})
    assert apply_image_parts(body, "openai-chat-completions", []) is body
    assert body["messages"][0]["content"] == "纯文本"


def test_apply_skips_api_types_without_renderer():
    body = _body({"role": "user", "content": "纯文本"})
    assert apply_image_parts(body, "mimo-responses", ["data:image/png;base64,AA"]) is body
    assert body["messages"][0]["content"] == "纯文本"


def test_apply_rewrites_only_last_user_message():
    body = _body(
        {"role": "user", "content": "第一轮"},
        {"role": "assistant", "content": "好的"},
        {"role": "user", "content": "这一轮"},
    )
    result = apply_image_parts(body, "openai-chat-completions", ["data:image/png;base64,AA"])
    assert result["messages"][0]["content"] == "第一轮"
    assert result["messages"][2]["content"][0] == {"type": "text", "text": "这一轮"}


def test_apply_fails_closed_on_unexpected_content_shape():
    body = _body({"role": "user", "content": [{"type": "text", "text": "already parts"}]})
    with pytest.raises(ApiRequestError, match="INVALID_REQUEST_SHAPE"):
        apply_image_parts(body, "openai-chat-completions", ["data:image/png;base64,AA"])
