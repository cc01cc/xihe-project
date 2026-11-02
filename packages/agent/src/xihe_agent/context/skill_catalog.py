"""PLAN-0628 M1: the skills listing block — the *budget* half (CP owns the *subset* half).

Division of labour (D28-19): CP resolves which skills a run may see and renders one line per skill
(``<qualified name> — <description>``, because the wire contract is ``items: list[str]``); the Agent
only decides how much of that listing fits the prompt.

Budget rules are **not** re-derived here: the numbers live in
:mod:`xihe_agent.context.injection_budget` (D27-22) and this module calls :func:`charge_assembly`,
so skills are charged before memory on the *same* run-scoped ledger PLAN-0627's nested injection
uses. Adding a second percentage or a second ledger is the thing this module exists to prevent.

Where the listing sits in the frozen budget (D27-22「三 PLAN 合并预算」)
----------------------------------------------------------------------
* **This source**: floor ``512`` tokens, cap ``max(512, 1% * window)`` (``2000`` when the window is
  unknown). The 1% figure is PLAN-0628's frozen wording (「注入池 ≈ 窗口 1%」, D28-16), not re-derived
  here; the numbers themselves stay in ``injection_budget.py``.
* **Shared pool**: ``min(15% of the headroom below the 70% compaction trigger, 8% of the window)``,
  never below the sum of the guaranteed floors (skills 512 + memory 2%). Assembly charges skills
  first, then memory; the JIT nested chain spends what is left. Charging order and degradation
  order are two different things and both are frozen.
* **Who is cut first**: ``nested -> memory (above its floor) -> skills (above its floor)``. Nested
  ancestor rules are the only source whose absence loses no capability (the root AGENTS.md is still
  injected eagerly by ``root_agents_md``), so it is denied first. The skills listing *is* capability
  discovery, so it is the last source evicted and only ever above its floor. Inside this block the
  **tail** goes first, because CP's order is the priority order (AGENT before USER, workspace before
  instance, then name) — "keep the head" == "keep the highest-priority skills".
* **Truncation budget (D28-41)**: this module is the final renderer, so *it* pays for
  ``TRUNCATION_NOTE`` **before** the lines. Charging the sentence afterwards drops it exactly when
  the cap is already full — i.e. exactly when the model needs to be told. The reservation is
  computed against the same room the ledger will grant (min of the skills cap and the shared pool,
  floor included); computing it from the cap alone misses pool-driven cuts.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any

from .injection_budget import InjectionLedger, charge_assembly, conservative_token_count
from .nested_injection import ledger_for_context

#: One line of framing, charged like any other entry (otherwise the block could exceed its cap).
HEADER = "Available skills (name — description); load full text by name when relevant:"

#: Ledger key of the header, so it participates in charging and in ``charged_keys`` dedupe.
HEADER_KEY = "skill_catalog:header"

#: Separator CP uses between the qualified name and the description.
NAME_SEPARATOR = " — "

#: In-band sentence appended when the listing was cut. The model must be told, because a short
#: listing otherwise reads as the complete set and the model will deny that unseen skills exist.
TRUNCATION_NOTE = (
    "（上面只是部分可用 skill；需要其他 skill 时请按名称直接尝试，不要据此断言它不存在。）"
)
TRUNCATION_NOTE_KEY = "skill_catalog:truncation_note"

DIAG_EMPTY = "skill_catalog_empty"
DIAG_COMPONENT_MAX_TOKENS = "skill_catalog_component_max_tokens_reached"
DIAG_BUDGET_TRUNCATED = "skill_catalog_budget_truncated"
DIAG_WINDOW_UNKNOWN = "skill_catalog_budget_window_unknown"

STATUS_READY = "ready"
STATUS_TRUNCATED = "truncated"
STATUS_EMPTY = "empty"

#: The CP component {@code source} value this module consumes; anything else is not ours.
SOURCE_SKILL_BINDINGS = "skill_bindings"


@dataclass(frozen=True)
class SkillCatalogBlock:
    """Rendered listing plus what happened to it.

    ``diagnostics`` is deliberately structured: a half listing without a reason is the failure mode
    this field exists to prevent — the model would read a dropped tail as "that skill does not
    exist" instead of "the listing was cut".
    """

    content: str = ""
    status: str = STATUS_EMPTY
    charged: int = 0
    truncated: bool = False
    diagnostics: tuple[str, ...] = field(default_factory=tuple)


def _line_key(line: str) -> str:
    """Ledger key of one listed skill: the display name CP put in front of the separator."""
    name = line.split(NAME_SEPARATOR, 1)[0].strip()
    return f"skill:{name}" if name else f"skill:{line[:32]}"


def render_skill_catalog(
    items: Sequence[str],
    *,
    ledger: InjectionLedger,
    max_tokens: int | None = None,
    count_tokens: Callable[[str], int] = conservative_token_count,
    cp_truncated: bool = False,
) -> SkillCatalogBlock:
    """Fit the CP-provided listing into the run's skills budget.

    Order is CP's (frozen priority: AGENT before USER, workspace before instance, then name), so
    "keep the head" is the same as "keep the highest-priority skills".

    Args:
        items: already-rendered ``"<qualified name> — <description>"`` lines.
        ledger: the run-scoped ledger; production passes the same instance the nested injection
            uses (``nested_injection.ledger_for_context``), tests may create one directly.
        max_tokens: the component's own ``maxTokens``; it can only *tighten* the ledger cap.
        count_tokens: injected so a provider tokenizer could replace the conservative estimate.
        cp_truncated: PLAN-0628 M2a (D28-39): CP reported the listing as cut by its own count bound
            (``maxSkills``) *before* it reached us. The budget below may be perfectly happy with what
            it received — which is precisely the danger: the model would read a partial listing as the
            complete set. So a CP-side cut must also produce the in-band sentence, through the same
            reserved-budget path (a note charged after the lines would be dropped exactly then).
    """
    lines = [item.strip() for item in items if item and item.strip()]
    if not lines:
        return SkillCatalogBlock(diagnostics=(DIAG_EMPTY,))

    diagnostics: list[str] = []
    # Tokens already booked on this ledger for `skills`. A second render in the same run (a retry
    # that re-enters the seam) must not charge the same entry twice: `try_charge` is not idempotent,
    # so skipping booked keys is the caller's job — the rule `charge_nested_for_touch` already
    # follows for the JIT chain.
    before = ledger.by_source["skills"]
    already = ledger.charged_keys("skills")
    header_tokens = count_tokens(HEADER + "\n")
    pairs: list[tuple[str, int]] = [(HEADER_KEY, header_tokens)]
    pairs.extend((_line_key(line), count_tokens(line + "\n")) for line in lines)

    # 1) Component-level tightening happens BEFORE charging, so a small maxTokens does not consume
    #    the shared skills cap for lines it will drop anyway.
    if max_tokens is not None and max_tokens > 0:
        kept: list[tuple[str, int]] = [pairs[0]]
        used = header_tokens
        for key, tokens in pairs[1:]:
            if used + tokens > max_tokens:
                break
            kept.append((key, tokens))
            used += tokens
        if len(kept) < len(pairs):
            diagnostics.append(DIAG_COMPONENT_MAX_TOKENS)
        pairs = kept

    # 2) Degenerate ledger: no window was supplied, so the cap is the absolute fallback. Say so
    #    instead of silently pretending the numbers are window-derived.
    if ledger.limits.window_tokens <= 0:
        diagnostics.append(DIAG_WINDOW_UNKNOWN)

    # 3) Reserve the truncation sentence BEFORE the lines are charged.
    #    This is the subtle one: if the note were charged after the listing, it would fail exactly
    #    when it is most needed (the cap is already full because the listing was cut). Reserving it
    #    up front means the model always learns that the list is partial. The reservation is
    #    arithmetic on the ledger's own limits — not a second budget computation.
    #
    #    `room` must be the room `charge_assembly` will actually grant, not just the skills cap: a
    #    listing can fit the 1% cap and still be cut by the shared pool (memory already holds its
    #    floor). Computing this from `caps["skills"]` alone let that cut through without the
    #    sentence — "cut but not told", the exact state D28-41 forbids.
    note_tokens = count_tokens(TRUNCATION_NOTE + "\n")
    cap_room = ledger.limits.caps["skills"] - ledger.by_source["skills"]
    floor_room = max(0, ledger.limits.floors["skills"] - ledger.by_source["skills"])
    # `priority=True` may borrow the floor even when the pool is exhausted (same rule as try_charge).
    pool_room = max(ledger.remaining(), floor_room)
    room = max(0, min(cap_room, pool_room))
    may_truncate = cp_truncated or sum(tokens for _, tokens in pairs) > room
    note_booked = TRUNCATION_NOTE_KEY in already
    reserved_note = False
    if may_truncate and not note_booked:
        reserved_note = ledger.try_charge("skills", TRUNCATION_NOTE_KEY, note_tokens, priority=True)

    # 4) Charge only the entries this call has not booked yet, then address the block by the union:
    #    a re-render re-uses the booked lines instead of paying for the same text twice.
    charge = charge_assembly(ledger, skills=[(key, tokens) for key, tokens in pairs if key not in already])
    charged_keys = set(charge.skills) | already
    note_paid = reserved_note or note_booked

    # 5) The header must fit first: without it the lines are a mystery list.
    if HEADER_KEY not in charged_keys:
        diagnostics.append(DIAG_BUDGET_TRUNCATED)
        content = TRUNCATION_NOTE if note_paid else ""
        return SkillCatalogBlock(
            content=content,
            status=STATUS_TRUNCATED,
            # A ledger reading, never a second sum: this call's delta is what it actually booked.
            charged=ledger.by_source["skills"] - before,
            truncated=True,
            diagnostics=tuple(diagnostics),
        )

    kept_lines: list[str] = []
    for line in lines:
        if _line_key(line) not in charged_keys:
            break
        kept_lines.append(line)

    charged_tokens = ledger.by_source["skills"] - before
    truncated = cp_truncated or len(kept_lines) < len(lines)
    if (charge.skills_truncated or truncated) and DIAG_BUDGET_TRUNCATED not in diagnostics:
        diagnostics.append(DIAG_BUDGET_TRUNCATED)

    content = HEADER if not kept_lines else HEADER + "\n" + "\n".join(kept_lines)

    # 6) Truncation must be VISIBLE TO THE MODEL, not only in `diagnostics` (D28-31 follow-up).
    #    A structured diagnostic is read by operators; the model only sees this text. Without an
    #    in-band sentence a cut listing reads as "the complete set of skills" and the model will
    #    confidently deny that a skill it cannot see exists — the exact failure this line removes.
    if truncated and note_paid:
        content = content + "\n" + TRUNCATION_NOTE

    return SkillCatalogBlock(
        content=content,
        status=STATUS_TRUNCATED if truncated else STATUS_READY,
        charged=charged_tokens,
        truncated=truncated,
        diagnostics=tuple(diagnostics),
    )


def render_from_component_sources(
    context: Any,
    component_sources: Mapping[str, Any] | None,
    *,
    max_tokens: int | None = None,
    count_tokens: Callable[[str], int] = conservative_token_count,
) -> tuple[str, dict[str, Any]]:
    """Produce the ``${xh.skill_catalog}`` slot value from CP's component sources.

    This is the only place the slot is filled (G-0's single producer seam,
    ``api/chat.py#xh_context_slots``). Returns ``(content, diagnostics)``; ``content`` is ``""``
    when the run has no listing, which is what keeps the slot from becoming ``MISSING_VARIABLE``.

    The ledger is the run-scoped one (``ledger_for_context``), so the listing shares its budget with
    PLAN-0627's nested injection and PLAN-0629's memory instead of getting a second budget.
    """
    sources = component_sources if isinstance(component_sources, Mapping) else {}
    matched: list[dict[str, Any]] = []
    for entry in sources.values():
        if isinstance(entry, dict) and entry.get("source") == SOURCE_SKILL_BINDINGS:
            matched.append(entry)

    items: list[str] = []
    cp_truncated = False
    for entry in matched:
        raw = entry.get("items")
        if isinstance(raw, list):
            items.extend(item for item in raw if isinstance(item, str))
        if entry.get("truncated") is True or str(entry.get("status")) == STATUS_TRUNCATED:
            cp_truncated = True

    ledger = ledger_for_context(context)
    block = render_skill_catalog(
        items,
        ledger=ledger,
        max_tokens=max_tokens,
        count_tokens=count_tokens,
        cp_truncated=cp_truncated,
    )
    diagnostics: dict[str, Any] = {
        "components": len(matched),
        "componentStatuses": [str(entry.get("status")) for entry in matched],
        "cpDiagnostics": [
            diagnostic
            for entry in matched
            for diagnostic in (entry.get("diagnostics") or [])
            if isinstance(diagnostic, str)
        ],
        "cpTruncated": cp_truncated,
        "items": len(items),
        "status": block.status,
        "charged": block.charged,
        "truncated": block.truncated,
        "diagnostics": list(block.diagnostics),
        # Operator view of the ledger after this charge (no injected text): what the
        # ``event=skill_catalog_charge`` line in ``api/chat.py`` prints, and what a test can assert
        # without reaching into ``context.metadata``.
        "ledger": ledger.snapshot(),
    }
    return block.content, diagnostics
