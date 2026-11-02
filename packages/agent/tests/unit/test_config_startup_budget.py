"""PLAN-0632 D32-27 Step 1 — the Agent's startup config-sync budget.

Two contracts, both machine-checked here:

1. **The startup path uses the startup budget, not the shared defaults.** The shared defaults
   (`timeout=3` per domain, `max_retries: int = 3`) belong to the periodic refresh: shrinking
   them would turn "the CP was one second slow" into a permanent refresh failure. So the budget
   is a pair of explicit constants passed from `main._sync_config(reason="startup")`, and these
   tests fail if a future change goes back to calling `sync_with_retry()` bare.

2. **A CP that is not up costs seconds, not a minute.** Measured before the change (PLAN-0632
   T1, packaged Agent): 58.46 s of retry ladder before the Agent degrades, which the user sees
   as a hung program. With the startup budget the same failure must land under 15 s.

No real stack is needed: the "CP" here is a local socket that accepts TCP and never answers
(black hole), which is exactly what an unreachable CP looks like to httpx.
"""

from __future__ import annotations

import asyncio
import inspect
import socket
import time
from pathlib import Path
from unittest.mock import AsyncMock

import httpx
import pytest

import xihe_agent.config_client as config_client_module
import xihe_agent.main as main
from xihe_agent.config_client import (
    CONFIG_DOMAINS,
    STARTUP_CONFIG_RETRIES,
    STARTUP_CONFIG_TIMEOUT_S,
    ConfigClient,
    _classify_transport_error,
    _sync_failure_verdict,
)

EMPTY_REPORT = {
    "ok": False,
    "domains": {},
    "revision": "",
    "refreshed": False,
    "degraded": [],
}


@pytest.fixture
def black_hole_server():
    """A TCP listener that accepts connections and never responds (an unreachable CP)."""
    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind(("127.0.0.1", 0))
    server.listen(64)
    try:
        yield f"http://127.0.0.1:{server.getsockname()[1]}"
    finally:
        server.close()


@pytest.fixture
def closed_port_url():
    """A port nothing listens on (a CP that is not started at all)."""
    probe = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    probe.bind(("127.0.0.1", 0))
    port = probe.getsockname()[1]
    probe.close()
    return f"http://127.0.0.1:{port}"


async def test_startup_path_passes_the_explicit_startup_budget(monkeypatch):
    """The startup call site must pass BOTH constants as keywords (no bare call)."""
    mock = AsyncMock(return_value=EMPTY_REPORT)
    monkeypatch.setattr(main.config_client, "sync_with_retry_budget", mock)

    await main._sync_config("startup")

    mock.assert_awaited_once_with(
        max_retries=STARTUP_CONFIG_RETRIES,
        timeout=STARTUP_CONFIG_TIMEOUT_S,
    )


async def test_periodic_refresh_keeps_the_shared_defaults(monkeypatch):
    """Periodic refresh must NOT inherit the startup budget (that is the whole point)."""
    mock = AsyncMock(return_value=EMPTY_REPORT)
    monkeypatch.setattr(main.config_client, "sync_with_retry", mock)

    await main._sync_config("periodic")

    mock.assert_awaited_once_with()


def test_shared_defaults_are_untouched():
    """The Lead's hard acceptance: the shared `max_retries = 3` default must still be 3."""
    signature = inspect.signature(ConfigClient.sync_with_retry)
    assert signature.parameters["max_retries"].default == 3, "the shared retry default must stay 3"
    assert "timeout" not in signature.parameters, "the shared retry entry must not grow a budget kwarg"
    source = Path(config_client_module.__file__).read_text(encoding="utf-8")
    assert "                timeout=3," in source, "the shared per-request timeout literal must stay in place"
    assert (
        "    async def sync_with_retry(self, max_retries: int = 3) -> SyncReport:" in source
    ), "the shared retry signature line must stay byte-identical (Lead hard gate)"


def test_startup_budget_is_smaller_than_the_shared_defaults():
    """Sanity: the startup budget must actually be a *smaller* budget."""
    assert 0 < STARTUP_CONFIG_TIMEOUT_S < 3, "startup must be faster than the shared per-domain timeout"
    assert 0 < STARTUP_CONFIG_RETRIES < 3, "startup must attempt fewer times than the shared default"
    # Documented arithmetic: attempts x domains x timeout (+ backoff) must fit the 15 s target.
    worst_case = STARTUP_CONFIG_RETRIES * len(CONFIG_DOMAINS) * STARTUP_CONFIG_TIMEOUT_S
    backoff = sum(2**attempt for attempt in range(STARTUP_CONFIG_RETRIES - 1))
    assert worst_case + backoff < 15, f"startup worst case {worst_case + backoff:.1f}s exceeds the 15 s target"


async def test_startup_sync_degrades_in_under_15s_against_a_hung_cp(black_hole_server, capsys):
    """The measured acceptance: a CP that accepts TCP but never answers -> degraded < 15 s."""
    client = ConfigClient(black_hole_server, "test-service-token")
    started = time.monotonic()
    report = await client.sync_with_retry_budget(
        max_retries=STARTUP_CONFIG_RETRIES,
        timeout=STARTUP_CONFIG_TIMEOUT_S,
    )
    elapsed = time.monotonic() - started
    with capsys.disabled():  # always visible in the test output: this number is the evidence
        print(
            f"\n[D32-27] startup sync vs hung CP: {elapsed:.2f}s "
            f"(budget: {STARTUP_CONFIG_RETRIES} attempts x {len(CONFIG_DOMAINS)} domains x "
            f"{STARTUP_CONFIG_TIMEOUT_S}s + backoff; before this change: 58.46s)"
        )

    # Design budget is 13.8 s; the assertion allows ~1.7 s of scheduling slack on a loaded host
    # (the < 15 s target itself is asserted arithmetically in the budget-arithmetic test).
    assert elapsed < 15.5, f"startup sync took {elapsed:.2f}s, over the 15 s target"
    # The per-domain budget really applies (a refused connection would finish far sooner).
    assert elapsed > STARTUP_CONFIG_TIMEOUT_S * len(CONFIG_DOMAINS), (
        f"{elapsed:.2f}s is too fast to have exercised the per-domain budget"
    )
    # Failure semantics unchanged: fail closed -> the caller degrades, never "up with empty config".
    assert report["ok"] is False
    assert report["refreshed"] is False
    assert report["domains"]["llm-provider"]["status"] == "unreachable"


async def test_startup_sync_is_capped_even_when_the_cp_is_not_started(closed_port_url, capsys):
    """A CP that is not started costs the same budget (Windows does not refuse instantly).

    Measured on this host (2026-11-02): `connect()` to a closed *loopback* port returns
    ECONNREFUSED after ~2.03 s, not instantly — which is exactly why the old startup path cost
    8 x 2.03 s per attempt and 58.46 s overall. With the startup budget the wait is cancelled at
    0.8 s per domain, so "not started" and "hung" both land inside the same 15 s envelope; the
    log distinguishes them by the transport error kind when the OS error does arrive in time.
    """
    client = ConfigClient(closed_port_url, "test-service-token")
    started = time.monotonic()
    report = await client.sync_with_retry_budget(
        max_retries=STARTUP_CONFIG_RETRIES,
        timeout=STARTUP_CONFIG_TIMEOUT_S,
    )
    elapsed = time.monotonic() - started
    with capsys.disabled():
        print(
            f"[D32-27] startup sync vs closed port: {elapsed:.2f}s "
            f"(budget-capped; Windows refusal alone takes ~2.03s per connect)"
        )
    assert report["ok"] is False
    assert report["domains"]["llm-provider"]["status"] == "unreachable"
    assert elapsed < 15.5, f"a not-started CP must not exceed the 15 s startup envelope (took {elapsed:.2f}s)"


def test_transport_error_classification_is_by_exception_not_elapsed():
    """The verdict must come from the exception kind (elapsed time is not a reliable signal)."""

    class FakeError(Exception):
        pass

    assert _classify_transport_error(TimeoutError()) == "budget-exhausted"
    assert _classify_transport_error(httpx.ConnectTimeout("timed out")) == "connect-timeout"
    assert _classify_transport_error(httpx.ConnectError("[WinError 10061] actively refused")) == "refused"
    assert _classify_transport_error(httpx.ConnectError("getaddrinfo failed")) == "connect-failed"
    assert _classify_transport_error(FakeError("boom")) == "transport-error"


def test_verdict_distinguishes_cp_not_listening_from_cp_hung():
    unreachable = {
        "ok": False,
        "domains": {domain: {"status": "unreachable", "revision": "", "source": ""} for domain in CONFIG_DOMAINS},
        "revision": "",
        "refreshed": False,
        "degraded": list(CONFIG_DOMAINS),
    }
    assert _sync_failure_verdict(unreachable, "refused") == "cp-not-listening"
    assert _sync_failure_verdict(unreachable, "connect-timeout") == "cp-slow-or-hung"
    assert _sync_failure_verdict(unreachable, "budget-exhausted") == "cp-no-accept-within-budget"
    unauthorized = {**unreachable, "domains": {"llm-provider": {"status": "unauthorized", "revision": "", "source": ""}}}
    assert _sync_failure_verdict(unauthorized, "refused") == "cp-rejected-service-token"
