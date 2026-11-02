"""PLAN-0627 D27-21/D27-22: the single run-scoped injection budget ledger.

Three plans inject non-conversation text that shares one context window:

* PLAN-0628 skills listing  — eager, assembly time (name + description).
* PLAN-0629 agent memory    — eager, assembly time (system slot).
* PLAN-0627 nested AGENTS.md — JIT, appended to a tool result tail.

D27-22 freezes **one** module for all three: every source asks the ledger
"may I charge N tokens for source S?" and the ledger answers with the frozen
allocation and eviction rule. Consumers must not keep a second private budget.

Allocation (denominator = context window, D27-21; window = ``usage.windowTokens``
which resolves ``context-policy.maxInputTokens`` before litellm's model table)::

    headroom = max(0, 0.70 * window - baseline)   # baseline = assembled payload
    total    = min(0.15 * headroom, 0.08 * window)
               (4_000 tokens when the window is unknown, and never below the
                guaranteed assembly floors so ``used <= total`` always holds)

    skills : floor  512 tok,  cap 1%  * window          (0628 frozen wording)
    memory : floor 2%   * window, cap 4% * window       (0629)
    nested : floor 0,      cap min(4% * window, 4_000 tok)  (0627, + 16 KiB chars)

Eviction order is frozen as ``nested -> memory(above floor) -> skills(above
floor)``: nested is the only source whose absence loses no capability, so it is
the first to be denied when the pool is tight.
"""

from __future__ import annotations

from collections.abc import Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass, field

# --- D27-21 frozen numbers (code constants; M1 adds no config keys) ----------
WINDOW_SOFT_PCT = 0.70  # == ContextService.SOFT_THRESHOLD_PCT (compaction trigger)
POOL_OF_HEADROOM = 0.15
POOL_CAP_OF_WINDOW = 0.08
POOL_FLOOR_TOKENS = 4_000

SKILLS_PCT = 0.01
SKILLS_FLOOR_TOKENS = 512
SKILLS_FALLBACK_CAP_TOKENS = 2_000

MEMORY_PCT_FLOOR = 0.02
MEMORY_PCT_CAP = 0.04
MEMORY_FALLBACK_FLOOR_TOKENS = 1_000
MEMORY_FALLBACK_CAP_TOKENS = 4_000

NESTED_PCT_CAP = 0.04
NESTED_FALLBACK_CAP_TOKENS = 8_000
NESTED_TOKENS_PER_FILE = 1_000
NESTED_TOKENS_PER_CALL = 2_000
NESTED_TOKENS_PER_RUN = 4_000
NESTED_CHARS_PER_FILE = 4 * 1024
NESTED_CHARS_PER_CALL = 8 * 1024
NESTED_CHARS_PER_RUN = 16 * 1024

SOURCES = ("skills", "memory", "nested")
#: Frozen degradation order (D27-22). The ledger only ever denies in this order.
EVICTION_ORDER = ("nested", "memory", "skills")

TRUNCATION_MARKER = "\n…[truncated]"


def conservative_token_count(text: str) -> int:
    """Char/2 estimate used when the caller has no provider tokenizer.

    Deliberately pessimistic (real ratio is closer to char/3–char/4 for mixed
    CJK/Latin text) so the budget over-counts instead of over-injecting.
    """
    if not text:
        return 0
    return max(1, len(text) // 2)


def _pct_cap(pct: float, window: int, fallback: int) -> int:
    return int(pct * window) if window > 0 else fallback


@dataclass(frozen=True)
class InjectionLimits:
    """Per-run limits derived from the context window and the assembled baseline."""

    window_tokens: int
    baseline_tokens: int
    total: int
    caps: Mapping[str, int]
    floors: Mapping[str, int]


def plan_limits(window_tokens: int, baseline_tokens: int = 0) -> InjectionLimits:
    """Apply D27-21: pool of the headroom below the compaction trigger."""
    window = max(0, int(window_tokens))
    baseline = max(0, int(baseline_tokens))
    headroom = max(0, int(WINDOW_SOFT_PCT * window) - baseline)
    if window > 0:
        raw_total = min(int(POOL_OF_HEADROOM * headroom), int(POOL_CAP_OF_WINDOW * window))
    else:
        raw_total = POOL_FLOOR_TOKENS

    floors = {
        "skills": SKILLS_FLOOR_TOKENS,
        "memory": _pct_cap(MEMORY_PCT_FLOOR, window, MEMORY_FALLBACK_FLOOR_TOKENS),
        "nested": 0,
    }
    caps = {
        "skills": max(SKILLS_FLOOR_TOKENS, _pct_cap(SKILLS_PCT, window, SKILLS_FALLBACK_CAP_TOKENS)),
        "memory": max(floors["memory"], _pct_cap(MEMORY_PCT_CAP, window, MEMORY_FALLBACK_CAP_TOKENS)),
        "nested": min(
            _pct_cap(NESTED_PCT_CAP, window, NESTED_FALLBACK_CAP_TOKENS),
            NESTED_TOKENS_PER_RUN,
        ),
    }
    # The guaranteed floors are part of the pool, so ``used <= total`` is an
    # invariant even on a tiny window (floors are charged before any JIT text).
    total = max(raw_total, sum(floors.values()))
    return InjectionLimits(window, baseline, total, caps, floors)


@dataclass
class InjectionLedger:
    """Run-scoped charge ledger. One instance per ChatRun; never persisted.

    The ledger is deliberately not thread-safe: a Run assembles and charges on
    one event loop.
    """

    limits: InjectionLimits
    by_source: dict[str, int] = field(default_factory=lambda: {name: 0 for name in SOURCES})
    entries: list[dict[str, object]] = field(default_factory=list)

    @classmethod
    def create(cls, window_tokens: int = 0, baseline_tokens: int = 0) -> InjectionLedger:
        return cls(limits=plan_limits(window_tokens, baseline_tokens))

    # -- introspection -----------------------------------------------------
    def used(self) -> int:
        return sum(self.by_source.values())

    def remaining(self) -> int:
        return max(0, self.limits.total - self.used())

    def charged_keys(self, source: str) -> set[str]:
        return {str(entry["key"]) for entry in self.entries if entry["source"] == source}

    def snapshot(self) -> dict[str, object]:
        """Diagnostic view (safe to log; contains no injected text)."""
        return {
            "windowTokens": self.limits.window_tokens,
            "baselineTokens": self.limits.baseline_tokens,
            "total": self.limits.total,
            "used": self.used(),
            "bySource": dict(self.by_source),
            "caps": dict(self.limits.caps),
            "entries": len(self.entries),
        }

    # -- charging ----------------------------------------------------------
    def try_charge(self, source: str, key: str, tokens: int, priority: bool = False) -> bool:
        """All-or-nothing charge of ``tokens`` for ``source``.

        ``priority=True`` reserves the source's *floor* even when the pool is
        already tight; above the floor the pool guard still applies. The frozen
        invariant ``used <= total`` is asserted after every accepted charge.

        Not idempotent: charging the same ``(source, key)`` twice spends the pool
        twice. A consumer that may render one source more than once per run must
        skip keys already in :meth:`charged_keys` before charging
        (``charge_nested_for_touch`` and the 0628 listing both do); the ledger
        deliberately does not guess, because only the source knows whether a
        repeated key means "same text again" or "new text under a reused key".
        """
        if source not in SOURCES:
            raise ValueError(f"unknown injection source: {source}")
        if tokens <= 0:
            return False
        cap_room = self.limits.caps[source] - self.by_source[source]
        pool_room = self.remaining()
        if priority:
            floor_room = self.limits.floors[source] - self.by_source[source]
            pool_room = max(pool_room, floor_room)
        allowed = min(int(tokens), cap_room, pool_room)
        if allowed < int(tokens) or allowed <= 0:
            return False
        self.by_source[source] += int(tokens)
        self.entries.append({"source": source, "key": key, "tokens": int(tokens)})
        self._assert_invariants()
        return True

    def _assert_invariants(self) -> None:
        used = self.used()
        assert used <= self.limits.total, f"injection budget overflow: used={used} total={self.limits.total}"
        for source, amount in self.by_source.items():
            assert amount <= self.limits.caps[source], (
                f"injection source cap overflow: source={source} amount={amount} cap={self.limits.caps[source]}"
            )
            assert amount >= 0, f"negative injection charge for source={source}"


@dataclass(frozen=True)
class AssemblyCharge:
    """Result of charging the eager sources at assembly time."""

    skills: tuple[str, ...] = ()
    memory: tuple[str, ...] = ()
    skills_truncated: bool = False
    memory_truncated: bool = False


def charge_assembly(
    ledger: InjectionLedger,
    skills: Iterable[tuple[str, int]] = (),
    memory: Iterable[tuple[str, int, float]] = (),
) -> AssemblyCharge:
    """Charge 0628 skills first, then 0629 memory (D27-22 assembly phase).

    ``skills``: ``(key, tokens)`` pairs in the caller's display order.
    ``memory``: ``(key, tokens, salience)``; higher salience is served first.

    Skills get their floor first (capability discovery must not vanish); memory
    then fills its floor and, while the pool allows, grows towards its cap.
    """
    charged_skills: list[str] = []
    skills_truncated = False
    for key, tokens in skills:
        if ledger.try_charge("skills", key, tokens, priority=True):
            charged_skills.append(key)
        else:
            skills_truncated = True
            break

    charged_memory: list[str] = []
    memory_truncated = False
    ordered = sorted(memory, key=lambda item: (-float(item[2]), str(item[0])))
    for key, tokens, _salience in ordered:
        under_floor = ledger.by_source["memory"] < ledger.limits.floors["memory"]
        if ledger.try_charge("memory", key, tokens, priority=under_floor):
            charged_memory.append(key)
        else:
            memory_truncated = True
            break

    return AssemblyCharge(
        skills=tuple(charged_skills),
        memory=tuple(charged_memory),
        skills_truncated=skills_truncated,
        memory_truncated=memory_truncated,
    )


@dataclass(frozen=True)
class NestedEntry:
    """One ancestor ``AGENTS.md`` resolved by CP for the touched path."""

    path: str
    content: str

    def depth(self) -> int:
        return len([part for part in self.path.replace("\\", "/").split("/") if part])


@dataclass(frozen=True)
class NestedInjection:
    """Admitted ancestor blocks, ordered root -> nearest (D27-02).

    Formatting is **not** done here: ``context/nested_injection.py`` renders the
    admitted pairs with the D27-19 B′ ``<untrusted-repo-instructions>`` envelope
    (escaping + provenance). This module only owns the allocation rule.
    """

    entries: tuple[tuple[str, str], ...] = ()
    denied: tuple[str, ...] = ()
    truncated: bool = False

    @property
    def paths(self) -> tuple[str, ...]:
        return tuple(path for path, _ in self.entries)


def _safe_utf8_cut(text: str, limit_chars: int) -> str:
    """Cut ``text`` to ``limit_chars`` without splitting a non-BMP code point."""
    if len(text) <= limit_chars:
        return text
    cut = text[: max(0, limit_chars)]
    if cut and 0xD800 <= ord(cut[-1]) <= 0xDBFF:
        cut = cut[:-1]
    return cut


def charge_nested_for_touch(
    ledger: InjectionLedger,
    entries: Sequence[NestedEntry],
    *,
    root_path: str = "AGENTS.md",
    count_tokens: Callable[[str], int] = conservative_token_count,
) -> NestedInjection:
    """Charge the JIT ancestor chain for one touched path (PLAN-0627).

    * Admission runs **nearest -> root** so a tight budget keeps the closest
      ancestor (frozen #3 "超限保留最近祖先").
    * The admitted blocks are returned **root -> nearest** for rendering.
    * The workspace-root file is skipped: it is already carried by the eager L1
      source (``root_agents_md``), so re-injecting it would double the root rules.
    * Every refusal is recorded in ``denied`` (diagnostics, no text).
    """
    ordered = sorted(
        (entry for entry in entries if entry.path and entry.path != root_path and entry.content.strip()),
        key=lambda entry: (entry.depth(), entry.path),
    )
    already = ledger.charged_keys("nested")
    admitted: list[tuple[str, str]] = []
    denied: list[str] = []
    truncated = False
    call_chars = 0
    for entry in reversed(ordered):  # nearest first
        if entry.path in already:
            continue
        body = entry.content
        if len(body) > NESTED_CHARS_PER_FILE:
            body = _safe_utf8_cut(body, NESTED_CHARS_PER_FILE) + TRUNCATION_MARKER
            truncated = True
        if call_chars + len(body) > NESTED_CHARS_PER_CALL:
            denied.append(entry.path)
            truncated = True
            break
        run_chars = sum(len(text) for _, text in admitted)
        if run_chars + len(body) > NESTED_CHARS_PER_RUN:
            denied.append(entry.path)
            truncated = True
            break
        tokens = min(int(count_tokens(body)), NESTED_TOKENS_PER_FILE)
        if not ledger.try_charge("nested", entry.path, tokens):
            denied.append(entry.path)
            break
        admitted.append((entry.path, body))
        call_chars += len(body)
    admitted.sort(key=lambda item: (len([p for p in item[0].split("/") if p]), item[0]))
    return NestedInjection(entries=tuple(admitted), denied=tuple(denied), truncated=truncated)


def nested_per_call_tokens() -> int:
    """Per-tool-result token ceiling for nested text (D27-22 cap 4% / 16 KiB run)."""
    return NESTED_TOKENS_PER_CALL
