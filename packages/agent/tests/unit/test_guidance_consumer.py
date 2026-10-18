"""PLAN-0529 unit tests: GuidanceConsumer dedup / 409 stop / fail-open semantics.

Frozen protocol: spec/agent-guidance-consume-protocol.md. Uses a fake httpx
transport (no real CP) — the CP-side wire contract is covered by PLAN-0528.
"""

import json
from typing import Any

import httpx
import pytest

from xihe_agent.agent_runner.guidance import GuidanceConsumer, build_guidance_envelope


def _transport(handler: Any) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


def _consumer(transport: httpx.AsyncClient) -> GuidanceConsumer:
    consumer = GuidanceConsumer(base_url="http://cp.test", service_token="svc", run_id="run-1")
    consumer._client = transport  # noqa: SLF001 — test seam
    return consumer


@pytest.mark.asyncio
async def test_fetch_pending_fail_open_on_error() -> None:
    async def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500, text="boom")

    consumer = _consumer(_transport(handler))
    assert await consumer.fetch_pending() == []
    assert await consumer.collect_new() == []
    await consumer.aclose()


@pytest.mark.asyncio
async def test_collect_new_filters_injected_ids_in_sequence_order() -> None:
    async def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path.endswith("/chat/runs/run-1/guidance/pending")
        assert request.headers["Authorization"] == "Bearer svc"
        return httpx.Response(200, json={"runId": "run-1", "items": [
            {"id": "g1", "sequence": 1, "sourceKind": "user", "content": "one"},
            {"id": "g2", "sequence": 2, "sourceKind": "user", "content": "two"},
        ]})

    consumer = _consumer(_transport(handler))
    pending = await consumer.collect_new()
    assert [item["id"] for item in pending] == ["g1", "g2"]

    consumer.injected_ids.add("g1")
    remaining = await consumer.collect_new()
    assert [item["id"] for item in remaining] == ["g2"]
    await consumer.aclose()


@pytest.mark.asyncio
async def test_consume_success_records_id_and_sends_idempotency_key() -> None:
    seen: dict[str, str] = {}

    async def handler(request: httpx.Request) -> httpx.Response:
        seen["path"] = str(request.url.path)
        seen["idem"] = request.headers.get("Idempotency-Key", "")
        seen["body"] = request.read().decode()
        return httpx.Response(200, json={"id": "g1", "status": "consumed"})

    consumer = _consumer(_transport(handler))
    assert await consumer.consume("g1") is True
    assert "g1" in consumer.injected_ids
    assert seen["path"].endswith("/chat/runs/run-1/guidance/g1/consume")
    assert seen["idem"] == "guidance-g1"
    assert json.loads(seen["body"]) == {"consumedBy": "agent-runner"}
    await consumer.aclose()


@pytest.mark.asyncio
async def test_consume_terminal_expired_409_is_stop_signal() -> None:
    async def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(409, json={"errorCode": "GUIDANCE_ALREADY_TERMINAL_EXPIRED"})

    consumer = _consumer(_transport(handler))
    assert await consumer.consume("g9") is True, "409 is a settled stop-signal"
    assert "g9" in consumer.injected_ids, "expired guidance must never be injected again"
    assert await consumer.collect_new() == []
    await consumer.aclose()


@pytest.mark.asyncio
async def test_consume_transient_failure_keeps_id_eligible() -> None:
    async def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(503, text="unavailable")

    consumer = _consumer(_transport(handler))
    assert await consumer.consume("g5") is False, "transient failure = retry at next boundary"
    assert "g5" not in consumer.injected_ids
    await consumer.aclose()


@pytest.mark.asyncio
async def test_envelope_marks_untrusted_source_and_sequence() -> None:
    envelope = build_guidance_envelope(3, "prefer the smaller change")
    assert envelope.startswith("[guidance]")
    assert "source=user" in envelope
    assert "seq=3" in envelope
    assert "prefer the smaller change" in envelope
