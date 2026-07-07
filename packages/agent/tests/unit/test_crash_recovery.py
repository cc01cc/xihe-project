"""Tests for crash recovery."""

from datetime import UTC, datetime

import pytest

from xihe_agent.context.crash_recovery import CrashRecovery
from xihe_agent.interfaces.context import AgentContext
from xihe_agent.interfaces.event import Event
from xihe_agent.interfaces.event_store import EventStore


class InMemoryEventStore(EventStore):
    """Test-only event store for crash recovery."""

    def __init__(self, events: dict[str, list[Event]] | None = None):
        self.events = events or {}

    async def append(self, event: Event) -> Event:
        raise NotImplementedError

    async def append_many(self, aggregate_id: str, events: list[Event]) -> list[Event]:
        raise NotImplementedError

    async def read(self, aggregate_id: str, after_sequence: int = 0):
        for event in self.events.get(aggregate_id, []):
            if event.sequence > after_sequence:
                yield event

    async def get_latest_sequence(self, aggregate_id: str) -> int:
        events = self.events.get(aggregate_id, [])
        return max((e.sequence for e in events), default=0)

    async def fork(self, source_aggregate_id: str, at_sequence: int, new_aggregate_id: str) -> int:
        raise NotImplementedError


@pytest.fixture
def event_store():
    return InMemoryEventStore({
        "session-1": [
            Event(
                aggregate_id="session-1",
                sequence=1,
                type="prompt.admitted",
                payload={"message": {"role": "human", "content": "hello"}},
                created_at=datetime.now(UTC),
            ),
            Event(
                aggregate_id="session-1",
                sequence=2,
                type="llm.token",
                payload={"message": {"role": "ai", "content": "hi"}},
                created_at=datetime.now(UTC),
            ),
        ],
    })


async def test_crash_recovery_recovers_session(event_store):
    recovery = CrashRecovery(event_store)
    ctx = await recovery.recover("session-1", after_sequence=0)

    assert ctx.aggregate_id == "session-1"
    assert ctx.latest_sequence == 2
    assert len(ctx.messages) == 2


async def test_crash_recovery_after_sequence_skips_old_events(event_store):
    recovery = CrashRecovery(event_store)
    ctx = await recovery.recover("session-1", after_sequence=1)

    assert ctx.latest_sequence == 2
    assert len(ctx.messages) == 1
    assert ctx.messages[0].content == "hi"


async def test_crash_recovery_recover_many(event_store):
    recovery = CrashRecovery(event_store)
    result = await recovery.recover_many(["session-1"])

    assert "session-1" in result
    assert result["session-1"].latest_sequence == 2


async def test_crash_recovery_latest_sequence(event_store):
    recovery = CrashRecovery(event_store)
    seq = await recovery.latest_sequence("session-1")
    assert seq == 2


async def test_crash_recovery_empty_session():
    store = InMemoryEventStore()
    recovery = CrashRecovery(store)
    ctx = await recovery.recover("session-x", after_sequence=0)

    assert ctx.aggregate_id == "session-x"
    assert ctx.latest_sequence == 0
    assert ctx.messages == []
