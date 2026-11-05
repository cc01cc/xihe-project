"""PLAN-0670 T2c.1 — the 413 guard fires before any JSON parsing."""

from __future__ import annotations

import asyncio
import json

import pytest

from xihe_agent.context.inbound_limits import InboundTooLargeError, read_body_with_limit


class _FakeRequest:
    def __init__(self, chunks: list[bytes], content_length: str | None = None) -> None:
        self.headers = {} if content_length is None else {"content-length": content_length}
        self._chunks = chunks

    async def stream(self):
        for chunk in self._chunks:
            yield chunk


def test_refuses_on_content_length_before_reading_any_chunk() -> None:
    request = _FakeRequest([b"x" * 10], content_length=str(9 * 1024 * 1024))

    with pytest.raises(InboundTooLargeError) as raised:
        asyncio.run(read_body_with_limit(request, max_bytes=8 * 1024 * 1024))

    assert raised.value.observed_bytes == 9 * 1024 * 1024


def test_stream_read_stops_when_the_cap_is_crossed_without_a_content_length() -> None:
    chunk = b"y" * (3 * 1024 * 1024)
    request = _FakeRequest([chunk, chunk, chunk])  # 9 MiB total, header absent (chunked upload)

    with pytest.raises(InboundTooLargeError) as raised:
        asyncio.run(read_body_with_limit(request, max_bytes=8 * 1024 * 1024))

    assert raised.value.observed_bytes is not None
    assert raised.value.observed_bytes > 8 * 1024 * 1024


def test_lying_smaller_content_length_cannot_smuggle_a_big_body() -> None:
    request = _FakeRequest([b"z" * (5 * 1024 * 1024)] * 2, content_length="1024")

    with pytest.raises(InboundTooLargeError):
        asyncio.run(read_body_with_limit(request, max_bytes=8 * 1024 * 1024))


def test_a_body_within_the_cap_is_returned_intact_for_the_caller_to_parse() -> None:
    payload = {"content": "hello", "sessionId": "s-1"}

    body = asyncio.run(read_body_with_limit(_FakeRequest([json.dumps(payload).encode()]),
                                            max_bytes=8 * 1024 * 1024))

    assert json.loads(body) == payload
