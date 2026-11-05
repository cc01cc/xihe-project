"""PLAN-0670 T2c.1 — builder wiring: inbound caps log loudly, token budget stays the third line."""

from __future__ import annotations

from xihe_agent.context.builder import _limit_inbound_history, _take_newest
from xihe_agent.interfaces.message import TextMessage


class _RisingCounter:
    """Every message costs one token, so a budget of N keeps N messages."""

    def estimate_messages(self, messages):  # noqa: ANN001, ANN201 - builder protocol
        return len(messages)


def test_overflow_is_trimmed_to_the_newest_and_logged() -> None:
    from loguru import logger

    messages = [{"role": "human", "content": f"m-{index}"} for index in range(2500)]
    records: list[str] = []
    handler = logger.add(lambda message: records.append(str(message)), level="WARNING")
    try:
        kept, truncation = _limit_inbound_history(messages)
    finally:
        logger.remove(handler)

    assert len(kept) == 2000, "the frozen default keeps the newest 2000"
    assert kept[-1] == messages[-1], "newest survive"
    assert truncation is not None
    assert truncation.dropped_messages == 500
    assert any("event=agent_context_truncated" in record for record in records), (
        "an overflow must never be silent"
    )
    assert any("dropped=500" in record for record in records)


def test_under_the_caps_nothing_is_dropped_and_nothing_is_logged() -> None:
    from loguru import logger

    messages = [{"role": "human", "content": "only one"}]
    records: list[str] = []
    handler = logger.add(lambda message: records.append(str(message)), level="WARNING")
    try:
        kept, truncation = _limit_inbound_history(messages)
    finally:
        logger.remove(handler)

    assert kept == messages
    assert truncation is None
    assert records == []


def test_token_budget_remains_the_third_line_of_defence() -> None:
    # 10 messages x 1 token, budget 4: the inbound caps are satisfied (way under 2000/8MiB) but the
    # token budget still trims — the three lines do different jobs.
    groups = [[TextMessage("human", f"m-{index}")] for index in range(10)]

    kept, cut = _take_newest(groups, 4, _RisingCounter())

    assert cut is True, "the token budget is the layer that reports the cut"
    assert len(kept) <= 4
    assert kept[-1].content == "m-9", "and it keeps the newest, like the other two layers"
