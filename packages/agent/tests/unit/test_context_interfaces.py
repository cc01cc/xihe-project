"""Tests for the Event Sourcing context interfaces."""

from datetime import UTC, datetime

from xihe_agent.interfaces.context import AgentContext, ContextEpoch, ContextSource
from xihe_agent.interfaces.event import Event
from xihe_agent.interfaces.message import TextMessage


def test_event_with_sequence():
    event = Event(
        aggregate_id="session-1",
        sequence=0,
        type="prompt.admitted",
        payload={"message": {"role": "human", "content": "hello"}},
        created_at=datetime.now(UTC),
    )
    assigned = event.with_sequence(5)
    assert assigned.sequence == 5
    assert assigned.aggregate_id == "session-1"


def test_agent_context_snapshot_roundtrip():
    epoch = ContextEpoch(
        epoch_id="epoch-1",
        baseline_hash="hash-1",
        system_messages=["You are xihe"],
        sources=[ContextSource(key="agents_md", source_type="agents_md", content="hi", content_hash="h1")],
    )
    ctx = AgentContext(
        aggregate_id="session-1",
        latest_sequence=3,
        messages=[TextMessage(role="human", content="hello")],
        epoch=epoch,
        runtime_state={"key": "value"},
    )
    snapshot = ctx.to_snapshot()
    restored = AgentContext.from_snapshot(snapshot)

    assert restored.aggregate_id == "session-1"
    assert restored.latest_sequence == 3
    assert len(restored.messages) == 1
    assert restored.messages[0].role == "human"
    assert restored.messages[0].content == "hello"
    assert restored.epoch is not None
    assert restored.epoch.epoch_id == "epoch-1"
    assert restored.epoch.system_messages == ["You are xihe"]
    assert restored.runtime_state == {"key": "value"}


def test_agent_context_empty():
    ctx = AgentContext.empty("session-2")
    assert ctx.aggregate_id == "session-2"
    assert ctx.latest_sequence == 0
    assert ctx.messages == []
    assert ctx.epoch is None
