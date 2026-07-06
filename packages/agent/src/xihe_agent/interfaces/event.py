"""Event Sourcing domain events for context management.

These events are the single source of truth for a session's context. They are
persisted by the CP Event Store and projected into an `AgentContext` snapshot.
"""

from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Literal

EventType = Literal[
    "session.created",
    "prompt.admitted",
    "llm.token",
    "tool.called",
    "tool.result",
    "context.source_changed",
    "epoch.started",
    "epoch.replaced",
    "runtime.state_cleared",
    "compaction.applied",
]


@dataclass(frozen=True)
class Event:
    """Immutable domain event."""

    aggregate_id: str  # session_id
    sequence: int
    type: EventType
    payload: dict[str, Any]
    created_at: datetime
    correlation_id: str | None = None
    causation_id: str | None = None

    def with_sequence(self, sequence: int) -> "Event":
        """Return a new event with the assigned sequence number."""
        return Event(
            aggregate_id=self.aggregate_id,
            sequence=sequence,
            type=self.type,
            payload=self.payload,
            created_at=self.created_at,
            correlation_id=self.correlation_id,
            causation_id=self.causation_id,
        )


@dataclass(frozen=True)
class EventEnvelope:
    """Wrapper used when sending events to the CP Event Store."""

    events: list[Event] = field(default_factory=list)
