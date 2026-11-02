"""PLAN-0629 M1-5: ``${xh.agent_memory}`` slot rendering.

Mirrors ``tests/unit/test_skill_catalog.py`` on purpose — the two slots share one seam
(``api/chat.py#xh_context_slots``), one ledger and one rendering discipline, so a divergence in the
tests would be the first sign of a divergence in the code.
"""

from __future__ import annotations

from typing import Any

from xihe_agent.api.chat import xh_context_slots
from xihe_agent.context.agent_memory import (
    DIAG_BUDGET_TRUNCATED,
    DIAG_EMPTY,
    DIAG_UNAVAILABLE,
    DIAG_WINDOW_UNKNOWN,
    MEMORY_HEADER,
    MEMORY_TRUNCATION_NOTE,
    MEMORY_UNAVAILABLE_NOTE,
    SOURCE_AGENT_MEMORY,
    STATUS_FAILED,
    STATUS_READY,
    STATUS_TRUNCATED,
    entry_tokens,
    render_agent_memory,
    render_from_component_sources,
)
from xihe_agent.context.injection_budget import InjectionLedger
from xihe_agent.context.nested_injection import INJECTION_LEDGER_KEY


def _entry(content: str, *, kind: str = "fact", pinned: bool = False) -> dict[str, Any]:
    return {
        "type": kind,
        "pinned": pinned,
        "updatedAt": "2026-11-02T10:00:00Z",
        "content": content,
        "tokens": max(1, len(content) // 2),
    }


def _entries(count: int, *, size: int = 20) -> list[dict[str, Any]]:
    return [_entry(f"memory-{index:03d} " + "x" * size) for index in range(count)]


def _source(entries: list[dict[str, Any]], *, status: str = "ready", truncated: bool = False,
            diagnostics: list[str] | None = None) -> dict[str, Any]:
    return {
        "source": SOURCE_AGENT_MEMORY,
        "status": status,
        "entries": entries,
        "truncated": truncated,
        "diagnostics": diagnostics or [],
        "maxEntries": 24,
        "maxTokens": 4_000,
        "usedTokens": 0,
    }


class _RunContext:
    """Minimal stand-in for the run context (only ``metadata`` is needed by the ledger)."""

    def __init__(self, window: int = 128_000) -> None:
        self.metadata: dict[str, object] = {"windowTokens": window, "assembledTokens": 0}


# ── the seam: a run whose template has no memory component ────────────────────────────────


def test_no_memory_component_leaves_the_slot_empty() -> None:
    content, diagnostics = render_from_component_sources(_RunContext(), {})

    assert content == ""
    assert diagnostics == {"components": 0}


def test_foreign_component_sources_are_ignored() -> None:
    # A skill_catalog view must not be mistaken for memory: identification is by the CP tag.
    content, diagnostics = render_from_component_sources(
        _RunContext(),
        {"11111111-1111-4111-8111-111111111111": {"source": "skill_bindings", "items": ["a — b"]}},
    )

    assert content == ""
    assert diagnostics["components"] == 0


# ── the happy path ────────────────────────────────────────────────────────────────────────


def test_slot_renders_cp_entries_in_cp_order() -> None:
    context = _RunContext()
    entries = [
        _entry("older profile", kind="profile"),
        _entry("newer pinned fact", pinned=True),
    ]

    content, diagnostics = render_from_component_sources(
        context, {"11111111-1111-4111-8111-111111111111": _source(entries)}
    )

    assert content.startswith(MEMORY_HEADER)
    assert content.endswith("</system-reminder>")
    # CP's order is the render order: no re-sorting on this side.
    assert content.index("older profile") < content.index("newer pinned fact")
    assert "[profile]" in content
    assert "[fact, pinned]" in content
    assert diagnostics["status"] == STATUS_READY
    assert diagnostics["entries"] == 2
    assert diagnostics["cpTruncated"] is False
    assert diagnostics["unavailable"] is False
    ledger = context.metadata[INJECTION_LEDGER_KEY]
    assert isinstance(ledger, InjectionLedger)
    assert ledger.by_source["memory"] > 0


def test_slot_value_is_carried_by_xh_context_slots() -> None:
    supplied = xh_context_slots(agent_memory="rendered memory")

    assert supplied["agent_memory"] == "rendered memory"
    # G-0 rule: the key always exists, so a template referencing it never hits MISSING_VARIABLE.
    assert xh_context_slots()["agent_memory"] == ""


# ── truncation must be visible to the model (D28-41) ─────────────────────────────────────


def test_cp_truncation_puts_the_note_in_band() -> None:
    content, diagnostics = render_from_component_sources(
        _RunContext(),
        {"11111111-1111-4111-8111-111111111111": _source(_entries(3), status=STATUS_TRUNCATED,
                                                          truncated=True)},
    )

    assert diagnostics["cpTruncated"] is True
    assert diagnostics["truncated"] is True
    assert content.endswith(MEMORY_TRUNCATION_NOTE)
    assert DIAG_BUDGET_TRUNCATED in diagnostics["diagnostics"]


def test_tight_budget_keeps_the_head_and_says_so() -> None:
    ledger = InjectionLedger.create(8_000)  # memory floor 160 / cap 320 tokens

    block = render_agent_memory(_entries(40), ledger=ledger)

    assert block.truncated
    assert block.content.startswith(MEMORY_HEADER)
    assert "memory-000" in block.content
    assert "memory-039" not in block.content
    assert block.content.endswith(MEMORY_TRUNCATION_NOTE)
    assert DIAG_BUDGET_TRUNCATED in block.diagnostics
    assert ledger.by_source["memory"] <= ledger.limits.caps["memory"]
    assert ledger.used() <= ledger.limits.total
    # The charge reported to the caller is what the ledger actually took.
    assert block.charged == ledger.by_source["memory"]


def test_unknown_window_degrades_to_the_absolute_cap() -> None:
    ledger = InjectionLedger.create(0)

    block = render_agent_memory(_entries(3), ledger=ledger)

    assert DIAG_WINDOW_UNKNOWN in block.diagnostics
    assert ledger.limits.caps["memory"] == 4_000


def test_exhausted_budget_keeps_the_ledger_invariant() -> None:
    # Production cannot reach this: "memory" is charged by this renderer only, so the source is
    # empty when it starts. The test pins the behaviour anyway — when even the note cannot be
    # reserved, the ledger invariant (used <= total) wins over the in-band sentence, and the
    # truncation is still reported structurally.
    ledger = InjectionLedger.create(8_000)
    ledger.try_charge("memory", "pre-charged", ledger.limits.caps["memory"], priority=True)

    block = render_agent_memory(_entries(3), ledger=ledger)

    assert block.truncated
    assert block.content == ""
    assert DIAG_BUDGET_TRUNCATED in block.diagnostics
    assert ledger.used() <= ledger.limits.total


# ── "missing" vs "failed": the second one may never look empty ────────────────────────────


def test_empty_memory_is_empty_not_failure() -> None:
    block = render_agent_memory([], ledger=InjectionLedger.create(128_000))

    assert block.status != STATUS_FAILED
    assert block.content == ""
    assert DIAG_EMPTY in block.diagnostics
    assert DIAG_UNAVAILABLE not in block.diagnostics


def test_failed_source_is_explicit_in_band() -> None:
    content, diagnostics = render_from_component_sources(
        _RunContext(),
        {
            "11111111-1111-4111-8111-111111111111": _source(
                [], status=STATUS_FAILED, diagnostics=["missing_agent_principal"]
            )
        },
    )

    assert diagnostics["unavailable"] is True
    assert diagnostics["status"] == STATUS_FAILED
    assert diagnostics["cpDiagnostics"] == ["missing_agent_principal"]
    assert content == MEMORY_UNAVAILABLE_NOTE
    assert DIAG_UNAVAILABLE in diagnostics["diagnostics"]


# ── malformed input never renders as content ─────────────────────────────────────────────


def test_malformed_entries_are_skipped_instead_of_rendered() -> None:
    source = _source([])
    source["entries"] = [
        "not-a-mapping",
        {"type": "fact", "pinned": False},  # no content
        {"type": "fact", "pinned": False, "content": "   "},  # blank content
        _entry("kept"),
    ]

    content, diagnostics = render_from_component_sources(
        _RunContext(), {"11111111-1111-4111-8111-111111111111": source}
    )

    assert diagnostics["entries"] == 1
    assert content.count("- [") == 1
    assert "kept" in content


def test_entry_tokens_trusts_cp_only_when_the_numbers_agree() -> None:
    content = "x" * 100
    agreeing = {"content": content, "tokens": 50}
    disagreeing = {"content": content, "tokens": 1}
    missing = {"content": content}

    assert entry_tokens(agreeing) == 50
    # A snapshot that under-reports its own size must not under-charge the ledger.
    assert entry_tokens(disagreeing) == 50
    assert entry_tokens(missing) == 50
