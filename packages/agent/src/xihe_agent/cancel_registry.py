"""Run cancel registry for PLAN-290 M0.3.

Tracks active Agent runs by ``run_id`` so an external cancel (CP forward)
can flip an in-flight LangGraph stream into a cancelled terminal outcome.

Three-state semantics (Agent-internal, aligned with CP contract):

- ``accepted``: cancel was applied to a still-active run
- ``unknown``: ``run_id`` is not registered (never started / already finished)
- ``failed``: the cancel action itself raised
"""

from __future__ import annotations

import asyncio
from typing import Literal

from loguru import logger

CancelStatus = Literal["accepted", "unknown", "failed"]

__all__ = ["CancelStatus", "RunCancelRegistry"]


class RunCancelRegistry:
    """In-process registry of cancellable active runs."""

    def __init__(self) -> None:
        self._events: dict[str, asyncio.Event] = {}

    def register(self, run_id: str) -> asyncio.Event:
        """Attach an ``asyncio.Event`` for ``run_id`` and return it.

        Re-registering the same ``run_id`` replaces any previous handle so a
        late cancel cannot flip a newer run that reuses the id.
        """
        event = asyncio.Event()
        self._events[run_id] = event
        return event

    def unregister(self, run_id: str) -> None:
        """Drop the active handle; later cancels return ``unknown``."""
        self._events.pop(run_id, None)

    def cancel(self, run_id: str) -> CancelStatus:
        """Request cancellation of ``run_id``.

        Returns the three-state result; never raises for missing runs.
        """
        try:
            event = self._events.get(run_id)
            if event is None:
                return "unknown"
            event.set()
            logger.info(
                "[LIFECYCLE] service=agent event=run_cancel_accepted runId={}",
                run_id,
            )
            return "accepted"
        except Exception:
            logger.error(
                "[LIFECYCLE] service=agent event=run_cancel_failed runId={}",
                run_id,
                exc_info=True,
            )
            return "failed"
