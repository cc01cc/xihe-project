"""PLAN-0627 D27-21/D27-22: injection budget ledger contract tests.

Five assertion groups required by the PLAN-0627 M1 task:
  1. allocation derivation (window / baseline / unknown-window fallback),
  2. invariant ``used <= total <= caps`` after every accepted charge,
  3. assembly floors (skills -> memory) and salience ordering,
  4. frozen degradation order ``nested -> memory -> skills``,
  5. nested JIT admission (nearest first), render order (root -> nearest),
     root-file skip, per-file truncation and per-run dedupe.
"""

import pytest

from xihe_agent.context.injection_budget import (
    NESTED_CHARS_PER_FILE,
    NESTED_TOKENS_PER_RUN,
    TRUNCATION_MARKER,
    InjectionLedger,
    NestedEntry,
    charge_assembly,
    charge_nested_for_touch,
    conservative_token_count,
    plan_limits,
)


def test_limits_from_window_and_zero_baseline():
    limits = plan_limits(128_000, 0)
    # headroom = 0.70 * 128_000 = 89_600 -> 0.15 * headroom = 13_440,
    # 0.08 * window = 10_240 -> pool = 10_240
    assert limits.total == 10_240
    assert limits.caps["skills"] == 1_280          # 1% of window
    assert limits.caps["memory"] == 5_120          # 4% of window
    assert limits.caps["nested"] == NESTED_TOKENS_PER_RUN  # min(4%, 4_000 tok)
    assert limits.floors["skills"] == 512
    assert limits.floors["memory"] == 2_560        # 2% of window
    assert limits.floors["nested"] == 0


def test_limits_fall_back_to_absolute_when_window_unknown():
    limits = plan_limits(0, 0)
    assert limits.total == 4_000
    assert limits.caps == {"skills": 2_000, "memory": 4_000, "nested": 4_000}
    assert limits.floors == {"skills": 512, "memory": 1_000, "nested": 0}


def test_limits_keep_invariant_on_tiny_window_and_large_baseline():
    # Tiny window: the pool would be 640, but the guaranteed floors are 672.
    tiny = plan_limits(8_000, 0)
    assert tiny.total == sum(tiny.floors.values()) == 672
    # No headroom left: the pool still covers the assembly floors.
    exhausted = plan_limits(128_000, 200_000)
    assert exhausted.total == sum(exhausted.floors.values()) == 3_072


def test_ledger_rejects_unknown_source_and_non_positive_charge():
    ledger = InjectionLedger.create(128_000)
    with pytest.raises(ValueError, match="unknown injection source"):
        ledger.try_charge("conversation", "x", 10)
    assert ledger.try_charge("memory", "x", 0) is False
    assert ledger.used() == 0


def test_invariants_hold_after_every_accepted_charge():
    ledger = InjectionLedger.create(128_000)
    assert ledger.try_charge("skills", "skill-a", 1_000)
    assert ledger.try_charge("memory", "mem-a", 2_000)
    assert ledger.try_charge("nested", "src/AGENTS.md", 3_000)
    snapshot = ledger.snapshot()
    assert snapshot["used"] == 6_000
    assert snapshot["used"] <= snapshot["total"]
    for source, amount in snapshot["bySource"].items():
        assert amount <= snapshot["caps"][source]
    # A charge that would cross the source cap is refused, never silently clipped.
    assert ledger.try_charge("skills", "skill-b", 10_000) is False
    assert ledger.by_source["skills"] == 1_000


def test_assembly_charges_skills_first_then_memory_by_salience():
    ledger = InjectionLedger.create(128_000)
    result = charge_assembly(
        ledger,
        skills=[("alpha", 600), ("beta", 600)],
        memory=[("low", 1_000, 0.1), ("high", 1_000, 0.9)],
    )
    assert result.skills == ("alpha", "beta")
    assert result.memory == ("high", "low")
    assert ledger.by_source["skills"] == 1_200
    assert ledger.by_source["memory"] == 2_000
    assert ledger.used() <= ledger.limits.total


def test_assembly_keeps_floors_when_pool_is_tiny():
    # window 8_000 -> total 672, memory floor 160, skills floor 512.
    ledger = InjectionLedger.create(8_000)
    result = charge_assembly(
        ledger,
        skills=[("big", 5_000)],
        memory=[("mem", 5_000, 1.0)],
    )
    assert result.skills == () and result.skills_truncated
    assert result.memory == () and result.memory_truncated
    # Nothing was forced through: the ledger stays consistent instead of over-charging.
    assert ledger.used() == 0
    assert ledger.used() <= ledger.limits.total


def test_degradation_order_is_nested_then_above_floor_memory_then_skills():
    """Frozen D27-22 order: nested is denied first and never displaces assembly."""
    ledger = InjectionLedger.create(8_000)  # total 672
    charge_assembly(ledger, skills=[("alpha", 512)], memory=[("m", 160, 1.0)])
    assert ledger.used() == 672
    skills_before = ledger.by_source["skills"]
    memory_before = ledger.by_source["memory"]

    denied = charge_nested_for_touch(
        ledger,
        [NestedEntry("src/AGENTS.md", "rules " * 100)],
    )
    assert denied.entries == ()
    assert denied.denied == ("src/AGENTS.md",)
    # nested denial must not shrink the eager sources (no capability loss).
    assert ledger.by_source["skills"] == skills_before
    assert ledger.by_source["memory"] == memory_before


def test_nested_admission_prefers_nearest_ancestor_and_renders_root_first():
    ledger = InjectionLedger.create(128_000)
    entries = [
        NestedEntry("AGENTS.md", "root rules"),            # owned by eager L1 (D27-21)
        NestedEntry("src/AGENTS.md", "src rules"),
        NestedEntry("src/deep/AGENTS.md", "deep rules"),
        NestedEntry("src/deep/deeper/AGENTS.md", "deeper rules"),
    ]
    injected = charge_nested_for_touch(ledger, entries)
    assert injected.paths == ("src/AGENTS.md", "src/deep/AGENTS.md", "src/deep/deeper/AGENTS.md")
    # the workspace-root file never enters the chain, so it can never be evicted
    assert "AGENTS.md" not in injected.paths
    # admitted pairs are ordered root -> nearest (render order, formatting lives in
    # context/nested_injection.py)
    depths = [path.count("/") for path in injected.paths]
    assert depths == sorted(depths)


def test_nested_keeps_nearest_ancestor_under_pressure():
    """Frozen #3: over the limit the *nearest* ancestors survive."""
    # window 8_000 -> total 672, nested cap = min(4% * window, 4_000 tok) = 320 tokens.
    # Each 500-char file costs 250 tokens, so exactly one entry fits and it must be
    # the nearest ancestor: the frozen "超限保留最近祖先" rule.
    ledger = InjectionLedger.create(8_000)
    assert ledger.limits.caps["nested"] == 320
    entries = [
        NestedEntry("a/AGENTS.md", "far " * 100),
        NestedEntry("a/b/AGENTS.md", "near " * 100),
    ]
    injected = charge_nested_for_touch(ledger, entries)
    assert injected.paths == ("a/b/AGENTS.md",)
    assert injected.denied == ("a/AGENTS.md",)


def test_nested_truncates_single_file_and_dedupes_per_run():
    ledger = InjectionLedger.create(128_000)
    huge = "x" * (NESTED_CHARS_PER_FILE * 3)
    first = charge_nested_for_touch(ledger, [NestedEntry("pkg/AGENTS.md", huge)])
    assert first.truncated
    assert first.entries[0][1].endswith(TRUNCATION_MARKER)
    assert len(first.entries[0][1]) <= NESTED_CHARS_PER_FILE + len(TRUNCATION_MARKER)

    # per-message dedupe: a second touch of the same chain injects nothing new
    second = charge_nested_for_touch(ledger, [NestedEntry("pkg/AGENTS.md", huge)])
    assert second.entries == ()
    assert ledger.by_source["nested"] > 0


def test_nested_stops_at_run_char_budget():
    ledger = InjectionLedger.create(0)  # unknown window -> nested cap 4_000 tokens
    entries = [
        NestedEntry(f"d{index}/AGENTS.md", "y" * (NESTED_CHARS_PER_FILE - 10))
        for index in range(8)
    ]
    injected = charge_nested_for_touch(ledger, entries)
    assert injected.truncated
    assert len(injected.entries) < len(entries)
    assert ledger.by_source["nested"] <= ledger.limits.caps["nested"]


def test_conservative_counter_is_pessimistic():
    assert conservative_token_count("") == 0
    assert conservative_token_count("abcd") == 2
    assert conservative_token_count("a") == 1
