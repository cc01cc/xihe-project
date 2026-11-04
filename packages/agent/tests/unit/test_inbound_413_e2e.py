"""PLAN-0670 M2c / BL-289: the 9 MiB 413 must hold at the real route, before any parsing.

The helper-level test (``test_inbound_body_limit.py``) proves ``read_body_with_limit``; this file
proves the wiring at ``POST /internal/v1/agent/chat`` with the service-token dependency overridden:

1. a declared 9 MiB body is refused with ``413`` and ``AGENT_CONTEXT_TOO_LARGE``;
2. the ``event=agent_context_too_large`` WARN is the FIRST business log of the request — log order is
   the evidence that no parsing/business path ran before the quota check;
3. a chunked upload without ``Content-Length`` is refused by the stream read (header cannot lie).
"""

from collections.abc import Iterator
from typing import Any

import pytest
from fastapi.testclient import TestClient
from loguru import logger

from xihe_agent.api.shared import verify_api_token
from xihe_agent.main import app

LIMIT_BYTES = 8 * 1024 * 1024
OVERSIZE = 9 * 1024 * 1024


@pytest.fixture()
def client() -> Iterator[TestClient]:
    app.dependency_overrides[verify_api_token] = lambda: None
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.pop(verify_api_token, None)


def _business_records() -> list[str]:
    return [record for record in _RECORDS if "event=" in record or "Chat rejected" in record]


_RECORDS: list[str] = []


@pytest.fixture()
def log_sink() -> Iterator[list[str]]:
    _RECORDS.clear()
    handler = logger.add(lambda message: _RECORDS.append(str(message)), level="WARNING")
    try:
        yield _RECORDS
    finally:
        logger.remove(handler)


def _assert_413(response: Any) -> None:
    assert response.status_code == 413, response.text[:400]
    body = response.json()
    assert body["code"] == "AGENT_CONTEXT_TOO_LARGE"
    assert body["status"] == 413
    assert body["requestId"], "the problem body must carry the request id"


def test_declared_oversize_body_is_rejected_before_parsing(
    client: TestClient, log_sink: list[str]
) -> None:
    body = b'{"content":"' + b"x" * OVERSIZE + b'"}'
    assert len(body) > LIMIT_BYTES

    response = client.post(
        "/internal/v1/agent/chat",
        content=body,
        headers={"Content-Type": "application/json", "X-Request-Id": "req-413-declared"},
    )

    _assert_413(response)
    records = _business_records()
    assert records, "the channel must log the refusal (never silent)"
    first = records[0]
    assert "event=agent_context_too_large" in first, f"business log before the quota check: {first!r}"
    assert "Chat rejected" not in "".join(records), "the request never reached business validation"
    assert "event=chat_stream_started" not in "".join(records), "no run was started"


def test_chunked_upload_without_content_length_is_stopped_by_the_stream_read(
    client: TestClient, log_sink: list[str]
) -> None:
    def chunks() -> Iterator[bytes]:
        # 3 x 3 MiB: total 9 MiB, no Content-Length (httpx emits Transfer-Encoding: chunked).
        yield b"x" * (3 * 1024 * 1024)
        yield b"x" * (3 * 1024 * 1024)
        yield b"x" * (3 * 1024 * 1024)

    response = client.post(
        "/internal/v1/agent/chat",
        content=chunks(),
        headers={"Content-Type": "application/json", "X-Request-Id": "req-413-chunked"},
    )

    _assert_413(response)
    records = _business_records()
    first = records[0]
    assert "event=agent_context_too_large" in first
    assert "event=chat_stream_started" not in "".join(records)
