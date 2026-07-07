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


def test_agent_context_apply_prompt_admitted():
    ctx = AgentContext.empty("session-1")
    event = Event(
        aggregate_id="session-1",
        sequence=1,
        type="prompt.admitted",
        payload={"message": {"role": "human", "content": "hello"}},
        created_at=datetime.now(UTC),
    )
    ctx.apply_event(event)
    assert ctx.latest_sequence == 1
    assert len(ctx.messages) == 1
    assert ctx.messages[0].role == "human"
    assert ctx.messages[0].content == "hello"


def test_agent_context_apply_llm_token():
    ctx = AgentContext.empty("session-1")
    event = Event(
        aggregate_id="session-1",
        sequence=2,
        type="llm.token",
        payload={"message": {"role": "ai", "content": "hi there"}},
        created_at=datetime.now(UTC),
    )
    ctx.apply_event(event)
    assert ctx.latest_sequence == 2
    assert len(ctx.messages) == 1
    assert ctx.messages[0].role == "ai"
    assert ctx.messages[0].content == "hi there"


def test_agent_context_apply_tool_result():
    ctx = AgentContext.empty("session-1")
    event = Event(
        aggregate_id="session-1",
        sequence=3,
        type="tool.result",
        payload={"tool_name": "read_file", "result": {"content": "file content"}},
        created_at=datetime.now(UTC),
    )
    ctx.apply_event(event)
    assert ctx.latest_sequence == 3
    assert len(ctx.messages) == 1
    assert ctx.messages[0].role == "tool"
    assert ctx.messages[0].content == "file content"


def test_agent_context_apply_epoch_started():
    ctx = AgentContext.empty("session-1")
    event = Event(
        aggregate_id="session-1",
        sequence=1,
        type="epoch.started",
        payload={
            "epoch_id": "epoch-1",
            "baseline_hash": "hash-1",
            "system_messages": ["You are xihe"],
            "sources": [{"key": "agents_md", "source_type": "agents_md", "content": "hi", "content_hash": "h1"}],
        },
        created_at=datetime.now(UTC),
    )
    ctx.apply_event(event)
    assert ctx.latest_sequence == 1
    assert ctx.epoch is not None
    assert ctx.epoch.epoch_id == "epoch-1"
    assert ctx.epoch.system_messages == ["You are xihe"]
    assert len(ctx.epoch.sources) == 1
    assert ctx.epoch.sources[0].key == "agents_md"


def test_agent_context_apply_session_forked():
    ctx = AgentContext.empty("session-2")
    event = Event(
        aggregate_id="session-2",
        sequence=1,
        type="session.forked",
        payload={"source_session_id": "session-1", "at_sequence": 5},
        created_at=datetime.now(UTC),
    )
    ctx.apply_event(event)
    assert ctx.metadata["forked_from"] == {"source_session_id": "session-1", "at_sequence": 5}


def test_agent_context_apply_compaction():
    ctx = AgentContext.empty("session-1")
    ctx.messages.append(TextMessage(role="human", content="old"))
    event = Event(
        aggregate_id="session-1",
        sequence=10,
        type="compaction.applied",
        payload={"summary": "summary of conversation"},
        created_at=datetime.now(UTC),
    )
    ctx.apply_event(event)
    assert len(ctx.messages) == 1
    assert ctx.messages[0].role == "system"
    assert ctx.messages[0].content == "summary of conversation"


def test_agent_context_from_events():
    events = [
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
    ]
    ctx = AgentContext.from_events("session-1", events)
    assert ctx.aggregate_id == "session-1"
    assert ctx.latest_sequence == 2
    assert len(ctx.messages) == 2
    assert ctx.messages[0].role == "human"
    assert ctx.messages[1].role == "ai"
