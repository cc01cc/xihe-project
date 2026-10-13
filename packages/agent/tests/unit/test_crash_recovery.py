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
    return InMemoryEventStore(
        {
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
        }
    )


async def test_crash_recovery_recovers_session(event_store):
    recovery = CrashRecovery(event_store)
    ctx = await recovery.recover("session-1", after_sequence=0)

    assert ctx.aggregate_id == "session-1"
    assert ctx.latest_sequence == 2
    assert len(ctx.messages) == 2


async def test_crash_recovery_after_sequence_is_cursor_hint_only(event_store):
    recovery = CrashRecovery(event_store)
    live = await recovery.recover("session-1", after_sequence=0)
    resumed = await recovery.recover("session-1", after_sequence=1)

    # PLAN-0416 T2.4: the caller cursor never truncates the rebuild.
    assert resumed.latest_sequence == live.latest_sequence
    assert [(message.role, message.content) for message in resumed.messages] == [
        (message.role, message.content) for message in live.messages
    ]
    assert len(resumed.messages) == 2


async def test_crash_recovery_cursor_never_yields_orphan_tool_suffix():
    events = [
        Event(
            aggregate_id="session-2",
            sequence=1,
            type="prompt.admitted",
            payload={"message": {"role": "human", "content": "question"}},
            created_at=datetime.now(UTC),
        ),
        Event(
            aggregate_id="session-2",
            sequence=2,
            type="tool.called",
            payload={"toolCallId": "call-1", "toolName": "read", "arguments": {"path": "a.txt"}},
            created_at=datetime.now(UTC),
        ),
        Event(
            aggregate_id="session-2",
            sequence=3,
            type="tool.result",
            payload={"toolCallId": "call-1", "toolName": "read", "result": "bounded tool output"},
            created_at=datetime.now(UTC),
        ),
        Event(
            aggregate_id="session-2",
            sequence=4,
            type="assistant.responded",
            payload={"message": {"role": "ai", "content": "answer"}},
            created_at=datetime.now(UTC),
        ),
    ]
    recovery = CrashRecovery(InMemoryEventStore({"session-2": events}))

    # A cursor past the tool pair must not hand back an unpaired result.
    ctx = await recovery.recover("session-2", after_sequence=2)

    assert ctx.latest_sequence == 4
    assert [message.role for message in ctx.messages] == ["human", "ai", "tool", "ai"]
    assert ctx.messages[0].content == "question"
    assert ctx.messages[2].content == "bounded tool output"
    assert ctx.messages[3].content == "answer"


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
