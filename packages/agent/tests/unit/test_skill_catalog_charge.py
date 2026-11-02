"""PLAN-0627 收尾③: the skills listing is *booked* on the run ledger, not merely rendered.

PLAN-0628 M1-②/③a shipped the renderer; the 0627 task board still carried "``charge_assembly``
被 0628 真正调用" because nothing pinned the properties that make "charged" more than a number in a
return value:

1. the charge lands on the **run-scoped** ledger (``ledger_for_context``) and the reported token
   count is the ledger's own number, so an operator can read ``used`` next to the cap;
2. the truncation sentence is *paid for before* the lines (D28-41) — "cut" and "told" are one event,
   including when the cut comes from the shared pool instead of the 1% skills cap;
3. charging is not repeated if the seam renders twice in the same run (``try_charge`` is not
   idempotent, so the caller has to skip keys already in ``charged_keys``).

The fourth property is the one this file added a fix for: the reservation used to be computed from
the skills *cap* alone, so a pool-driven cut dropped the sentence — exactly the failure D28-41
exists to prevent.
"""

from __future__ import annotations

from xihe_agent.context.injection_budget import (
    InjectionLedger,
    charge_assembly,
    conservative_token_count,
)
from xihe_agent.context.nested_injection import ledger_for_context
from xihe_agent.context.skill_catalog import (
    HEADER,
    HEADER_KEY,
    SOURCE_SKILL_BINDINGS,
    STATUS_TRUNCATED,
    TRUNCATION_NOTE,
    TRUNCATION_NOTE_KEY,
    render_from_component_sources,
    render_skill_catalog,
)

SLOT = "11111111-1111-4111-8111-111111111111"

WINDOW = 128_000


def _line(index: int) -> str:
    """A listing line shaped like CP's output; ~25 tokens at the conservative estimate."""
    return f"skill-{index:03d} — does a thing that the model may need (detail {index})"


def _lines(count: int) -> list[str]:
    return [_line(index) for index in range(count)]


def _source(items: list[str]) -> dict[str, object]:
    return {
        "status": "ready",
        "source": SOURCE_SKILL_BINDINGS,
        "items": items,
        "truncated": False,
        "diagnostics": [],
    }


class _RunContext:
    """Minimal stand-in for the run context (only ``metadata`` is read by the ledger)."""

    def __init__(self, window_tokens: int = WINDOW, assembled_tokens: int = 0) -> None:
        self.metadata: dict[str, object] = {
            "windowTokens": window_tokens,
            "assembledTokens": assembled_tokens,
        }


def test_listing_is_booked_on_the_run_ledger() -> None:
    """① Normal path: the reported charge is the ledger's number, not a local sum."""
    context = _RunContext()
    lines = _lines(5)

    content, diagnostics = render_from_component_sources(context, {SLOT: _source(lines)})

    expected = conservative_token_count(HEADER + "\n") + sum(
        conservative_token_count(line + "\n") for line in lines
    )
    ledger = ledger_for_context(context)

    assert content.startswith(HEADER)
    assert diagnostics["charged"] == expected > 0
    # The estimate the renderer reports is the amount that actually reached the ledger …
    assert ledger.by_source["skills"] == expected
    # … and an operator-visible snapshot carries it (what `event=skill_catalog_charge` logs).
    assert diagnostics["ledger"]["bySource"]["skills"] == expected
    assert diagnostics["ledger"]["used"] == expected
    assert diagnostics["ledger"]["caps"]["skills"] == 1_280


def test_over_budget_cut_keeps_the_sentence_and_has_paid_for_it() -> None:
    """② Over budget: truncated ⇒ the model is told, and the sentence was reserved first."""
    ledger = InjectionLedger.create(8_000)  # 512-token floor ⇒ 40 lines cannot fit

    block = render_skill_catalog(_lines(40), ledger=ledger)

    assert block.truncated
    assert block.status == STATUS_TRUNCATED
    assert TRUNCATION_NOTE in block.content
    assert block.content.endswith(TRUNCATION_NOTE)
    # Reserved, not appended for free: it has its own ledger entry …
    assert TRUNCATION_NOTE_KEY in ledger.charged_keys("skills")
    assert ledger.by_source["skills"] == block.charged
    # … and that entry precedes the header, i.e. it was charged BEFORE the lines (D28-41). If the
    # reservation moved after `charge_assembly`, the sentence would be dropped exactly when the cap
    # is full — which is exactly when the model needs it.
    keys = [str(entry["key"]) for entry in ledger.entries if entry["source"] == "skills"]
    assert keys.index(TRUNCATION_NOTE_KEY) < keys.index(HEADER_KEY)


def test_a_second_render_in_the_same_run_does_not_spend_the_pool_twice() -> None:
    """③ Idempotency: a re-render re-uses the booked entries instead of paying for them again."""
    context = _RunContext()
    lines = _lines(5)

    first_content, _first = render_from_component_sources(context, {SLOT: _source(lines)})
    charged_once = ledger_for_context(context).by_source["skills"]
    entries_once = len(ledger_for_context(context).entries)
    assert charged_once > 0

    second_content, second = render_from_component_sources(context, {SLOT: _source(lines)})

    assert first_content == second_content
    assert second["charged"] == 0
    assert ledger_for_context(context).by_source["skills"] == charged_once
    assert len(ledger_for_context(context).entries) == entries_once


def test_a_pool_driven_cut_still_pays_for_the_sentence() -> None:
    """④ The cut can come from the shared pool while the 1% cap still has room.

    Numbers: window 128k with a large assembled baseline ⇒ pool total 3072 (the sum of the floors);
    memory already holds its 2560-token floor, so 512 tokens are left. The listing needs 1238 tokens
    — inside the skills cap (1280) but far outside the pool. Computing "may truncate" from the cap
    alone therefore missed the cut and the model got a silently shortened listing.
    """
    ledger = InjectionLedger.create(WINDOW, baseline_tokens=89_000)
    charge_assembly(ledger, memory=[("agent_memory:0", 2_560, 1.0)])
    assert ledger.remaining() == 512
    assert ledger.limits.caps["skills"] - ledger.by_source["skills"] == 1_280

    block = render_skill_catalog(_lines(40), ledger=ledger)

    assert block.truncated
    assert TRUNCATION_NOTE in block.content
    assert TRUNCATION_NOTE_KEY in ledger.charged_keys("skills")
    assert ledger.by_source["skills"] == block.charged
    assert ledger.used() <= ledger.limits.total
