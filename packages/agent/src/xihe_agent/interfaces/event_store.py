"""Event Store abstraction.

The CP side is the system of record for events. The agent module defines this
interface so that production code can talk to CP while tests can use an
in-memory implementation.
"""

from abc import ABC, abstractmethod
from collections.abc import AsyncIterator

from xihe_agent.interfaces.event import Event


class EventStore(ABC):
    """Append-only event store for a single aggregate (session)."""

    @abstractmethod
    async def append(self, event: Event) -> Event:
        """Append a single event and return it with an assigned sequence."""
        ...

    @abstractmethod
    async def append_many(self, aggregate_id: str, events: list[Event]) -> list[Event]:
        """Atomically append multiple events."""
        ...

    @abstractmethod
    async def read(
        self,
        aggregate_id: str,
        after_sequence: int = 0,
    ) -> AsyncIterator[Event]:
        """Read events for an aggregate after the given sequence."""
        ...

    @abstractmethod
    async def get_latest_sequence(self, aggregate_id: str) -> int:
        """Return the latest sequence number for the aggregate."""
        ...

    @abstractmethod
    async def fork(
        self,
        source_aggregate_id: str,
        at_sequence: int,
        new_aggregate_id: str,
    ) -> int:
        """Copy events up to `at_sequence` from source to new aggregate."""
        ...
