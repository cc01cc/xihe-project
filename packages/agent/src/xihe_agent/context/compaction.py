"""task-110: hybrid context compaction — budget trigger + fact fidelity.

Card: internal/A03-xihe/handoff/open-cards-2026-11-19.md section task-110 (scheme
C, minimal set). Two things live here and nothing else:

1. **When** tool-result bodies are cleared. contextCompaction is the rollback
   switch: 'off' never compacts, 'budget' waits until the assembled history
   reaches 0.8 x maxInputTokens and only then clears the oldest bodies
   (pruneWindowChars ordering, unchanged), and 'overflow' keeps today's
   behaviour (prune every run). The trigger only decides *when* to compact; it
   never widens the inbound cap (truncate_for_run) nor the CONTEXT_OVERFLOW
   terminal state.
2. **What must survive** it. The tool-call list, approval request ids and file
   paths are read before and after the prune and compared item by item. A masked
   tool result carries a one-line stub of the facts it held, so masking cannot
   silently drop them; if anything still differs the run reverts to the
   uncompressed history and the reason travels on the 'context.prune' event
   (never a silent downgrade).

The pruner itself stays in agent_runner.langgraph_runner (it owns the
pairing/tombstone semantics); it is injected here so this module never imports
the runner at module scope (that would be a cycle: the runner imports context
modules).
"""

from __future__ import annotations

import json
import re
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from typing import Any

from loguru import logger

from xihe_agent.context_policy import (
    COMPACTION_MODES,
    DEFAULT_COMPACTION_MODE,
    DEFAULT_MAX_INPUT_TOKENS,
)
from xihe_agent.interfaces.message import Message

#: Budget trigger: the assembled history must reach this share of the model window.
BUDGET_TRIGGER_RATIO = 0.8
#: Prefix of the one-line fact stub carried by a masked tool result.
FACT_STUB_PREFIX = "[preserved facts]"

#: Facts kept verbatim through a compaction. Order-insensitive, presence-based:
#: a masked body is one placeholder either way, so multiplicity carries no signal.
_APPROVAL_ID_RE = re.compile(r"approvalRequestId[^A-Za-z0-9]{1,6}([A-Za-z0-9][A-Za-z0-9_.:-]{3,})")
_FILE_TOKEN_RE = re.compile(
    r"(?<![\w/.-])((?:[A-Za-z]:/)?(?:[\w.@-]+/)*[\w.@-]+\.[A-Za-z0-9]{1,8})(?![\w/.-])"
)

Pruner = Callable[..., Any]


@dataclass(frozen=True)
class CompactionFacts:
    """The fact triple a compaction must not move (card: tool calls / approvals / paths)."""

    tool_call_ids: tuple[str, ...] = ()
    approval_ids: tuple[str, ...] = ()
    file_paths: tuple[str, ...] = ()

    def counts(self) -> dict[str, int]:
        return {
            "toolCallIds": len(self.tool_call_ids),
            "approvalIds": len(self.approval_ids),
            "filePaths": len(self.file_paths),
        }


@dataclass(frozen=True)
class CompactionOutcome:
    """Result of one compaction attempt.

    messages is always safe to continue with: the compacted view when applied,
    otherwise the original (uncompressed) history. reverted says the pruner ran
    but its output was rejected — the caller must record that on the event rather
    than treating the run as compacted.
    """

    mode: str
    triggered: bool
    reason: str
    messages: list[Message]
    tombstones: list[Any] = field(default_factory=list)
    facts_before: CompactionFacts = CompactionFacts()
    facts_after: CompactionFacts = CompactionFacts()
    estimated_input_tokens: int = 0
    threshold_tokens: int = 0
    reverted: bool = False
    error: str | None = None

    @property
    def applied(self) -> bool:
        return bool(self.tombstones) and not self.reverted

    @property
    def pruned_count(self) -> int:
        return len(self.tombstones)

    def to_payload(self) -> dict[str, Any]:
        """Wire shape for the compaction sub-object of 'context.prune'.

        The event type stays 'context.prune' on purpose: the CP taxonomy is
        outside this card's write scope, and an additive sub-object is replay-safe
        (applyPrune in the CP ignores unknown keys).
        """
        return {
            "mode": self.mode,
            "triggered": self.triggered,
            "applied": self.applied,
            "reverted": self.reverted,
            "reason": self.reason,
            "prunedCount": self.pruned_count,
            "estimatedInputTokens": self.estimated_input_tokens,
            "thresholdTokens": self.threshold_tokens,
            "facts": self.facts_before.counts(),
            "error": self.error,
        }


def normalize_mode(mode: str | None) -> str:
    """Resolve the switch value; an unknown value warns and falls back to today."""
    value = (mode or "").strip().lower()
    if not value:
        return DEFAULT_COMPACTION_MODE
    if value in COMPACTION_MODES:
        return value
    logger.warning(
        "[LIFECYCLE] service=agent event=context_compaction_mode_invalid mode={} fallback={}",
        mode,
        DEFAULT_COMPACTION_MODE,
    )
    return DEFAULT_COMPACTION_MODE


def resolve_threshold(max_input_tokens: int | None) -> int:
    """0.8 x maxInputTokens (code default window when the model did not resolve)."""
    window = max_input_tokens if isinstance(max_input_tokens, int) and max_input_tokens > 0 else DEFAULT_MAX_INPUT_TOKENS
    return max(1, int(window * BUDGET_TRIGGER_RATIO))


def _content_text(message: Any) -> str:
    content = getattr(message, "content", "")
    if not isinstance(content, str):
        try:
            content = json.dumps(content, ensure_ascii=False, default=str)
        except (TypeError, ValueError) as exc:
            logger.warning(
                "compaction: content could not be serialized for fact extraction ({})",
                type(exc).__name__,
                exc_info=True,
            )
            content = str(content)
    return content.replace("\\", "/")


def _tool_call_ids(message: Any) -> list[str]:
    ids: list[str] = []
    call_id = getattr(message, "tool_call_id", "") or ""
    if isinstance(call_id, str) and call_id.strip():
        ids.append(call_id.strip())
    for call in getattr(message, "tool_calls", ()) or ():
        ident = call.get("id") if isinstance(call, dict) else getattr(call, "id", None)
        if isinstance(ident, str) and ident.strip():
            ids.append(ident.strip())
    return ids


def _unique_sorted(values: Sequence[str]) -> tuple[str, ...]:
    return tuple(sorted({value for value in values if value}))


def extract_facts(messages: Sequence[Message]) -> CompactionFacts:
    """Read the fact triple off a message list (same reader before and after)."""
    tool_ids: list[str] = []
    approvals: list[str] = []
    paths: list[str] = []
    for message in messages:
        tool_ids.extend(_tool_call_ids(message))
        text = _content_text(message)
        approvals.extend(_APPROVAL_ID_RE.findall(text))
        paths.extend(_FILE_TOKEN_RE.findall(text))
    return CompactionFacts(
        tool_call_ids=_unique_sorted(tool_ids),
        approval_ids=_unique_sorted(approvals),
        file_paths=_unique_sorted(paths),
    )


def facts_diff(before: CompactionFacts, after: CompactionFacts) -> dict[str, list[str]]:
    """Item-by-item difference; empty dict means the triples are identical."""
    diff: dict[str, list[str]] = {}
    for name in ("tool_call_ids", "approval_ids", "file_paths"):
        lost = sorted(set(getattr(before, name)) - set(getattr(after, name)))
        gained = sorted(set(getattr(after, name)) - set(getattr(before, name)))
        if lost or gained:
            diff[name] = [f"-{item}" for item in lost] + [f"+{item}" for item in gained]
    return diff


def render_fact_stub(message: Any) -> str | None:
    """One-line stub carrying the facts a masked tool result used to hold.

    Returns None when the body held no fact — then the mask stays exactly the bare
    placeholder (no shape change for ordinary tool output).
    """
    text = _content_text(message)
    approvals = list(dict.fromkeys(_APPROVAL_ID_RE.findall(text)))
    paths = list(dict.fromkeys(_FILE_TOKEN_RE.findall(text)))
    if not approvals and not paths:
        return None
    parts = [FACT_STUB_PREFIX]
    parts.extend(f"approvalRequestId={item}" for item in approvals)
    parts.extend(f"path={item}" for item in paths)
    return " ".join(parts)


def _default_pruner(history: Sequence[Message], *, prune_window_chars: int, fact_stub: Pruner) -> Any:
    # Local import keeps the context package free of a module-level dependency on
    # the runner (the runner imports context modules).
    from xihe_agent.agent_runner.langgraph_runner import prune_history_tool_results

    return prune_history_tool_results(history, prune_window_chars=prune_window_chars, fact_stub=fact_stub)


def apply_compaction(
    messages: Sequence[Message],
    *,
    mode: str | None,
    prune_window_chars: int,
    max_input_tokens: int | None,
    estimated_input_tokens: int,
    pruner: Pruner | None = None,
) -> CompactionOutcome:
    """Run one compaction attempt under the resolved switch and the fact contract."""
    resolved_mode = normalize_mode(mode)
    base = list(messages)
    facts_before = extract_facts(base)
    threshold = resolve_threshold(max_input_tokens)

    def outcome(
        reason: str,
        *,
        triggered: bool,
        compacted: list[Message] | None = None,
        facts_after: CompactionFacts | None = None,
        **kwargs: Any,
    ) -> CompactionOutcome:
        chosen = list(compacted) if compacted is not None else list(base)
        return CompactionOutcome(
            mode=resolved_mode,
            triggered=triggered,
            reason=reason,
            messages=chosen,
            facts_before=facts_before,
            facts_after=facts_after if facts_after is not None else extract_facts(chosen),
            estimated_input_tokens=estimated_input_tokens,
            threshold_tokens=threshold,
            **kwargs,
        )

    if resolved_mode == "off":
        logger.debug(
            "[LIFECYCLE] service=agent event=context_compaction_skipped mode=off estimatedInputTokens={}",
            estimated_input_tokens,
        )
        return outcome("mode_off", triggered=False)

    triggered = True
    if resolved_mode == "budget" and estimated_input_tokens < threshold:
        triggered = False
        logger.debug(
            "[LIFECYCLE] service=agent event=context_compaction_below_threshold"
            " estimatedInputTokens={} thresholdTokens={}",
            estimated_input_tokens,
            threshold,
        )
        return outcome("below_threshold", triggered=False)

    try:
        pruner_fn = pruner if pruner is not None else _default_pruner
        result = pruner_fn(base, prune_window_chars=prune_window_chars, fact_stub=render_fact_stub)
    except Exception as exc:  # R4: the run continues uncompressed; never die inside compaction
        logger.error(
            "[LIFECYCLE] service=agent event=context_compaction_reverted reason=pruner_error error={}",
            f"{type(exc).__name__}: {exc}",
            exc_info=True,
        )
        return outcome(
            "pruner_error",
            triggered=triggered,
            reverted=True,
            error=f"{type(exc).__name__}: {exc}",
        )

    tombstones = list(getattr(result, "tombstones", ()) or ())
    compacted = list(getattr(result, "messages", base))
    facts_after = extract_facts(compacted)
    if facts_before != facts_after:
        diff = facts_diff(facts_before, facts_after)
        logger.error(
            "[LIFECYCLE] service=agent event=context_compaction_reverted reason=fidelity_mismatch diff={}",
            diff,
        )
        return outcome(
            "fidelity_mismatch",
            triggered=triggered,
            reverted=True,
            error=json.dumps(diff, ensure_ascii=False),
        )

    if not tombstones:
        return outcome("no_candidates", triggered=triggered, compacted=compacted, facts_after=facts_after)

    logger.info(
        "[LIFECYCLE] service=agent event=context_compaction_applied mode={} pruned={} estimatedInputTokens={}"
        " thresholdTokens={} facts={}",
        resolved_mode,
        len(tombstones),
        estimated_input_tokens,
        threshold,
        facts_before.counts(),
    )
    return outcome(
        "applied",
        triggered=triggered,
        compacted=compacted,
        facts_after=facts_after,
        tombstones=tombstones,
    )
