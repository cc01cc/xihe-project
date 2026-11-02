"""PLAN-0628 M1: the skills listing block — the *budget* half (CP owns the *subset* half).

Division of labour (D28-19): CP resolves which skills a run may see and renders one line per skill
(``<qualified name> — <description>``, because the wire contract is ``items: list[str]``); the Agent
only decides how much of that listing fits the prompt.

Budget rules are **not** re-derived here: the numbers live in
:mod:`xihe_agent.context.injection_budget` (D27-22) and this module calls :func:`charge_assembly`,
so skills are charged before memory on the *same* run-scoped ledger PLAN-0627's nested injection
uses. Adding a second percentage or a second ledger is the thing this module exists to prevent.
"""

from __future__ import annotations

from collections.abc import Callable, Sequence
from dataclasses import dataclass, field

from .injection_budget import InjectionLedger, charge_assembly, conservative_token_count

#: One line of framing, charged like any other entry (otherwise the block could exceed its cap).
HEADER = "Available skills (name — description); load full text by name when relevant:"

#: Ledger key of the header, so it participates in charging and in ``charged_keys`` dedupe.
HEADER_KEY = "skill_catalog:header"

#: Separator CP uses between the qualified name and the description.
NAME_SEPARATOR = " — "

DIAG_EMPTY = "skill_catalog_empty"
DIAG_COMPONENT_MAX_TOKENS = "skill_catalog_component_max_tokens_reached"
DIAG_BUDGET_TRUNCATED = "skill_catalog_budget_truncated"
DIAG_WINDOW_UNKNOWN = "skill_catalog_budget_window_unknown"

STATUS_READY = "ready"
STATUS_TRUNCATED = "truncated"
STATUS_EMPTY = "empty"


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
    """
    lines = [item.strip() for item in items if item and item.strip()]
    if not lines:
        return SkillCatalogBlock(diagnostics=(DIAG_EMPTY,))

    diagnostics: list[str] = []
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

    charge = charge_assembly(ledger, skills=pairs)
    charged_keys = list(charge.skills)

    # 3) The header must fit first: without it the lines are a mystery list.
    if HEADER_KEY not in charged_keys:
        diagnostics.append(DIAG_BUDGET_TRUNCATED)
        return SkillCatalogBlock(
            content="",
            status=STATUS_TRUNCATED,
            charged=0,
            truncated=True,
            diagnostics=tuple(diagnostics),
        )

    kept_lines: list[str] = []
    for line in lines:
        if _line_key(line) not in charged_keys:
            break
        kept_lines.append(line)

    charged_tokens = header_tokens + sum(
        tokens for key, tokens in pairs if key in charged_keys and key != HEADER_KEY
    )
    truncated = len(kept_lines) < len(lines)
    if (charge.skills_truncated or truncated) and DIAG_BUDGET_TRUNCATED not in diagnostics:
        diagnostics.append(DIAG_BUDGET_TRUNCATED)

    content = HEADER if not kept_lines else HEADER + "\n" + "\n".join(kept_lines)
    return SkillCatalogBlock(
        content=content,
        status=STATUS_TRUNCATED if truncated else STATUS_READY,
        charged=charged_tokens,
        truncated=truncated,
        diagnostics=tuple(diagnostics),
    )
