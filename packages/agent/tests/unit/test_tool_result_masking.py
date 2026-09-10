"""PLAN-294 decision #17: tool-result masking layer rules (M2 ②2).

The masker runs on the projection history BEFORE the keep-recent tail is
reached by the LLM: stale tool results that are byte-identical duplicates of
an earlier result or oversized are replaced with a placeholder so the
token-dominant observation history does not reach the provider. Tool
call/result pairing is never broken (v1 snapshot pairs by adjacency; the
masker only swaps result content, never reorders or drops messages).
"""

from typing import Any

import pytest

from xihe_agent.agent_runner.langgraph_runner import (
    MASK_PLACEHOLDER,
    TOOL_RESULT_MASK_CHARS,
    _mask_history_tool_results,
)
from xihe_agent.interfaces.message import TextMessage


# The masker only acts on history OUTSIDE the keep-recent tail (last 10
# messages). Each tool result is bracketed by enough filler turns to push
# the early ones past the window: 4 filler messages before + 4 after keeps
# every tool message beyond index 10 when there are >=2 results.
def _history(tool_contents: list[str], tail_human_turns: int = 14) -> list[TextMessage]:
    # Tools first, then a long filler tail: the keep-recent window is the
    # LAST 10 messages, so tool results at the front sit outside it and are
    # eligible for masking. tail_human_turns must keep total size <=
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
    # messages) — decision #17 only masks history outside the window.
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
