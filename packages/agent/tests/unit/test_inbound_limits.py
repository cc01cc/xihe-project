"""PLAN-0670 T2c.1 / T2c.4 — inbound caps and the base64 audit helper."""

from __future__ import annotations

import json

from xihe_agent.context.inbound_limits import (
    DEFAULT_MAX_BYTES,
    DEFAULT_MAX_MESSAGES,
    apply_inbound_limits,
    base64_stats,
    limits_from_env,
    serialised_bytes,
)


def _message(index: int, pad: int = 0) -> dict[str, object]:
    return {"role": "user", "content": f"msg-{index}" + ("x" * pad)}


def test_under_both_limits_keeps_everything_and_reports_no_truncation() -> None:
    messages = [_message(index) for index in range(10)]

    kept, truncation = apply_inbound_limits(messages, max_messages=100, max_bytes=1_000_000)

    assert kept == messages
    assert truncation is None


def test_count_cap_keeps_the_newest_and_marks_what_it_dropped() -> None:
    messages = [_message(index) for index in range(10)]

    kept, truncation = apply_inbound_limits(messages, max_messages=3, max_bytes=1_000_000)

    assert [m["content"] for m in kept] == ["msg-7", "msg-8", "msg-9"]
    assert truncation is not None
    assert truncation.dropped_messages == 7
    assert truncation.kept_messages == 3
    assert truncation.limit_messages == 3
    assert truncation.dropped_bytes > 0
    assert truncation.to_wire()["strategy"] == "newestKeep"


def test_byte_cap_keeps_the_newest_that_fit_and_never_exceeds_the_budget() -> None:
    messages = [_message(index, pad=100) for index in range(10)]
    one_size = serialised_bytes(messages[-1])

    kept, truncation = apply_inbound_limits(messages, max_messages=100,
                                            max_bytes=one_size * 2 + 1)

    assert len(kept) == 2
    assert [m["content"][:5] for m in kept] == ["msg-8", "msg-9"]
    assert truncation is not None
    assert truncation.kept_bytes <= truncation.limit_bytes
    assert truncation.dropped_bytes > 0


def test_defaults_are_the_frozen_numbers_and_env_can_override(monkeypatch) -> None:
    assert DEFAULT_MAX_MESSAGES == 2000
    assert DEFAULT_MAX_BYTES == 8 * 1024 * 1024
    assert limits_from_env() == (DEFAULT_MAX_MESSAGES, DEFAULT_MAX_BYTES)

    monkeypatch.setenv("XIHE_AGENT_CONTEXT_MAX_MESSAGES", "7")
    monkeypatch.setenv("XIHE_AGENT_CONTEXT_MAX_BYTES", "not-a-number")
    assert limits_from_env() == (7, DEFAULT_MAX_BYTES)


def test_base64_audit_counts_inline_blob_bytes_without_rewriting_them() -> None:
    # 3 KiB of "binary" encoded as base64 (4/3 ratio), the shape the image tools produce today.
    import base64

    blob = base64.b64encode(b"\x00" * 3072).decode("ascii")
    tool_result = {"artifact_id": "art-1", "content": [{"type": "text", "text": "ok"}],
                   "image": blob}

    stats = base64_stats(tool_result)

    assert stats["base64Bytes"] == len(blob)
    assert stats["totalBytes"] >= stats["base64Bytes"]
    assert stats["plainBytes"] == stats["totalBytes"] - stats["base64Bytes"]
    # The audit number the Lead asked for: a 3 KiB image rides the wire as 4 KiB of base64.
    assert stats["base64Bytes"] / 3072 > 1.3
    assert tool_result["image"] == blob, "audit only measures — it must never mutate the payload"


def test_serialised_bytes_is_utf8_length_of_compact_json() -> None:
    message = {"role": "user", "content": "中文"}

    assert serialised_bytes(message) == len(
        json.dumps(message, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    )
