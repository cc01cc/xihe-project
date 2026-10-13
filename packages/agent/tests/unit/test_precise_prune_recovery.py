"""PLAN-0416: occurrence pruning must survive replay and snapshot recovery."""

from datetime import UTC, datetime
from hashlib import sha256

import pytest

from xihe_agent.interfaces.context import AgentContext
from xihe_agent.interfaces.event import Event


def event(sequence, kind, payload, run_id=""):
    return Event(
        aggregate_id="session",
        sequence=sequence,
        type=kind,
        payload=payload,
        created_at=datetime.now(UTC),
        correlation_id=run_id,
    )


def result(sequence, call_id, run_id=""):
    return event(
        sequence, "tool.result", {"result": "identical-output", "toolCallId": call_id, "toolName": "read_file"}, run_id
    )


def replay(events):
    context = AgentContext.empty("session")
    for item in events:
        context.apply_event(item)
    return context


@pytest.mark.parametrize(
    "target",
    [
        {"sequence": 2},
        {"tool_call_id": "call-b"},
        {"sequence": 2, "tool_call_id": "call-b", "content_hash": sha256(b"identical-output").hexdigest()},
    ],
)
def test_same_text_occurrences_prune_precisely_and_roundtrip(target):
    events = [result(1, "call-a"), result(2, "call-b"), event(3, "context.prune", {"tombstones": [target]})]
    context = replay(events)
    messages = context.to_snapshot()["messages"]
    assert messages[0]["content"] == "identical-output"
    assert messages[0]["sequence"] == 1
    assert "pruned" not in messages[0]
    assert messages[1]["content"] == "[old tool result cleared]"
    assert messages[1]["sequence"] == 2
    assert messages[1]["tool_call_id"] == "call-b"
    assert messages[1]["pruned"] is True
    assert AgentContext.from_snapshot(context.to_snapshot()).to_snapshot() == context.to_snapshot()
    assert replay(events).to_snapshot() == context.to_snapshot()


def test_compaction_snapshot_and_full_replay_are_equal_without_resurrection():
    events = [event(i, "prompt.admitted", {"content": f"old-{i}"}) for i in range(1, 13)]
    events.extend(
        [
            result(13, "call-a"),
            result(14, "call-b"),
            event(15, "context.prune", {"tombstones": [{"sequence": 14, "tool_call_id": "call-b"}]}),
            event(
                16,
                "compaction.applied",
                {"summary": "compacted", "summaryHash": "summary-hash", "contextEpoch": "epoch"},
            ),
        ]
    )
    live = replay(events[:15])
    restarted = AgentContext.from_snapshot(live.to_snapshot())
    restarted.apply_event(events[-1])
    full = replay(events)
    assert restarted.to_snapshot() == full.to_snapshot()
    assert full.messages[-2].content == "identical-output"
    assert full.messages[-1].pruned is True


def test_legacy_hash_pruning_remains_compatible():
    context = replay(
        [
            result(1, "call-a"),
            result(2, "call-b"),
            event(3, "context.prune", {"tombstones": [{"content_hash": sha256(b"identical-output").hexdigest()}]}),
        ]
    )
    assert all(message.pruned for message in context.messages)


def test_precise_sequence_does_not_expand_to_reused_call_id_in_another_run():
    events = [
        result(1, "reused-id", "run-a"),
        result(2, "reused-id", "run-b"),
        event(3, "context.prune", {"tombstones": [{"sequence": 2, "tool_call_id": "reused-id"}]}),
    ]
    context = replay(events)
    assert context.messages[0].content == "identical-output"
    assert not context.messages[0].pruned
    assert context.messages[1].pruned


def test_multiple_precise_tombstones_keep_sequence_call_pairing():
    context = replay(
        [
            result(1, "a"),
            result(2, "b"),
            result(3, "a"),
            event(
                4,
                "context.prune",
                {"tombstones": [{"sequence": 1, "tool_call_id": "b"}, {"sequence": 2, "tool_call_id": "a"}]},
            ),
        ]
    )
    assert all(not message.pruned for message in context.messages)


def carrier(sequence, run_id):
    return event(
        sequence,
        "assistant.responded",
        {
            "message": {
                "role": "ai",
                "content": "final",
                "apiTypeId": "openai-chat-completions",
                "apiTypeVersion": 1,
                "nativeRecords": [{"role": "tool", "tool_call_id": "call-b", "content": "identical-output"}],
            }
        },
        run_id,
    )


@pytest.mark.parametrize("prune_first", [True, False])
def test_precise_prune_atomically_removes_native_carrier_and_blocks_late_carrier(prune_first):
    initial = [result(1, "call-a", "run-a"), result(2, "call-b", "run-b")]
    prune = event(3 if prune_first else 4, "context.prune", {"tombstones": [{"sequence": 2, "tool_call_id": "call-b"}]})
    native = carrier(4 if prune_first else 3, "run-b")
    events = initial + ([prune, native] if prune_first else [native, prune]) + [carrier(5, "run-b")]
    context = replay(events)
    assert context.messages[0].content == "identical-output"
    assert context.messages[0].tool_call_id == "call-a"
    assert all(message.native_records is None for message in context.messages)
    assert not any(
        message.content == "identical-output" and message.tool_call_id == "call-b" for message in context.messages
    )
    assert replay(events).to_snapshot() == context.to_snapshot()


def test_native_carrier_uses_real_event_sequence_for_direct_prune():
    context = replay([carrier(1, "run-b")])
    assert context.messages[0].origin_sequence == 1
    assert context.to_snapshot()["messages"][0]["sequence"] == 1
    context.apply_event(event(2, "context.prune", {"tombstones": [{"sequence": 1}]}))
    assert context.messages == []


async def test_crash_recovery_cursor_replays_full_native_prune_state():
    from xihe_agent.context.crash_recovery import CrashRecovery

    events = [
        result(1, "call-a", "run-a"),
        result(2, "call-b", "run-b"),
        carrier(3, "run-b"),
        event(4, "context.prune", {"tombstones": [{"sequence": 2, "tool_call_id": "call-b"}]}),
        carrier(5, "run-b"),
    ]

    class Store:
        calls = []

        async def read(self, aggregate_id, after_sequence=0):
            self.calls.append(after_sequence)
            for item in events:
                if item.sequence > after_sequence:
                    yield item

    store = Store()
    full = replay(events)
    restored = await CrashRecovery(store).recover("session", after_sequence=4)
    assert store.calls == [0]
    assert restored.to_snapshot() == full.to_snapshot()
    assert AgentContext.from_snapshot(full.to_snapshot()).to_snapshot() == restored.to_snapshot()
    assert len(restored.messages) == 1
    assert restored.messages[0].tool_call_id == "call-a"
