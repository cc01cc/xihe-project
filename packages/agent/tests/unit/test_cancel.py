"""PLAN-290 M0.3: Agent cancel registry + endpoint + runner cancel path."""

import asyncio
from collections.abc import AsyncIterator
from typing import Any

import pytest
from fastapi.testclient import TestClient

from xihe_agent.agent_runner import LangGraphRunner
from xihe_agent.cancel_registry import RunCancelRegistry
from xihe_agent.interfaces.agent_runner import AgentEvent, RunnerConfig
from xihe_agent.interfaces.message import TextMessage
from xihe_agent.main import app, run_cancel_registry

# ── RunCancelRegistry (accepted / unknown / failed) ─────────────────────────


@pytest.mark.asyncio
async def test_cancel_registry_accepts_active_run():
    registry = RunCancelRegistry()
    event = registry.register("run-accepted")

    assert registry.cancel("run-accepted") == "accepted"
    assert event.is_set()


@pytest.mark.asyncio
async def test_cancel_registry_unknown_for_missing_run():
    registry = RunCancelRegistry()
    assert registry.cancel("run-missing") == "unknown"


@pytest.mark.asyncio
async def test_cancel_registry_unknown_after_unregister():
    registry = RunCancelRegistry()
    registry.register("run-finished")
    registry.unregister("run-finished")

    assert registry.cancel("run-finished") == "unknown"


@pytest.mark.asyncio
async def test_cancel_registry_failed_when_cancel_raises():
    class _BrokenEvent:
        def set(self) -> None:
            raise RuntimeError("event set failed")

    registry = RunCancelRegistry()
    registry._events["run-broken"] = _BrokenEvent()  # type: ignore[assignment]

    assert registry.cancel("run-broken") == "failed"


# ── HTTP endpoint three-state contract ──────────────────────────────────────


def test_cancel_endpoint_accepted_for_active_run():
    client = TestClient(app)
    run_cancel_registry.register("run-live")

    resp = client.post(
        "/internal/v1/agent/runs/run-live/cancel",
        json={"reason": "user_requested", "workspaceId": "ws-1"},
        headers={"Authorization": "Bearer dev-token-not-secure"},
    )

    assert resp.status_code == 202
    assert resp.json() == {"status": "accepted", "runId": "run-live"}
    run_cancel_registry.unregister("run-live")


def test_cancel_endpoint_unknown_for_finished_run():
    client = TestClient(app)

    resp = client.post(
        "/internal/v1/agent/runs/run-gone/cancel",
        json={"reason": "user_requested"},
        headers={"Authorization": "Bearer dev-token-not-secure"},
    )

    assert resp.status_code == 404
    assert resp.json()["status"] == "unknown"


def test_cancel_endpoint_failed_when_registry_raises(monkeypatch):
    client = TestClient(app)

    def boom(_run_id: str) -> str:
        raise RuntimeError("registry broken")

    monkeypatch.setattr(run_cancel_registry, "cancel", boom)

    resp = client.post(
        "/internal/v1/agent/runs/run-fail/cancel",
        json={},
        headers={"Authorization": "Bearer dev-token-not-secure"},
    )

    assert resp.status_code == 500
    body = resp.json()
    assert body["status"] == "failed"
    assert body["code"] == "CANCEL_FAILED"


def test_cancel_endpoint_rejects_missing_token():
    client = TestClient(app)

    resp = client.post("/internal/v1/agent/runs/run-x/cancel", json={})

    assert resp.status_code == 403


# ── LangGraphRunner stream observes cancel_event ────────────────────────────


class _HungStreamAgent:
    """Fake agent whose astream_events never completes until cancelled."""

    def astream_events(self, _inputs, version):
        assert version == "v2"

        async def events() -> AsyncIterator[dict[str, Any]]:
            await asyncio.sleep(30)
            yield {"event": "on_chain_end", "name": "LangGraph", "data": {}, "run_id": "g"}

        return events()


@pytest.mark.asyncio
async def test_langgraph_runner_stream_yields_cancelled_on_cancel_event(monkeypatch):
    monkeypatch.setattr(
        "xihe_agent.agent_runner.langgraph_runner.create_react_agent",
        lambda _model, tools: _HungStreamAgent(),
    )
    cancel_event = asyncio.Event()
    runner = LangGraphRunner(model_factory=lambda _model: object())
    config = RunnerConfig(
        model="fake",
        system_prompt="",
        tools=[],
        cancel_event=cancel_event,
    )

    async def drive() -> list[AgentEvent]:
        received: list[AgentEvent] = []
        async for event in runner.stream(
            [TextMessage(role="human", content="hello")],
            config,
        ):
            received.append(event)
        return received

    driver = asyncio.create_task(drive())
    await asyncio.sleep(0.05)  # let the hung stream park on wait()
    assert not driver.done()
    cancel_event.set()

    events = await asyncio.wait_for(driver, timeout=2.0)
    error_events = [e for e in events if e.type == "error"]
    assert error_events, "cancelled run must emit error event"
    assert error_events[0].data.get("code") == "cancelled"
    assert any(e.type == "usage" for e in events)


@pytest.mark.asyncio
async def test_langgraph_runner_pre_cancelled_event_stops_immediately(monkeypatch):
    monkeypatch.setattr(
        "xihe_agent.agent_runner.langgraph_runner.create_react_agent",
        lambda _model, tools: _HungStreamAgent(),
    )
    cancel_event = asyncio.Event()
    cancel_event.set()
    runner = LangGraphRunner(model_factory=lambda _model: object())
    config = RunnerConfig(model="fake", system_prompt="", tools=[], cancel_event=cancel_event)

    events = []
    async for event in runner.stream(
        [TextMessage(role="human", content="hello")],
        config,
    ):
        events.append(event)

    assert any(e.type == "error" and e.data.get("code") == "cancelled" for e in events)
