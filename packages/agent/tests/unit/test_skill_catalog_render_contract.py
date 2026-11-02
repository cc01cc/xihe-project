"""PLAN-0628 M3-①: the cross-language pin for the skills listing, Agent half.

CP's ``SkillCatalogSourceService.view(Listing)`` renders one line per skill; this package's
:func:`xihe_agent.context.skill_catalog.render_from_component_sources` turns those lines into the
model-visible ``${xh.skill_catalog}`` text. Each side used to be tested only against itself, so
"the model reads exactly the lines CP produced" rested on reading two files carefully.

Now both suites read **one** fixture — ``spec/fixtures/skill-catalog-render.json``:

* ``packages/control-plane/src/test/java/com/cc01cc/p/xihe/cp/skill/SkillCatalogRenderFixtureTest.java``
  requires ``view(listing)`` to equal the fixture's ``componentView`` byte for byte;
* this file feeds that same ``componentView`` through the real renderer and requires the content to
  equal ``agent.expectedContent``.

The fixture also owns the *wording* the model sees (header, name/description separator, truncation
sentence). Those strings live in this module — pinning them here means a reworded sentence cannot
slide through: it makes this test and the CP contract go red together, which is the point of a
shared fixture (改 fixture = 改契约).

D28-41 is asserted structurally, not by comment: the truncation sentence is reserved by the final
renderer (``cp_truncated`` covers the CP-side cut; the reserved note covers this side's budget cut),
so every case whose ``componentView.truncated`` is true must end with that sentence even when the
budget here would have been happy with the listing it received.

Dirty data (PLAN-0628 M3b-②, rulings A/B/C): the ``dirty-description-*`` cases store descriptions
the previous import path could persist — surrounding whitespace, an empty string, and an embedded
line break — and pin the model-visible result. This side is **not** changed to fix them (its
``strip()`` stays: CP is the rendering authority and normalises the stored value first); what is
added here is the negative half of the pin: no rendered line may be a *fragment* of a CP item, so
"one listing item = one prompt line" is asserted rather than assumed.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from xihe_agent.context.skill_catalog import (
    HEADER,
    NAME_SEPARATOR,
    SOURCE_SKILL_BINDINGS,
    TRUNCATION_NOTE,
    render_from_component_sources,
)

FIXTURE_NAME = "skill-catalog-render.json"

#: Any key works: the Agent selects component entries by their ``source`` value, not by the slot.
SLOT_KEY = "11111111-1111-4111-8111-111111111111"


class _RunContext:
    """Minimal stand-in for the run context (only ``metadata`` is read by the ledger)."""

    def __init__(self, window_tokens: int, assembled_tokens: int = 0) -> None:
        self.metadata: dict[str, object] = {
            "windowTokens": window_tokens,
            "assembledTokens": assembled_tokens,
        }


def _fixture_path() -> Path:
    for parent in Path(__file__).resolve().parents:
        candidate = parent / "spec" / "fixtures" / FIXTURE_NAME
        if candidate.is_file():
            return candidate
    raise AssertionError(f"shared fixture spec/fixtures/{FIXTURE_NAME} not found")


def _fixture() -> dict[str, Any]:
    fixture = json.loads(_fixture_path().read_text(encoding="utf-8"))
    assert isinstance(fixture, dict)
    return fixture


def _cases() -> list[dict[str, Any]]:
    cases = _fixture()["cases"]
    assert isinstance(cases, list) and cases, "the shared contract needs at least one case"
    return cases


def _render(case: dict[str, Any]) -> tuple[str, dict[str, Any]]:
    agent = case["agent"]
    return render_from_component_sources(
        _RunContext(agent["windowTokens"], agent["assembledTokens"]),
        {SLOT_KEY: case["componentView"]},
        max_tokens=agent["maxTokens"],
    )


def test_the_model_visible_wording_is_pinned_by_the_shared_contract() -> None:
    fixture = _fixture()

    assert fixture["header"] == HEADER, (
        "the listing header drifted; update the fixture (and the CP contract) deliberately"
    )
    assert fixture["truncationNote"] == TRUNCATION_NOTE, (
        "the truncation sentence drifted; it is the one string that tells the model the list is"
        " partial, so both suites must agree before it changes"
    )
    assert fixture["separator"] == NAME_SEPARATOR, (
        "the name/description separator drifted; the Agent splits each CP line on this exact"
        " string to key its ledger"
    )


def test_the_slot_value_matches_the_contract_for_every_case() -> None:
    for case in _cases():
        name = case["name"]
        expected = case["agent"]
        content, diagnostics = _render(case)

        assert content == expected["expectedContent"], (
            f"{name}: the model-visible text drifted from spec/fixtures/{FIXTURE_NAME}"
        )
        assert diagnostics["status"] == expected["expectedStatus"], name
        assert diagnostics["truncated"] == expected["expectedTruncated"], name
        assert diagnostics["diagnostics"] == expected["expectedDiagnostics"], name
        assert diagnostics["cpDiagnostics"] == expected["cpDiagnostics"], name
        assert diagnostics["items"] == expected["items"], name
        # The Agent only claims a component it recognises; the fixture's source is that value.
        assert case["componentView"]["source"] == SOURCE_SKILL_BINDINGS, name


def test_the_agent_only_drops_lines_it_never_rewrites_them() -> None:
    """The cross-language invariant: the Agent may drop a tail, never re-word a line."""
    fixture = _fixture()
    header = fixture["header"]
    note = fixture["truncationNote"]

    for case in _cases():
        name = case["name"]
        expected = case["agent"]
        content, _ = _render(case)
        lines = case["componentView"]["items"]

        if content == "":
            assert lines == [], f"{name}: an empty slot is only legal for an empty listing"
            continue

        parts = content.split("\n")
        assert parts[0] == header, f"{name}: the first model-visible line must be the header"
        if parts[-1] == note:
            parts = parts[:-1]

        assert (content.endswith(note)) == expected["expectedTruncated"], (
            f"{name}: the truncation sentence must be present exactly when the block is partial"
        )
        rendered = parts[1:]
        assert rendered == lines[: len(rendered)], (
            f"{name}: a rendered line was re-worded instead of kept or dropped"
        )
        assert len(rendered) <= len(lines), f"{name}: more lines than CP produced"

        # D28-41: a CP-side cut must reach the model even when this side's budget was satisfied.
        if case["componentView"]["truncated"]:
            assert content.endswith(note), (
                f"{name}: CP reported the listing as cut, so the model must be told in-band"
            )


def test_a_listing_item_never_spans_two_lines() -> None:
    """PLAN-0628 M3b-② (裁定 C): one listing item is one prompt line.

    Why this is a semantic assertion and not a cosmetic one: the model reads the block as a list of
    ``name — description`` lines, so a description that contains a break puts half of it on the next
    line where that half looks like **another skill** (with a name it may then try to load). One
    binding would silently become two.

    ``\\n`` is defined precisely here: the block consists of exactly three kinds of line — the
    header, one line per *whole* item CP handed over, and (only when the block is partial) one line
    of truncation note. So the newline count must be ``#item lines + (0|1)``, every body line must
    be *equal* to a CP item (never a fragment of one), and no item may carry a break itself.
    """
    fixture = _fixture()
    header = fixture["header"]
    note = fixture["truncationNote"]

    for case in _cases():
        name = case["name"]
        items = case["componentView"]["items"]
        content, _ = _render(case)

        assert all("\n" not in item and "\r" not in item for item in items), (
            f"{name}: CP handed over an item that already spans a line; the fixture must not pin a"
            " multi-line item"
        )

        if content == "":
            assert items == [], f"{name}: an empty slot is only legal for an empty listing"
            continue

        lines = content.split("\n")
        assert lines[0] == header, f"{name}: the first model-visible line must be the header"
        body = lines[1:]
        if body and body[-1] == note:
            body = body[:-1]

        assert len(body) <= len(items), f"{name}: more lines than CP items"
        assert all(line in items for line in body), (
            f"{name}: a rendered line is not one whole CP item — an item was split across lines"
        )
        expected_breaks = len(body) + (1 if content.endswith(note) else 0)
        assert content.count("\n") == expected_breaks, (
            f"{name}: a newline appeared somewhere other than between whole lines"
        )
        assert all("\n" not in line and "\r" not in line for line in body), name


def test_the_contract_covers_the_scenarios_the_design_needs() -> None:
    cases = _cases()
    statuses = {case["listing"]["status"] for case in cases}
    names = {case["name"] for case in cases}

    assert {"ready", "truncated", "empty", "failed"} <= statuses, statuses
    assert any(case["listing"]["truncated"] for case in cases), "no CP-side maxSkills cut"
    assert any(
        case["agent"]["expectedStatus"] == "truncated" and not case["listing"]["truncated"]
        for case in cases
    ), "no Agent-side budget cut"
    assert any(case["listing"]["collision"] for case in cases), "no qualified (three-segment) name"
    assert any(not case["listing"]["includeDescriptions"] for case in cases), "no bare-name case"
    assert any(case["agent"]["expectedContent"] == "" for case in cases), "no empty-slot case"
    assert any(
        len(line) > 500 for case in cases for line in case["componentView"]["items"]
    ), "no over-long line: CP must prove it does not chop a name or a description"
    # PLAN-0628 M3b-②: the three dirty-description shapes are the cross-language pin for rulings
    # A/B/C; dropping one re-opens the drift that produced them.
    assert {
        "dirty-description-whitespace",
        "dirty-description-blank",
        "dirty-description-multiline",
    } <= names, names
