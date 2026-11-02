"""Agent process-config readiness state machine with a single-flight lazy load.

PLAN-0632 D32-27 Step 2 (Agent side). Not to be confused with `config_snapshot.py`, which
serves the CP-built *run* snapshot over HTTP; this module tracks whether the Agent's own
process-level business configuration has been loaded.

Why a state machine instead of "the startup path either worked or degraded":

* The startup sync is now cheap (2.65 s, measures in `config_client.STARTUP_CONFIG_*`), but it
  can still fail — for example when the Agent is launched before the CP is up. A failure must
  not freeze the process into "degraded forever": the first request that actually needs config
  should be able to trigger a load.
* Conversely, a request must never observe half-loaded config. So exactly one loader runs at a
  time (single flight): the first caller starts it, every other caller awaits the same task.
* Health must not report ready just because the process is up. `READY` is only reachable after
  a load that produced a usable config report, so `llmReady == "ready"` can never be observed
  while `configState != "ready"`.

State transitions (the invariant the startup comment in `main.lifespan` now points at):

    PENDING --(first request / first need)--> LOADING --> READY
                                                  |
                                                  +--(failure/timeout)--> FAILED --(next request)--> LOADING ...

    * -> READY is only entered by a successful load; a later failed *periodic* refresh does NOT
    move the state (last known good config stays usable — `config_client.sync` keeps the
    carried-over snapshot on transport failure by design).

`note_startup_result` maps the startup attempt onto this machine: success -> READY, failure ->
PENDING (deliberately **not** FAILED: a failed startup means "nothing tried yet, someone should
trigger it", not "the CP refuses this process").
"""

from __future__ import annotations

import asyncio
import time
from collections.abc import Awaitable, Callable
from enum import StrEnum
from typing import Any

from loguru import logger

from xihe_agent.config_client import SyncReport

# Bounded deadline for one lazy load, including its own retry rounds. Startup costs ~2.65 s
# (2 rounds x 0.8 s + backoff), so 5 s leaves room for a slow CP without letting a request hang.
# A caller that exceeds this gets CONFIG_UNAVAILABLE fail-closed; the shared load keeps running
# and its eventual result still lands in the state machine for the next caller.
LAZY_LOAD_DEADLINE_S = 5.0


class ConfigState(StrEnum):
    PENDING = "pending"
    LOADING = "loading"
    READY = "ready"
    FAILED = "failed"


class ConfigUnavailableError(RuntimeError):
    """Explicit fail-closed error: config is not usable, and saying so beats returning `None`.

    Callers map this to the `CONFIG_UNAVAILABLE` problem code (see `api/chat.py`).
    """

    code = "CONFIG_UNAVAILABLE"

    def __init__(self, detail: str):
        super().__init__(detail)
        self.detail = detail


Loader = Callable[[], Awaitable[SyncReport]]

_loader: Loader | None = None
_state: ConfigState = ConfigState.PENDING
_report: SyncReport | None = None
_last_error: str | None = None
_loads = 0
_ready_at: float | None = None
_flight: asyncio.Task[SyncReport] | None = None
_lock: asyncio.Lock | None = None
_lock_loop: Any = None


def set_loader(loader: Loader) -> None:
    """Inject the load function (main wires this to `reload_runtime_config`)."""
    global _loader
    _loader = loader


def get_state() -> ConfigState:
    return _state


def is_ready() -> bool:
    return _state is ConfigState.READY


def snapshot() -> dict[str, Any]:
    """Health-facing view. Never triggers a load (a probe must not do work)."""
    return {
        "state": _state.value,
        "loads": _loads,
        "lastError": _last_error,
        "readyAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(_ready_at)) if _ready_at else None,
        "revision": _report["revision"] if _report else "",
    }


def note_startup_result(report: SyncReport) -> None:
    """Record the one startup attempt: success -> READY, otherwise -> PENDING.

    PENDING (not FAILED) on purpose: a failed startup means the CP was not reachable *then* and
    the first request that needs config should try once more. FAILED is reserved for a lazy load
    that actually ran and failed.
    """
    global _state, _report, _ready_at, _last_error
    if report.get("ok"):
        _state = ConfigState.READY
        _report = report
        _ready_at = time.time()
        _last_error = None
        logger.info(
            "[CONFIG] service=agent event=config_state_change from=pending to=ready revision={}",
            report.get("revision") or "",
        )
        return
    _state = ConfigState.PENDING
    _last_error = "startup sync degraded"
    logger.warning(
        "[CONFIG] service=agent event=config_state_change from=pending to=pending "
        "reason=startup_sync_failed (first request will retry)"
    )


def note_startup_exception(error: BaseException) -> None:
    """Startup raised instead of returning a report: same PENDING outcome, error recorded."""
    global _state, _last_error
    _state = ConfigState.PENDING
    _last_error = type(error).__name__
    logger.warning(
        "[CONFIG] service=agent event=config_state_change from=pending to=pending "
        "reason=startup_exception error={} (first request will retry)",
        _last_error,
    )


def _running_lock() -> asyncio.Lock:
    """One lock per event loop (tests build a fresh loop per case)."""
    global _lock, _lock_loop
    loop = asyncio.get_running_loop()
    if _lock is None or _lock_loop is not loop:
        _lock = asyncio.Lock()
        _lock_loop = loop
    return _lock


async def ensure_config_ready(
    *,
    trigger: str,
    deadline_s: float = LAZY_LOAD_DEADLINE_S,
) -> SyncReport:
    """Return a loaded config report, loading it at most once across concurrent callers.

    `trigger` only labels the log line (e.g. "chat"); it never affects the caching decision.
    Raises `ConfigUnavailableError` (code CONFIG_UNAVAILABLE) when the load fails or exceeds
    `deadline_s` — never returns a half-filled report.
    """
    global _flight, _loads, _state
    if _state is ConfigState.READY and _report is not None:
        return _report

    if _loader is None:
        raise ConfigUnavailableError("no config loader configured")

    async with _running_lock():
        task = _flight
        if task is None or task.done():
            _loads += 1
            _state = ConfigState.LOADING
            logger.info(
                "[CONFIG] service=agent event=config_load_start trigger={} load={} state=loading",
                trigger,
                _loads,
            )
            task = asyncio.create_task(_run_loader(trigger), name=f"config-load:{trigger}")
            _flight = task

    # Everyone (including late comers) awaits the SAME task; `shield` keeps one caller's timeout
    # from cancelling the shared load for the others.
    try:
        return await asyncio.wait_for(asyncio.shield(task), timeout=deadline_s)
    except TimeoutError:
        _mark_failed(f"lazy load exceeded {deadline_s:.1f}s (trigger={trigger})")
        raise ConfigUnavailableError(f"config load exceeded {deadline_s:.1f}s") from None


async def _run_loader(trigger: str) -> SyncReport:
    assert _loader is not None
    started = time.monotonic()
    try:
        report = await _loader()
    except asyncio.CancelledError:
        raise
    except Exception as exc:  # noqa: BLE001 - turned into an explicit ConfigUnavailable
        _mark_failed(f"{type(exc).__name__}: {exc}")
        raise ConfigUnavailableError(f"config load raised {type(exc).__name__}") from exc
    if not report.get("ok"):
        _mark_failed("lazy load returned a degraded report")
        raise ConfigUnavailableError("config load returned a degraded report")
    global _state, _report, _ready_at, _last_error
    _state = ConfigState.READY
    _report = report
    _ready_at = time.time()
    _last_error = None
    logger.info(
        "[CONFIG] service=agent event=config_state_change from=loading to=ready trigger={} "
        "elapsed={:.2f}s revision={}",
        trigger,
        time.monotonic() - started,
        report.get("revision") or "",
    )
    return report


def _mark_failed(detail: str) -> None:
    global _state, _last_error
    _state = ConfigState.FAILED
    _last_error = detail
    logger.error(
        "[CONFIG] service=agent event=config_state_change to=failed detail={} (requests fail with CONFIG_UNAVAILABLE)",
        detail,
    )


def reset_for_tests() -> None:
    """Test hook only: reset the machine (never called from production code)."""
    global _state, _report, _last_error, _loads, _ready_at, _flight, _lock, _lock_loop, _loader
    _state = ConfigState.PENDING
    _report = None
    _last_error = None
    _loads = 0
    _ready_at = None
    _flight = None
    _lock = None
    _lock_loop = None
    _loader = None
