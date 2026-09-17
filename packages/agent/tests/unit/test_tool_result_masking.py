"""PLAN-294 decision #17 / PLAN-0341 T1.2: tool-result prune layer rules.

The pruner runs on the projection history BEFORE the keep-recent tail is
reached by the LLM: stale tool results that are byte-identical duplicates of
an earlier result, oversized, or outside the fixed cumulative prune window
are replaced with a placeholder. Tool call/result pairing is never broken
(v1 snapshot pairs by adjacency; the pruner only swaps result content).
Prune is eventized as tombstones (I5 anti-resurrection).
"""

from typing import Any

import pytest

from xihe_agent.agent_runner.langgraph_runner import (
    MASK_PLACEHOLDER,
    TOOL_RESULT_MASK_CHARS,
    _align_truncation_start,
    _mask_history_tool_results,
    prune_history_tool_results,
)
from xihe_agent.interfaces.message import TextMessage


# The pruner only acts on history OUTSIDE the keep-recent tail (last 10
# messages). Each tool result is bracketed by enough filler turns to push
# the early ones past the window: 4 filler messages before + 4 after keeps
# every tool message beyond index 10 when there are >=2 results.
def _history(tool_contents: list[str], tail_human_turns: int = 14) -> list[TextMessage]:
    # Tools first, then a long filler tail: the keep-recent window is the
    # LAST 10 messages, so tool results at the front sit outside it and are
    # eligible for pruning. tail_human_turns must keep total size <=
    # (last tool index) + KEEP_RECENT_TAIL for the tools to stay outside.
    messages: list[TextMessage] = []
    for content in tool_contents:
        messages.append(TextMessage(role="human", content="ask"))
        messages.append(TextMessage(role="tool", content=content))
    messages.extend(
        TextMessage(role="human", content=f"post filler {i}")
        for i in range(tail_human_turns)
    )
    return messages


def test_masks_oversized_old_tool_result() -> None:
    big = "x" * (TOOL_RESULT_MASK_CHARS + 1)
    history = _history(["small result", big])
    masked = _mask_history_tool_results(history)

    masked_contents = [m.content for m in masked if m.role == "tool"]
    assert MASK_PLACEHOLDER in masked_contents
    assert big not in masked_contents


def test_keeps_recent_tail_unmasked() -> None:
    # The oversized result sits INSIDE the keep-recent tail (last 10
    # messages) — decision #17 only prunes history outside the window.
    big = "y" * (TOOL_RESULT_MASK_CHARS + 1)
    history = [TextMessage(role="human", content="seed")]
    history += [TextMessage(role="human", content=f"filler {i}") for i in range(9)]
    history.append(TextMessage(role="tool", content=big))
    masked = _mask_history_tool_results(history)

    assert big in [m.content for m in masked]


def test_masks_byte_identical_duplicate_but_keeps_first() -> None:
    duplicate = "same output payload"
    history = _history([duplicate, "other", duplicate])
    masked = _mask_history_tool_results(history)

    tool_contents = [m.content for m in masked if m.role == "tool"]
    assert tool_contents.count(duplicate) == 1, "first occurrence kept, later duplicate masked"


def test_short_unique_results_untouched() -> None:
    history = _history(["alpha", "beta", "gamma"])
    masked = _mask_history_tool_results(history)

    assert [m.content for m in masked] == [m.content for m in history]


def test_message_count_and_order_preserved() -> None:
    big = "z" * (TOOL_RESULT_MASK_CHARS + 1)
    history = _history([big, "beta"])
    masked = _mask_history_tool_results(history)

    assert len(masked) == len(history)
    assert [m.role for m in masked] == [m.role for m in history]


def test_short_history_below_window_is_never_touched() -> None:
    big = "w" * (TOOL_RESULT_MASK_CHARS + 1)
    history = [TextMessage(role="tool", content=big)]
    assert _mask_history_tool_results(history)[0].content == big


@pytest.mark.parametrize("content", ["", MASK_PLACEHOLDER])
def test_non_tool_and_placeholder_inputs_pass_through(content: str) -> None:
    history: list[Any] = [TextMessage(role="human", content=content or "hello")]
    assert _mask_history_tool_results(list(history))[0].content == (content or "hello")


# ---------------------------------------------------------------------------
# PLAN-0341 T1.2 additions: tombstones, prune window, pair-aligned fuse
# ---------------------------------------------------------------------------


def test_prune_emits_tombstone_for_oversized_result() -> None:
    big = "x" * (TOOL_RESULT_MASK_CHARS + 1)
    history = _history(["small result", big])
    result = prune_history_tool_results(history)

    assert len(result.tombstones) == 1
    tomb = result.tombstones[0]
    assert tomb.reason == "oversized"
    assert tomb.pruned is True
    assert tomb.size == len(big)
    assert tomb.head == big[:120]
    assert tomb.tail == big[-120:]
    assert len(tomb.content_hash) == 64


def test_prune_window_chars_prunes_oldest_beyond_budget() -> None:
    # Three unique short results; tiny window keeps only the newest ones.
    history = _history(["aaa-result-1", "bbb-result-2", "ccc-result-3"], tail_human_turns=14)
    result = prune_history_tool_results(history, prune_window_chars=20)

    pruned_contents = [
        m.content for m in result.messages
        if m.role == "tool" and m.content == MASK_PLACEHOLDER
    ]
    assert len(pruned_contents) >= 1, "oldest tool results fall outside the window budget"
    reasons = {t.reason for t in result.tombstones}
    assert "window" in reasons


def test_truncation_fuse_never_orphans_tool_result() -> None:
    # Build history where naive last-20 would start ON a tool message.
    # Pattern: tool, human (repeat) so even indexes are tool results.
    history: list[TextMessage] = []
    for i in range(12):
        history.append(TextMessage(role="tool", content=f"r{i}"))
        history.append(TextMessage(role="human", content=f"q{i}"))
    assert len(history) == 24
    naive_start = len(history) - 20  # = 4 → history[4] is tool "r2"
    assert history[naive_start].role == "tool"

    aligned = _align_truncation_start(history, 20)
    assert aligned < naive_start
    assert history[aligned].role != "tool"
    sliced = history[aligned:]
    assert len(sliced) >= 20
    # No tool message sits at position 0 without its preceding call.
    assert sliced[0].role != "tool"
