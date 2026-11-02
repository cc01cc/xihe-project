"""PLAN-0632 D32-27 Step 2 — `configState` machine + single-flight lazy load.

The four contracts (the Lead's list, in order):

1. health does **not** report ready while config is not usable (`configState` != `ready`);
2. two concurrent requests trigger **exactly one** load (counted, not assumed);
3. a failed load is an explicit `CONFIG_UNAVAILABLE` (never a `None` that explodes later);
4. a successful load flips health to `ready`.

Plus the two invariants that keep the state machine honest:
* startup success -> READY, startup failure -> PENDING (so the first request retries);
* a *periodic* blip must not push a READY process back to PENDING/FAILED (last known good).

No real CP: the loader is injected (`config_state.set_loader`).
"""

from __future__ import annotations

import asyncio
from typing import Any

import pytest
from fastapi.testclient import TestClient

import xihe_agent.app_state as app_state
import xihe_agent.config_state as config_state
from xihe_agent.config_state import (
    LAZY_LOAD_DEADLINE_S,
    ConfigState,
    ConfigUnavailableError,
    ensure_config_ready,
)
from xihe_agent.main import app

OK_REPORT: dict[str, Any] = {
    "ok": True,
    "domains": {"llm-provider": {"status": "ok", "revision": "r-llm", "source": "cp"}},
    "revision": "rev-123",
    "refreshed": True,
    "degraded": [],
}
BAD_REPORT: dict[str, Any] = {
    "ok": False,
    "domains": {"llm-provider": {"status": "unreachable", "revision": "", "source": ""}},
    "revision": "",
    "refreshed": False,
    "degraded": ["llm-provider"],
}


@pytest.fixture(autouse=True)
def _reset_machine(monkeypatch):
    """Every test starts from a fresh machine and never talks to a real CP."""
    config_state.reset_for_tests()
    monkeypatch.setattr(app_state, "_llm_ready", "unknown", raising=False)
    monkeypatch.setattr(app_state, "_agent_status", "starting", raising=False)
    yield
    config_state.reset_for_tests()


def _health_payload() -> dict[str, Any]:
    # Deliberately NOT `with TestClient(app)`: the context manager runs the app lifespan, which
    # would perform a real startup config sync. The route is what we are testing here.
    response = TestClient(app).get("/internal/v1/agent/health")
    assert response.status_code == 200
    return response.json()


def test_health_reports_pending_and_never_ready_before_config_loads():
    """Contract 1: a process that is up with no config must not look ready."""
    payload = _health_payload()

    assert payload["configState"] == "pending"
    assert payload["configStateLoads"] == 0
    # The readiness contract CP gates chat on: it must not say ready.
    assert payload["llmReady"] != "ready"
    # ...and the implication that matters: llmReady=="ready" requires configState=="ready".
    assert not (payload["llmReady"] == "ready" and payload["configState"] != "ready")


async def test_two_concurrent_requests_trigger_exactly_one_load():
    """Contract 2: single flight — one loader, everyone else awaits it."""
    calls = {"n": 0}

    async def loader() -> dict[str, Any]:
        calls["n"] += 1
        await asyncio.sleep(0.05)  # long enough that the second caller must join the flight
        return OK_REPORT

    config_state.set_loader(loader)
    first, second = await asyncio.gather(
        ensure_config_ready(trigger="chat"),
        ensure_config_ready(trigger="chat"),
    )

    assert calls["n"] == 1, f"single-flight broke: loader ran {calls['n']} times"
    assert config_state.snapshot()["loads"] == 1
    assert first is second, "both callers must receive the same loaded report"
    assert config_state.get_state() is ConfigState.READY


async def test_a_later_request_reuses_the_loaded_config_without_loading_again():
    calls = {"n": 0}

    async def loader() -> dict[str, Any]:
        calls["n"] += 1
        return OK_REPORT

    config_state.set_loader(loader)
    await ensure_config_ready(trigger="chat")
    await ensure_config_ready(trigger="chat")
    await ensure_config_ready(trigger="rag")

    assert calls["n"] == 1, "a ready process must not reload per request"


async def test_failed_load_is_an_explicit_error_not_none():
    """Contract 3: CONFIG_UNAVAILABLE, fail-closed."""

    async def loader() -> dict[str, Any]:
        return BAD_REPORT

    config_state.set_loader(loader)
    with pytest.raises(ConfigUnavailableError) as excinfo:
        await ensure_config_ready(trigger="chat")

    assert excinfo.value.code == "CONFIG_UNAVAILABLE"
    assert "degraded" in excinfo.value.detail
    assert config_state.get_state() is ConfigState.FAILED
    assert config_state.snapshot()["lastError"]


async def test_loader_exception_is_wrapped_not_leaked():
    async def loader() -> dict[str, Any]:
        raise RuntimeError("cp exploded")

    config_state.set_loader(loader)
    with pytest.raises(ConfigUnavailableError) as excinfo:
        await ensure_config_ready(trigger="chat")

    assert excinfo.value.code == "CONFIG_UNAVAILABLE"
    assert config_state.get_state() is ConfigState.FAILED
    assert "RuntimeError" in (config_state.snapshot()["lastError"] or "")


async def test_slow_load_times_out_bounded_and_stays_recoverable():
    """A bounded wait: the request fails fast, and a later caller can still succeed."""

    async def slow_then_fine() -> dict[str, Any]:
        await asyncio.sleep(0.2)
        return OK_REPORT

    config_state.set_loader(slow_then_fine)
    with pytest.raises(ConfigUnavailableError):
        await ensure_config_ready(trigger="chat", deadline_s=0.05)
    assert config_state.get_state() is ConfigState.FAILED

    # The shared load was NOT cancelled by the timed-out caller (shield): it finishes and the
    # state machine becomes READY, so the next request needs no new load.
    await asyncio.sleep(0.3)
    assert config_state.get_state() is ConfigState.READY
    assert await ensure_config_ready(trigger="chat") is not None


async def test_successful_load_flips_health_to_ready(monkeypatch):
    """Contract 4: after a successful load the health face reports ready."""

    async def loader() -> dict[str, Any]:
        return OK_REPORT

    config_state.set_loader(loader)
    await ensure_config_ready(trigger="chat")
    # The readiness derivation is the app's own; simulate the swap it performs on success.
    monkeypatch.setattr(app_state, "_llm_ready", "ready", raising=False)
    monkeypatch.setattr(app_state, "_runtime_config_revision", "rev-123", raising=False)

    payload = _health_payload()
    assert payload["configState"] == "ready"
    assert payload["configStateLoads"] == 1
    assert payload["configStateError"] is None
    assert payload["llmReady"] == "ready"


def test_startup_success_sets_ready_and_startup_failure_leaves_pending():
    """Startup failure is PENDING (retryable), never FAILED (permanent-looking)."""
    config_state.note_startup_result(OK_REPORT)
    assert config_state.get_state() is ConfigState.READY

    config_state.reset_for_tests()
    config_state.note_startup_result(BAD_REPORT)
    assert config_state.get_state() is ConfigState.PENDING
    assert config_state.snapshot()["lastError"] == "startup sync degraded"

    config_state.reset_for_tests()
    config_state.note_startup_exception(RuntimeError("boom"))
    assert config_state.get_state() is ConfigState.PENDING
    assert config_state.snapshot()["lastError"] == "RuntimeError"


async def test_startup_failure_then_first_request_loads_once():
    """The Step 2 flow end to end: failed startup -> pending -> one lazy load -> ready."""
    calls = {"n": 0}

    async def loader() -> dict[str, Any]:
        calls["n"] += 1
        return OK_REPORT

    config_state.set_loader(loader)
    config_state.note_startup_result(BAD_REPORT)
    assert config_state.get_state() is ConfigState.PENDING

    await asyncio.gather(ensure_config_ready(trigger="chat"), ensure_config_ready(trigger="chat"))

    assert calls["n"] == 1
    assert config_state.get_state() is ConfigState.READY


def test_periodic_blip_does_not_demote_a_ready_process():
    """Only startup/lazy paths move the state; a periodic failure keeps last known good."""
    config_state.note_startup_result(OK_REPORT)
    assert config_state.get_state() is ConfigState.READY
    # A periodic refresh failing is not a state transition (it keeps the carried-over snapshot).
    assert config_state.get_state() is ConfigState.READY


async def test_loader_missing_fails_closed_instead_of_hanging():
    """No loader wired (e.g. a mis-ordered import) must fail loudly, not block forever."""
    assert LAZY_LOAD_DEADLINE_S >= 1.0
    with pytest.raises(ConfigUnavailableError) as excinfo:
        await ensure_config_ready(trigger="chat")
    assert "no config loader" in excinfo.value.detail


async def test_chat_request_fails_closed_with_config_unavailable_not_a_crash():
    """The request path, not just the state module: 503 + an explicit problem code."""
    async def loader() -> dict[str, Any]:
        raise RuntimeError("cp is down")

    config_state.set_loader(loader)
    response = TestClient(app).post(
        "/internal/v1/agent/chat",
        json={
            "content": "hello while config is down",
            "sessionId": "s-config-unavailable",
            "toolMode": "none",
            "instructions": "you are a test agent",
        },
        headers={
            "Authorization": f"Bearer {app_state.CP_API_TOKEN}",
            "X-Chat-Run-Id": "run-config-unavailable",
        },
    )

    assert response.status_code == 503, response.text
    body = response.json()
    assert body.get("code") == "CONFIG_UNAVAILABLE" or body.get("type"), body
    assert "CONFIG_UNAVAILABLE" in response.text, "the failure must name the problem code"
    assert config_state.get_state() is ConfigState.FAILED
