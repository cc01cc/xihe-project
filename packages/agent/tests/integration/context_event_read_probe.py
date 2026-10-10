"""Bounded live CP EventStore probe; emits only safe assertion summaries."""

from __future__ import annotations

import asyncio
import importlib
import json
import logging
import os
import sys
from datetime import UTC, datetime
from pathlib import Path


async def run() -> dict[str, object]:
    agent_root = Path(__file__).resolve().parents[2]
    source_root = agent_root / "src"
    sys.path.insert(0, str(source_root))
    store_module = importlib.import_module("xihe_agent.context.store_client")
    event_module = importlib.import_module("xihe_agent.interfaces.event")
    for module in (store_module, event_module):
        if not Path(module.__file__).resolve().is_relative_to(source_root.resolve()):
            raise AssertionError("wrong_source_root")
    import httpx

    mode = os.environ["PLAN0470_PROBE_MODE"]
    assert mode in {"success", "expected500", "expectedautherror"}
    session_id = os.environ["PLAN0470_SESSION_ID"]
    base_url = os.environ["PLAN0470_CP_URL"]
    token = os.environ["PLAN0470_TOKEN"]
    client = store_module.CPEventStoreClient(base_url, token)
    try:
        if mode == "success":
            payload = {
                "nested": {"items": [None, True, {"text": "live-contract"}]},
                "large": 123456789012345678901234567890,
            }
            submitted = event_module.Event(session_id, 0, "epoch.started", payload, datetime.now(UTC))
            appended = await client.append(submitted)
            events = [event async for event in client.read(session_id)]
            assert len(events) == 1
            actual = events[0]
            assert actual.aggregate_id == session_id
            assert actual.sequence == appended.sequence == 1
            assert actual.type == submitted.type and actual.payload == payload
            assert actual.created_at.tzinfo is not None
            assert actual.correlation_id is None and actual.causation_id is None
            assert [event async for event in client.read(session_id, actual.sequence)] == []
            # Compare parser output to live wire, never a copied parser or fixture.
            async with httpx.AsyncClient(timeout=10.0) as wire_client:
                response = await wire_client.get(
                    f"{base_url}/internal/v1/context/{session_id}/events",
                    headers={"Authorization": f"Bearer {token}"},
                )
                response.raise_for_status()
                raw = response.json()[0]
                assert set(raw) == {
                    "aggregate_id",
                    "sequence",
                    "type",
                    "payload",
                    "created_at",
                    "correlation_id",
                    "causation_id",
                }
                assert actual.created_at == datetime.fromisoformat(raw["created_at"])
            return {"ok": True, "mode": mode, "sequence": actual.sequence}
        expected_status = 500 if mode == "expected500" else int(os.environ["PLAN0470_EXPECTED_STATUS"])
        count = 0
        try:
            async for _ in client.read(session_id):
                count += 1
        except httpx.HTTPStatusError as error:
            assert count == 0 and error.response.status_code == expected_status
            problem = error.response.json()
            assert problem["status"] == expected_status
            assert problem["requestId"] == error.response.headers["X-Request-Id"]
            assert os.environ["PLAN0470_SENSITIVE_MARKER"] not in error.response.text
            if mode == "expected500":
                assert problem["code"] == "INTERNAL_ERROR"
                assert problem["detail"] == "Context event response could not be constructed"
            return {"ok": True, "mode": mode, "status": expected_status, "partial": False}
        raise AssertionError("expected_http_failure")
    finally:
        # The existing client has no public close method.
        await client._client.aclose()


if __name__ == "__main__":
    logging.basicConfig(level=logging.CRITICAL)
    try:
        result = asyncio.run(run())
    except Exception as error:
        # No raw exception text/traceback: HTTP exceptions can retain headers/body.
        print(json.dumps({"ok": False, "category": type(error).__name__}))
        sys.exit(1)
    print(json.dumps(result))
