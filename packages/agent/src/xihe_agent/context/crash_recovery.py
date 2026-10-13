"""Crash recovery helpers for event-sourced sessions.

When the Agent process restarts it may have lost in-memory state for sessions
that were in flight. This module reads uncommitted events from the CP Event
Store and reconstructs an ``AgentContext`` so the session can continue.
"""

from __future__ import annotations

from typing import Any

from loguru import logger

from xihe_agent.interfaces.context import AgentContext
from xihe_agent.interfaces.event import Event
from xihe_agent.interfaces.event_store import EventStore


class CrashRecovery:
    """Reconstructs ``AgentContext`` from events stored in the CP Event Store."""

    def __init__(self, event_store: EventStore) -> None:
        self._event_store = event_store

    async def recover(self, session_id: str, after_sequence: int = 0) -> AgentContext:
        """Rebuild the context from the session's full durable history.

        PLAN-0416 T2.4: recovery is never a suffix replay. ``after_sequence``
        is the caller's cursor (the last sequence it had already seen); the
        rebuild always starts at 0 so a resumed Run sees exactly the projection
        a live read returns — never an empty state built from an empty suffix,
        and never an orphaned suffix whose tool pair, prune tombstone or native
        carrier predates the cursor.
        """
        if after_sequence > 0:
            logger.info(
                "Recovering session {} (caller cursor {} is a hint; replaying full history)",
                session_id,
                after_sequence,
            )
        events: list[Event] = []
        async for event in self._event_store.read(session_id, after_sequence=0):
            events.append(event)

        context = AgentContext.from_events(session_id, events)
        logger.info(
            "Recovered session {} with {} event(s), latest_sequence={}",
            session_id,
            len(events),
            context.latest_sequence,
        )
        return context

    async def recover_many(
        self,
        session_ids: list[str],
        after_sequences: dict[str, int] | None = None,
    ) -> dict[str, AgentContext]:
        """Recover multiple sessions in parallel.

        ``after_sequences`` maps a session id to the last sequence already seen
        by the caller. Sessions without an entry default to 0.
        """
        after_sequences = after_sequences or {}
        results: dict[str, AgentContext] = {}
        for session_id in session_ids:
            after = after_sequences.get(session_id, 0)
            try:
                results[session_id] = await self.recover(session_id, after_sequence=after)
            except Exception:
                logger.warning("Failed to recover session {}", session_id, exc_info=True)
        return results

    async def latest_sequence(self, session_id: str) -> int:
        """Return the latest sequence number known to the event store."""
        return await self._event_store.get_latest_sequence(session_id)


def _render_event(event: Event) -> dict[str, Any]:
    """Return a debug-friendly summary of an event."""
    return {
        "aggregate_id": event.aggregate_id,
        "sequence": event.sequence,
        "type": event.type,
    }
