"""PLAN-0628 M1: the skills listing budget block.

The two invariants under test are the ones a future edit is most likely to break: the block is
charged on the **shared** ledger via ``charge_assembly`` (so it cannot quietly get a second budget
of its own), and every truncation carries a diagnostic (so a half listing never reads as "that
skill does not exist").
"""

from xihe_agent.context.injection_budget import InjectionLedger, NestedEntry
from xihe_agent.context.nested_injection import charge_nested_for_touch
from xihe_agent.context.skill_catalog import (
    DIAG_BUDGET_TRUNCATED,
    DIAG_COMPONENT_MAX_TOKENS,
    DIAG_EMPTY,
    DIAG_WINDOW_UNKNOWN,
    HEADER,
    SOURCE_SKILL_BINDINGS,
    STATUS_EMPTY,
    STATUS_READY,
    STATUS_TRUNCATED,
    TRUNCATION_NOTE,
    render_from_component_sources,
    render_skill_catalog,
)


def _line(index: int) -> str:
    """A listing line shaped like CP's output; ~24 tokens at the conservative estimate."""
    return f"skill-{index:03d} — does a thing that the model may need (detail {index})"


def _lines(count: int) -> list[str]:
    return [_line(index) for index in range(count)]


def test_forty_items_fit_the_one_percent_cap() -> None:
    ledger = InjectionLedger.create(128_000)

    block = render_skill_catalog(_lines(40), ledger=ledger)

    assert ledger.limits.caps["skills"] == 1280
    assert block.status == STATUS_READY
    assert not block.truncated
    assert block.diagnostics == ()
    assert block.content.startswith(HEADER)
    assert block.content.count("\n") == 40  # header + 40 lines
    assert ledger.by_source["skills"] <= ledger.limits.caps["skills"]


def test_tail_drop_when_cap_exceeded() -> None:
    ledger = InjectionLedger.create(128_000)

    block = render_skill_catalog(_lines(60), ledger=ledger)

    assert block.status == STATUS_TRUNCATED
    assert block.truncated
    assert DIAG_BUDGET_TRUNCATED in block.diagnostics
    assert ledger.by_source["skills"] <= ledger.limits.caps["skills"]
    # Whatever is rendered is a prefix — priority order is CP's, so the tail is the cheap end.
    assert block.content.count("\n") < 60
    assert "skill-000" in block.content


def test_tiny_window_keeps_the_floor() -> None:
    ledger = InjectionLedger.create(8_000)

    block = render_skill_catalog(_lines(40), ledger=ledger)

    assert ledger.limits.caps["skills"] == 512
    assert block.truncated
    assert block.content.startswith(HEADER)
    assert len(block.content) > len(HEADER)
    assert ledger.by_source["skills"] <= ledger.limits.caps["skills"]
    assert ledger.used() <= ledger.limits.total


def test_unknown_window_degrades_to_absolute_cap() -> None:
    ledger = InjectionLedger.create(0)

    block = render_skill_catalog(_lines(5), ledger=ledger)

    assert ledger.limits.caps["skills"] == 2000
    assert DIAG_WINDOW_UNKNOWN in block.diagnostics
    assert block.status in {STATUS_READY, STATUS_TRUNCATED}


def test_empty_items_is_empty_not_error() -> None:
    ledger = InjectionLedger.create(128_000)

    block = render_skill_catalog([], ledger=ledger)

    assert block.status == STATUS_EMPTY
    assert block.content == ""
    assert block.diagnostics == (DIAG_EMPTY,)
    assert ledger.by_source["skills"] == 0


def test_component_max_tokens_only_tightens() -> None:
    ledger = InjectionLedger.create(128_000)
    lines = _lines(40)

    untightened = render_skill_catalog(lines, ledger=InjectionLedger.create(128_000))
    tightened = render_skill_catalog(lines, ledger=InjectionLedger.create(128_000), max_tokens=100)

    assert DIAG_COMPONENT_MAX_TOKENS in tightened.diagnostics
    assert tightened.content.count("\n") < untightened.content.count("\n")
    # The component cap is checked before charging, so it never spends the shared skills cap on
    # lines it is about to drop.
    assert tightened.charged <= 100


def test_shares_one_ledger_with_nested_injection() -> None:
    """D27-22: one ledger, so the two eager sources see each other's usage."""
    ledger = InjectionLedger.create(128_000)

    block = render_skill_catalog(_lines(10), ledger=ledger)
    skills_after_listing = ledger.by_source["skills"]
    assert skills_after_listing == block.charged

    charge_nested_for_touch(
        ledger, [NestedEntry(path="docs/AGENTS.md", content="nested rules " * 20)]
    )

    # Nested injection spends its own source; it must not silently re-charge skills.
    assert ledger.by_source["skills"] == skills_after_listing
    assert ledger.by_source["nested"] > 0


def test_truncation_is_said_in_model_visible_text_not_only_in_diagnostics() -> None:
    """A structured diagnostic is for operators; the model only reads ``content``.

    Without the in-band sentence a cut listing reads as the complete set of skills and the model
    will confidently deny that a skill it cannot see exists.
    """
    ledger = InjectionLedger.create(8_000)  # 512-token floor ⇒ the listing must be cut

    block = render_skill_catalog(_lines(40), ledger=ledger)

    assert block.truncated
    assert TRUNCATION_NOTE in block.content
    assert block.content.endswith(TRUNCATION_NOTE)


class _RunContext:
    """Minimal stand-in for the run context (only ``metadata`` is needed by the ledger)."""

    def __init__(self) -> None:
        self.metadata: dict[str, object] = {"windowTokens": 128_000, "assembledTokens": 0}


def _source(items: list[str]) -> dict[str, object]:
    return {
        "status": "ready",
        "source": SOURCE_SKILL_BINDINGS,
        "items": items,
        "truncated": False,
        "diagnostics": [],
    }


def test_slot_value_is_rendered_from_component_sources() -> None:
    content, diagnostics = render_from_component_sources(
        _RunContext(), {"11111111-1111-4111-8111-111111111111": _source(["alpha — a", "beta — b"])}
    )

    assert content.startswith(HEADER)
    assert "alpha — a" in content and "beta — b" in content
    assert diagnostics["components"] == 1
    assert diagnostics["items"] == 2
    assert diagnostics["status"] == STATUS_READY
    assert diagnostics["charged"] > 0


def test_foreign_sources_are_ignored() -> None:
    content, diagnostics = render_from_component_sources(
        _RunContext(),
        {
            "11111111-1111-4111-8111-111111111111": {
                "status": "ready",
                "source": "workspace_tree",
                "items": ["not a skill"],
                "truncated": False,
                "diagnostics": [],
            }
        },
    )

    assert content == ""
    assert diagnostics["components"] == 0


def test_no_skills_yields_an_empty_slot_not_a_missing_variable() -> None:
    """G-0 fixture semantics: the slot exists and is empty, so a template never hits MISSING_VARIABLE."""
    for sources in (None, {}, {"11111111-1111-4111-8111-111111111111": _source([])}):
        content, diagnostics = render_from_component_sources(_RunContext(), sources)
        assert content == ""
        assert diagnostics["items"] == 0
        assert diagnostics["status"] == STATUS_EMPTY
