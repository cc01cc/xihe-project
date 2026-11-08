"""PLAN-0701 (BL-158): the config-snapshot counters must have a runtime exit.

Before this plan `snapshot_metrics()` was only read by unit tests; the unauthenticated
`/internal/v1/agent/health` probe is the runtime exit. These tests keep the exit honest:
the three counters exist on the wire and they actually move when their code paths run.

Fixtures are reused from `test_config_snapshot` (same directory; pytest prepend mode).
"""

from __future__ import annotations

from typing import Any

import pytest
from fastapi.testclient import TestClient
from test_config_snapshot import FakeClient, _resolver

from xihe_agent.config_snapshot import ConfigSnapshotUnavailableError
from xihe_agent.main import app


def _health_payload() -> dict[str, Any]:
    # Deliberately NOT `with TestClient(app)`: the context manager runs the app lifespan, which
    # would perform a real startup config sync. The route is what we are testing here.
    response = TestClient(app).get("/internal/v1/agent/health")
    assert response.status_code == 200
    return response.json()


def _metrics() -> dict[str, int]:
    payload = _health_payload()
    assert "snapshotMetrics" in payload, "BL-158: health has no snapshotMetrics exit"
    return payload["snapshotMetrics"]


def test_health_snapshot_metrics_shape() -> None:
    metrics = _metrics()
    for key in ("stale_total", "unavailable_total", "evictions_total"):
        assert key in metrics, f"BL-158: health is missing the {key} counter"
        assert isinstance(metrics[key], int), f"{key} must be an int"
        assert metrics[key] >= 0, f"{key} must not go negative"


@pytest.mark.asyncio
async def test_stale_total_increments_via_health() -> None:
    before = _metrics()["stale_total"]
    client = FakeClient(results={"rag": {"topK": "3"}})
    resolver = _resolver(client, ttl_seconds=10, max_entries=4)
    fresh = await resolver.resolve("ws-health-stale", "u")

    object.__setattr__(fresh, "fetched_at", fresh.fetched_at - 15)
    client._failures = {"llm-provider": "unreachable"}
    stale = await resolver.resolve("ws-health-stale", "u")

    assert stale.stale is True
    assert _metrics()["stale_total"] == before + 1, "BL-158: stale_total must be observable at runtime"


@pytest.mark.asyncio
async def test_unavailable_total_increments_via_health() -> None:
    before = _metrics()["unavailable_total"]
    client = FakeClient()
    resolver = _resolver(client, ttl_seconds=10, max_entries=4)
    fresh = await resolver.resolve("ws-health-unavailable", "u")

    object.__setattr__(fresh, "fetched_at", fresh.fetched_at - 25)
    client._failures = {"llm-provider": "unreachable"}
    with pytest.raises(ConfigSnapshotUnavailableError):
        await resolver.resolve("ws-health-unavailable", "u")

    assert _metrics()["unavailable_total"] == before + 1, "BL-158: unavailable_total must be observable"


@pytest.mark.asyncio
async def test_evictions_total_increments_via_health() -> None:
    before = _metrics()["evictions_total"]
    client = FakeClient()
    resolver = _resolver(client, ttl_seconds=60, max_entries=2)

    await resolver.resolve("ws-health-1", None)
    await resolver.resolve("ws-health-2", None)
    await resolver.resolve("ws-health-3", None)

    assert _metrics()["evictions_total"] == before + 1, "BL-158: evictions_total must be observable"
