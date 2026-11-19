"""task-110: hybrid context compaction — budget trigger, rollback switch, fact fidelity.

Card: internal/A03-xihe/handoff/open-cards-2026-11-19.md section task-110 (R1-R4).
These tests pin the four readings that must hold without a live stack:

- R1 (unit half): the switch and the trigger share one decision — 'off' never
  prunes, 'overflow' prunes exactly like before, 'budget' only above 0.8x window.
  The real long run is a separate live reading.
- R2: the fact triple (tool calls / approval ids / file paths) is identical before
  and after, and an injected pruner that drops a tool_call_id makes the assertion
  go red (revert) instead of passing quietly.
- R3: savings are computable (compacted history is strictly smaller) and a run
  below the budget trigger saves exactly 0 and reports applied=False.
- R4: a pruner exception or a fidelity mismatch is never a silent downgrade — the
  outcome is reverted, the original history is returned, and the reason is on the
  outcome so the caller can put it on the 'context.prune' event.
"""

from typing import Any

import pytest

from xihe_agent.agent_runner.langgraph_runner import (
    MASK_PLACEHOLDER,
    TOOL_RESULT_MASK_CHARS,
    prune_history_tool_results,
)
from xihe_agent.context.compaction import (
    BUDGET_TRIGGER_RATIO,
    DEFAULT_COMPACTION_MODE,
    FACT_STUB_PREFIX,
    CompactionOutcome,
    apply_compaction,
    extract_facts,
    facts_diff,
    normalize_mode,
    render_fact_stub,
    resolve_threshold,
)
from xihe_agent.interfaces.message import TextMessage


def _history(tool_contents: list[str], tail_human_turns: int = 14) -> list[TextMessage]:
    """Tool results first, then a filler tail so they sit outside the keep-recent window."""
    messages: list[TextMessage] = []
    for index, content in enumerate(tool_contents):
        messages.append(TextMessage(role="human", content="ask"))
        messages.append(TextMessage(role="tool", content=content, tool_call_id=f"call-{index}"))
    messages.extend(TextMessage(role="human", content=f"post filler {i}") for i in range(tail_human_turns))
    return messages


def _chars(messages: list[Any]) -> int:
    return sum(len(str(getattr(message, "content", ""))) for message in messages)


def test_normalize_mode_falls_back_to_today_on_unknown_value() -> None:
    assert DEFAULT_COMPACTION_MODE == "overflow"
    assert normalize_mode("off") == "off"
    assert normalize_mode("  BUDGET ") == "budget"
    assert normalize_mode(None) == "overflow"
    assert normalize_mode("") == "overflow"
    assert normalize_mode("cumulative") == "overflow"


def test_resolve_threshold_is_80_percent_of_window() -> None:
    assert BUDGET_TRIGGER_RATIO == 0.8
    assert resolve_threshold(10_000) == 8_000
    # An unresolved model window falls back to the code default window (128k).
    assert resolve_threshold(None) == 102_400


def test_off_mode_never_prunes() -> None:
    history = _history(["z" * (TOOL_RESULT_MASK_CHARS + 10)])

    outcome = apply_compaction(
        history,
        mode="off",
        prune_window_chars=80_000,
        max_input_tokens=10_000,
        estimated_input_tokens=9_999,
    )

    assert outcome.triggered is False
    assert outcome.reverted is False
    assert outcome.applied is False
    assert outcome.reason == "mode_off"
    assert outcome.pruned_count == 0
    assert _chars(outcome.messages) == _chars(history)


def test_overflow_mode_prunes_exactly_like_before() -> None:
    big = "q" * (TOOL_RESULT_MASK_CHARS + 10)
    history = _history([big])

    outcome = apply_compaction(
        history,
        mode="overflow",
        prune_window_chars=80_000,
        max_input_tokens=128_000,
        estimated_input_tokens=1,
    )

    # 'overflow' ignores the token budget: today's behaviour prunes every run.
    assert outcome.triggered is True
    assert outcome.applied is True
    assert outcome.reason == "applied"
    assert big not in [str(message.content) for message in outcome.messages]
    assert _chars(outcome.messages) < _chars(history)


def test_budget_mode_below_threshold_saves_zero() -> None:
    big = "w" * (TOOL_RESULT_MASK_CHARS + 10)
    history = _history([big])

    outcome = apply_compaction(
        history,
        mode="budget",
        prune_window_chars=80_000,
        max_input_tokens=10_000,
        estimated_input_tokens=7_999,
    )

    assert outcome.triggered is False
    assert outcome.applied is False
    assert outcome.pruned_count == 0
    assert outcome.reason == "below_threshold"
    assert outcome.threshold_tokens == 8_000
    assert _chars(outcome.messages) == _chars(history)


def test_budget_mode_at_threshold_prunes_and_saves() -> None:
    big = "e" * (TOOL_RESULT_MASK_CHARS + 10)
    history = _history([big])

    outcome = apply_compaction(
        history,
        mode="budget",
        prune_window_chars=80_000,
        max_input_tokens=10_000,
        estimated_input_tokens=8_000,
    )

    assert outcome.triggered is True
    assert outcome.applied is True
    saved = _chars(history) - _chars(outcome.messages)
    # R3: savings are measured, not assumed — the body shrinks to the bare mask
    # (this body holds no facts, so no stub is appended).
    assert saved == len(big) - len(MASK_PLACEHOLDER), "R3: savings must be measurable"
    assert saved > 0
    assert outcome.estimated_input_tokens == 8_000


def test_fact_triple_survives_pruning() -> None:
    body = (
        "tool output: approvalRequestId=apr-7f3a21 raised for path=src/xihe_agent/api/chat.py "
        "and path=docs/design/context.md"
    )
    history = _history([body * 60])

    before = extract_facts(history)
    outcome = apply_compaction(
        history,
        mode="budget",
        prune_window_chars=80_000,
        max_input_tokens=10_000,
        estimated_input_tokens=9_000,
    )

    assert outcome.applied is True
    after = extract_facts(outcome.messages)
    assert outcome.facts_before == outcome.facts_after == before
    assert facts_diff(before, after) == {}
    assert "apr-7f3a21" in before.approval_ids
    assert "src/xihe_agent/api/chat.py" in before.file_paths
    # The masked body carries the fact stub instead of losing those facts.
    masked = [str(message.content) for message in outcome.messages if message.role == "tool"]
    assert any(FACT_STUB_PREFIX in content and "apr-7f3a21" in content for content in masked)


def test_missing_tool_call_id_makes_the_assertion_red() -> None:
    """R2 counter-example: an injected pruner drops one tool_call_id -> revert."""

    big = "r" * (TOOL_RESULT_MASK_CHARS + 10)
    history = _history([big])

    def lossy_pruner(messages: list[Any], *, prune_window_chars: int, fact_stub: Any) -> Any:
        class _Result:
            tombstones = ["tombstone"]
            # Same length, same roles — only the pairing fact is gone.
            messages = [TextMessage(role="human", content="ask"), TextMessage(role="tool", content=MASK_PLACEHOLDER)]

        return _Result()

    outcome = apply_compaction(
        history,
        mode="budget",
        prune_window_chars=80_000,
        max_input_tokens=10_000,
        estimated_input_tokens=9_000,
        pruner=lossy_pruner,
    )

    assert outcome.reverted is True
    assert outcome.applied is False
    assert outcome.reason == "fidelity_mismatch"
    assert outcome.error is not None and "tool_call_id" in outcome.error
    # Not a silent downgrade: the run continues with the UNCOMPRESSED history.
    assert _chars(outcome.messages) == _chars(history)
    assert [str(m.content) for m in outcome.messages] == [str(m.content) for m in history]


def test_pruner_exception_reverts_instead_of_degrading() -> None:
    history = _history(["s" * (TOOL_RESULT_MASK_CHARS + 10)])

    def boom(messages: list[Any], *, prune_window_chars: int, fact_stub: Any) -> Any:
        raise RuntimeError("assembly exploded")

    outcome = apply_compaction(
        history,
        mode="overflow",
        prune_window_chars=80_000,
        max_input_tokens=128_000,
        estimated_input_tokens=9_000,
        pruner=boom,
    )

    assert isinstance(outcome, CompactionOutcome)
    assert outcome.reverted is True
    assert outcome.applied is False
    assert outcome.reason == "pruner_error"
    assert outcome.error == "RuntimeError: assembly exploded"
    assert _chars(outcome.messages) == _chars(history)
    payload = outcome.to_payload()
    assert payload["reverted"] is True and payload["reason"] == "pruner_error"


def test_no_candidates_reports_noop_without_tombstones() -> None:
    history = _history(["short result"])

    outcome = apply_compaction(
        history,
        mode="overflow",
        prune_window_chars=80_000,
        max_input_tokens=128_000,
        estimated_input_tokens=500,
    )

    assert outcome.applied is False
    assert outcome.reverted is False
    assert outcome.reason == "no_candidates"
    assert _chars(outcome.messages) == _chars(history)


def test_render_fact_stub_is_none_without_facts() -> None:
    assert render_fact_stub(TextMessage(role="tool", content="plain tool output, nothing indexed")) is None
    stub = render_fact_stub(TextMessage(role="tool", content="wrote file src/app/main.py ok"))
    assert stub is not None
    assert stub.startswith(FACT_STUB_PREFIX)
    assert "path=src/app/main.py" in stub


def test_mask_without_fact_stub_keeps_the_bare_placeholder() -> None:
    """The pre-task-110 mask shape is unchanged when no fact_stub is injected."""

    big = "t" * (TOOL_RESULT_MASK_CHARS + 10)
    history = _history([big])

    result = prune_history_tool_results(history, prune_window_chars=80_000)
    masked = [str(message.content) for message in result.messages if message.role == "tool"]
    assert MASK_PLACEHOLDER in masked
    assert all(FACT_STUB_PREFIX not in content for content in masked)


def test_mask_with_fact_stub_keeps_facts_after_placeholder() -> None:
    big = ("see path=src/x.py and " + "u" * TOOL_RESULT_MASK_CHARS) * 3
    history = _history([big])

    result = prune_history_tool_results(history, prune_window_chars=80_000, fact_stub=render_fact_stub)
    masked = [str(message.content) for message in result.messages if message.role == "tool"]
    hit = [content for content in masked if FACT_STUB_PREFIX in content]
    assert hit, "a body that held a path must carry the stub"
    assert hit[0].startswith(MASK_PLACEHOLDER)
    assert "path=src/x.py" in hit[0]


@pytest.mark.parametrize("mode", ["off", "budget", "overflow"])
def test_every_mode_returns_a_usable_history(mode: str) -> None:
    history = _history(["v" * (TOOL_RESULT_MASK_CHARS + 10)])

    outcome = apply_compaction(
        history,
        mode=mode,
        prune_window_chars=80_000,
        max_input_tokens=10_000,
        estimated_input_tokens=9_000,
    )

    assert len(outcome.messages) == len(history)
    assert all(getattr(message, "role", None) for message in outcome.messages)
