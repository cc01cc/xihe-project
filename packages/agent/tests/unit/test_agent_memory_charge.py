"""PLAN-0629 收尾（2026-11-04）：``agent_memory`` 计费幂等 —— 镜像 ``test_skill_catalog_charge.py``.

The 0628 skills listing got these invariants in ``805dc9fd``; the memory twin (same seam, same
ledger) lagged behind. This file pins the parity, five tests:

1. a first render books the charge on the **run-scoped** ledger, and the reported token count is
   the ledger's own number (``bySource.memory``), never a locally summed estimate;
2. a second render **in the same run** does not spend the pool twice — same text, ``charged == 0``,
   ledger untouched (``try_charge`` is not idempotent, so skipping booked keys is the caller's job);
3. a **reordered** replay does not charge again — the ledger key is the content hash
   (``_entry_key``), not the positional index, so CP re-ordering between renders cannot mint new
   keys for the same rows;
4. an **interrupted** render (the block is dropped, the seam re-enters) replays without double
   charging. Scope note: the ledger is run-scoped and *never persisted*
   (``injection_budget.InjectionLedger`` doc), so "replay" here means re-entry within one run —
   a cross-process restart starts a new run with a new ledger and is out of scope by design;
5. a **pool-driven cut still pays for the sentence** (D28-41): when the shared pool is what stops
   the block, the truncation note is still reserved before the entries and still renders.
"""

from __future__ import annotations

from typing import Any

from xihe_agent.context.agent_memory import (
    HEADER_KEY,
    MEMORY_TRUNCATION_NOTE,
    SOURCE_AGENT_MEMORY,
    STATUS_READY,
    STATUS_TRUNCATED,
    TRUNCATION_NOTE_KEY,
    _entry_key,
    render_agent_memory,
    render_from_component_sources,
)
from xihe_agent.context.injection_budget import InjectionLedger
from xihe_agent.context.nested_injection import INJECTION_LEDGER_KEY, ledger_for_context


def _entry(content: str, *, pinned: bool = False) -> dict[str, Any]:
    return {
        "pinned": pinned,
        "updatedAt": "2026-11-04T10:00:00Z",
        "content": content,
        "tokens": max(1, len(content) // 2),
    }


def _entries(count: int, *, size: int = 20) -> list[dict[str, Any]]:
    return [_entry(f"memory-{index:03d} " + "x" * size) for index in range(count)]


def _source(entries: list[dict[str, Any]], *, status: str = "ready") -> dict[str, Any]:
    return {
        "source": SOURCE_AGENT_MEMORY,
        "status": status,
        "entries": entries,
        "truncated": False,
        "diagnostics": [],
        "maxEntries": 24,
        "maxTokens": 4_000,
        "usedTokens": 0,
    }


class _RunContext:
    """Minimal stand-in for the run context (only ``metadata`` is read by the ledger)."""

    def __init__(self, window_tokens: int = 128_000, assembled_tokens: int = 0) -> None:
        self.metadata: dict[str, object] = {
            "windowTokens": window_tokens,
            "assembledTokens": assembled_tokens,
        }


# ── 1. the charge lands on the run ledger, reported as the ledger's own number ────────────


def test_first_render_books_the_charge_on_the_run_ledger() -> None:
    context = _RunContext()
    entries = _entries(3)

    content, diagnostics = render_from_component_sources(context, {"memory": _source(entries)})

    ledger = context.metadata[INJECTION_LEDGER_KEY]
    assert isinstance(ledger, InjectionLedger)
    assert content  # the block rendered
    assert diagnostics["status"] == STATUS_READY
    assert diagnostics["charged"] > 0
    # The reported number is the ledger reading, and diagnostics carry the operator snapshot
    # (the 0628 twin shape) so a test never reaches into context.metadata to assert it.
    assert diagnostics["charged"] == diagnostics["ledger"]["bySource"]["memory"]
    assert diagnostics["ledger"]["bySource"]["memory"] == ledger.by_source["memory"]
    # The framing and every row have their own key — one charge per fact, visible in charged_keys.
    keys = ledger.charged_keys("memory")
    assert HEADER_KEY in keys
    assert all(_entry_key(entry) in keys for entry in entries)


# ── 2. same-run second render: not idempotent by accident, idempotent by the caller ───────


def test_a_second_render_in_the_same_run_does_not_spend_the_pool_twice() -> None:
    context = _RunContext()
    ledger = ledger_for_context(context)
    entries = _entries(4)
    before_used = ledger.used()
    before_entries = len(ledger.entries)

    first_content, first = render_from_component_sources(context, {"memory": _source(entries)})
    second_content, second = render_from_component_sources(context, {"memory": _source(entries)})

    assert first["charged"] > 0
    # Byte-identical re-render: the text the model sees does not change, and neither does the bill.
    assert second_content == first_content
    assert second["charged"] == 0
    assert second["ledger"]["bySource"]["memory"] == first["ledger"]["bySource"]["memory"]
    assert ledger.used() == before_used + first["charged"]
    assert len(ledger.entries) == before_entries + len(ledger.charged_keys("memory"))


# ── 3. content-hash keys: CP re-ordering cannot mint new charges for the same rows ────────


def test_a_reordered_replay_does_not_charge_again() -> None:
    ledger = InjectionLedger.create(window_tokens=128_000, baseline_tokens=0)
    entries = _entries(3)

    first = render_agent_memory(entries, ledger=ledger)
    reordered = render_agent_memory(list(reversed(entries)), ledger=ledger)

    assert first.charged > 0
    assert reordered.charged == 0
    assert ledger.by_source["memory"] == first.charged
    # The reordered render still shows every row (admission is by hash key, not position)…
    for entry in entries:
        assert entry["content"] in reordered.content
    # …and a row that *was* admitted is not charged a second time under its new index.
    assert len(ledger.charged_keys("memory")) == len(entries) + 1  # + HEADER_KEY


# ── 4. interrupted render replays without double charging (run-scoped ledger) ─────────────


def test_replay_after_an_interrupted_render_does_not_double_charge() -> None:
    context = _RunContext()
    ledger = ledger_for_context(context)
    entries = _entries(3)

    interrupted = render_agent_memory(entries, ledger=ledger)
    # The block is dropped before it ever reaches the prompt — the run retries the seam.
    replay = render_agent_memory(entries, ledger=ledger)

    assert interrupted.charged > 0
    assert replay.charged == 0
    assert replay.content == interrupted.content
    assert ledger.by_source["memory"] == interrupted.charged
    # Scope (per InjectionLedger doc): the ledger is never persisted, so this invariant covers
    # re-entry within one run. A cross-process restart is a new run with a new ledger — out of
    # scope for this fix, same as the 0628 skills twin.


# ── 5. pool-driven cut still pays for the sentence (D28-41) ───────────────────────────────


def test_a_pool_driven_cut_still_pays_for_the_sentence() -> None:
    # window 8k ⇒ memory cap 320 (4%), pool 672 total with the skills floor inside it. The header
    # (~125 tokens) plus five ~60-token rows exceeds the memory cap, so the cut is certain; the
    # truncation sentence must still be reserved first and still reach the model.
    ledger = InjectionLedger.create(window_tokens=8_000, baseline_tokens=0)
    entries = [_entry(f"pool-cut-{index} " + "y" * 100) for index in range(5)]

    block = render_agent_memory(entries, ledger=ledger)

    assert block.truncated
    assert block.status == STATUS_TRUNCATED
    assert MEMORY_TRUNCATION_NOTE in block.content
    assert block.content.rstrip().endswith(MEMORY_TRUNCATION_NOTE)
    # The note is a real charge (reserved before the rows), and the reported number is the
    # ledger delta — not a local re-sum of header + notes + rows.
    assert TRUNCATION_NOTE_KEY in ledger.charged_keys("memory")
    assert block.charged == ledger.by_source["memory"]
    assert 0 < block.charged <= ledger.limits.caps["memory"]
