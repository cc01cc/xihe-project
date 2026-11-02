"""PLAN-0635 M2 (D35-01/D35-03): inline ``@文件`` content under the PLAN-0627 budget.

Frozen constraints (do **not** "simplify" these away):

* **Charging reuses the existing ledger** — ``InjectionLedger`` source ``"nested"`` with the
  workspace-relative path as the key. This is not a shortcut, it is the *only* legal path:
  ``InjectionLedger.try_charge`` raises ``ValueError`` for any source outside ``SOURCES``
  (``skills`` / ``memory`` / ``nested``) and the caps/floors live in ``plan_limits``, so adding
  a fourth source would mean editing the budget itself (forbidden by PLAN-0635).
  Sharing the source **and the key space** has a second, deliberate effect: PLAN-0627's nested
  ``AGENTS.md`` injection and a ``@docs/AGENTS.md`` mention deduplicate each other, because
  ``charge_nested_for_touch`` reads ``ledger.charged_keys("nested")`` too — the same file is
  never injected twice in one run.
* **CP does not estimate tokens**; counting happens here (same split as 0627 nested / 0629
  memory): CP only reports ``truncated``.
* **``<= INLINE_TOKEN_LIMIT`` is inlined, larger mentions render path-only** so the model reads
  the file itself with ``read_file`` instead of silently receiving a truncated body (D35-01).

Rendering reuses ``nested_injection.render_nested_blocks`` (one untrusted envelope per file,
escaping + provenance) — file content is repo content, so the same envelope applies.
"""

from __future__ import annotations

from collections.abc import Callable, Sequence
from dataclasses import dataclass
from typing import Any

from .injection_budget import InjectionLedger, conservative_token_count
from .nested_injection import ledger_for_context, neutralize_reserved_tags, render_nested_blocks

#: D35-01: bodies at or below this many tokens are inlined; larger ones become path-only.
INLINE_TOKEN_LIMIT = 2000

#: Told to the model when CP cut the body at its own 64 KiB read bound. Without this the model
#: reasons about a partial file as if it were complete.
TRUNCATION_HINT = "（该文件已被截断，以上不是全文；需要完整内容请用 read_file 读取该路径。）"

#: Told to the model when the body exceeded the inline budget and was **not** injected at all.
PATH_ONLY_HINT = "（该文件超出内联预算，未注入内容；需要内容请用 read_file 读取上方路径。）"

#: Directories never carry bodies: only the path plus this pointer.
DIRECTORY_HINT = "（目录提及；需要内容请用 list_directory 或 read_file 访问该路径。）"

_LEGAL_KINDS = frozenset({"file", "directory"})


@dataclass(frozen=True)
class PathMention:
    """One ``@path`` target resolved by CP."""

    path: str
    kind: str
    content: str
    truncated: bool = False


@dataclass(frozen=True)
class PathMentionInjection:
    """Admitted inline entries plus the path-only tails. No file text outside ``entries``."""

    entries: tuple[tuple[str, str], ...] = ()
    path_only: tuple[str, ...] = ()
    denied: tuple[str, ...] = ()


def parse_path_mentions(payload: Any) -> list[PathMention]:
    """Project CP's ``pathMentions`` array into entries, dropping malformed rows.

    Malformed rows are dropped rather than raising: the field is additive/optional, so a bad row
    must never break a chat turn.
    """
    if not isinstance(payload, list):
        return []
    mentions: list[PathMention] = []
    for raw in payload:
        if not isinstance(raw, dict):
            continue
        path = raw.get("path")
        kind = raw.get("kind")
        content = raw.get("content")
        if not isinstance(path, str) or not path.strip():
            continue
        if not isinstance(kind, str) or kind not in _LEGAL_KINDS:
            continue
        mentions.append(
            PathMention(
                path=path,
                kind=kind,
                content=content if isinstance(content, str) else "",
                truncated=raw.get("truncated") is True,
            )
        )
    return mentions


def charge_path_mentions(
    ledger: InjectionLedger,
    mentions: Sequence[PathMention],
    *,
    inline_token_limit: int = INLINE_TOKEN_LIMIT,
    count_tokens: Callable[[str], int] = conservative_token_count,
) -> PathMentionInjection:
    """Charge inline bodies on the shared ``nested`` ledger line, in the caller's order.

    * a path already charged under ``nested`` (by 0627 or by an earlier mention) is skipped —
      that *is* the dedupe rule;
    * a body whose token count exceeds ``inline_token_limit`` becomes path-only (never truncated
      silently: the model gets ``PATH_ONLY_HINT`` instead of a half file);
    * a body that does not fit the remaining budget becomes path-only as well (fail-soft: the
      tool is still available, so the model can read it itself).
    """
    admitted: list[tuple[str, str]] = []
    path_only: list[str] = []
    denied: list[str] = []
    already = ledger.charged_keys("nested")
    for mention in mentions:
        if mention.path in already:
            continue
        if mention.kind == "directory":
            # A directory listing is small and is not the file body: keep it inline but still
            # charge it, so a second mention of the same directory does not repeat it.
            body = mention.content.strip()
            tokens = int(count_tokens(body)) if body else 0
            if tokens and ledger.try_charge("nested", mention.path, tokens):
                admitted.append((mention.path, body))
            elif tokens:
                path_only.append(mention.path)
            continue
        body = mention.content
        tokens = int(count_tokens(body)) if body else 0
        if tokens > inline_token_limit:
            path_only.append(mention.path)
            continue
        if mention.truncated:
            body = f"{body.rstrip()}\n{TRUNCATION_HINT}"
            tokens = int(count_tokens(body))
        if tokens and not ledger.try_charge("nested", mention.path, tokens):
            path_only.append(mention.path)
            denied.append(mention.path)
            continue
        admitted.append((mention.path, body))
    return PathMentionInjection(
        entries=tuple(admitted), path_only=tuple(path_only), denied=tuple(denied)
    )


def render_path_mentions(injection: PathMentionInjection) -> str:
    """Render admitted bodies with the 0627 envelope, then the path-only pointers.

    Returns an empty string when there is nothing to inject, so callers can concatenate
    unconditionally (``nested_injection.resolve_and_render`` has the same contract).
    """
    if not injection.entries and not injection.path_only:
        return ""
    blocks: list[str] = []
    if injection.entries:
        blocks.append(render_nested_blocks(injection.entries))
    if injection.path_only:
        lines = ["已提及但未内联的工作区路径："]
        for path in injection.path_only:
            lines.append(f"- {neutralize_reserved_tags(path)}")
        lines.append(PATH_ONLY_HINT)
        blocks.append("\n".join(lines))
    return "\n".join(blocks)


def render_for_context(
    context: Any, mentions: Sequence[PathMention]
) -> tuple[str, dict[str, Any]]:
    """Charge ``mentions`` on the context's run-scoped ledger and render the block.

    Returns ``(block, diagnostics)``. ``block`` is ``""`` when nothing is injectable, so the
    caller can append unconditionally. ``diagnostics`` is structured and safe to log/persist
    (counts and paths only — never file text), which is what keeps a silent drop from happening:

    * ``requested``  — rows CP sent (after malformed rows were dropped by the parser);
    * ``inlined``    — bodies actually put into the prompt;
    * ``pathOnly``   — over the inline budget, or the charge did not fit;
    * ``denied``     — charge rejected because the run budget is exhausted;
    * ``truncated``  — CP cut the body; the model was told so in-band.

    The ledger is the *same* run-scoped instance PLAN-0627 uses, so nested ``AGENTS.md`` and a
    ``@docs/AGENTS.md`` mention cannot both inject the same file.
    """
    diagnostics: dict[str, Any] = {
        "requested": len(mentions),
        "inlined": 0,
        "pathOnly": [],
        "denied": [],
        "truncated": [],
    }
    if not mentions:
        return "", diagnostics
    ledger = ledger_for_context(context)
    injection = charge_path_mentions(ledger, mentions)
    diagnostics["inlined"] = len(injection.entries)
    diagnostics["pathOnly"] = list(injection.path_only)
    diagnostics["denied"] = list(injection.denied)
    diagnostics["truncated"] = [
        path for path, body in injection.entries if TRUNCATION_HINT in body
    ]
    return render_path_mentions(injection), diagnostics


def append_to_user_input(content: str, block: str) -> str:
    """Append the rendered block to the template ``user_input`` slot.

    PLAN-0635 M2: the block goes into ``user_input`` and **not** into ``messages`` — in template
    mode only ``user_input`` reaches the provider body, so appending to ``messages`` would both
    miss the model and double-count context tokens.
    """
    if not block:
        return content
    return f"{content}\n\n{block}"
