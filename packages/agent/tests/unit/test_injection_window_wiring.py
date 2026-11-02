"""PLAN-0627 M2-1: wire the injection-budget denominator (D27-21).

Before this wiring the run metadata carried no ``windowTokens``, so
``context/injection_budget.py`` degraded to the absolute pool (4_000 tokens) and the
user-ruled "absolute cap clamped by a window percentage" never engaged in a real run.

Two pins, deliberately different in kind:

* ``test_chat_carries_window_tokens_into_run_metadata`` — **structural**: the chat
  endpoint's run-metadata block must set ``windowTokens`` from the same resolver the
  ``usage`` event uses (``_model_window_tokens``), so the injection ledger and the CP
  compaction gate read one number. The metadata write happens inside a closure of the
  request handler, so a runtime test would require the whole route (CP config snapshot,
  MCP discovery, provider lease); this pin keeps the wiring honest without faking that.
* ``test_ledger_scales_caps_from_window_tokens`` / ``..._without_window_tokens`` —
  **behavioural**: the "before vs after" contrast (absolute 4_000 pool vs
  128k-window proportional caps) that verify must be able to distinguish.
"""

from pathlib import Path

from xihe_agent.context.injection_budget import InjectionLedger
from xihe_agent.context.nested_injection import ledger_for_context
from xihe_agent.interfaces.context import AgentContext

CHAT_MODULE = Path(__file__).resolve().parents[2] / "src" / "xihe_agent" / "api" / "chat.py"


def test_chat_carries_window_tokens_into_run_metadata():
    source = CHAT_MODULE.read_text(encoding="utf-8")
    anchor = '"branchId": context.branch_id,'
    assert anchor in source, "run-metadata block changed shape; update this pin intentionally"
    window = source[source.index(anchor) : source.index(anchor) + 600]
    assert '"windowTokens"' in window, (
        "the run metadata must carry windowTokens (PLAN-0627 D27-21 denominator); "
        "without it the injection ledger silently falls back to the absolute pool"
    )
    assert "_model_window_tokens(" in window, (
        "windowTokens must come from _model_window_tokens(...) — the same resolver the usage "
        "event uses — not from a second calculation"
    )


def test_ledger_scales_caps_from_window_tokens():
    """window=128k must produce the proportional caps (the 'after' state)."""
    context = AgentContext.empty("session-window")
    context.metadata["windowTokens"] = 128_000
    ledger = ledger_for_context(context)

    assert ledger.limits.window_tokens == 128_000
    assert ledger.limits.total == 10_240  # min(0.15 * 0.70*128k, 0.08 * 128k)
    assert ledger.limits.caps == {"skills": 1_280, "memory": 5_120, "nested": 4_000}
    assert ledger.limits.floors == {"skills": 512, "memory": 2_560, "nested": 0}


def test_ledger_without_window_tokens_falls_back_to_the_absolute_pool():
    """No window fact = the pre-wiring behaviour (the 'before' state)."""
    context = AgentContext.empty("session-no-window")
    ledger = ledger_for_context(context)

    assert ledger.limits.window_tokens == 0
    assert ledger.limits.total == 4_000
    assert ledger.limits.caps == {"skills": 2_000, "memory": 4_000, "nested": 4_000}


def test_ledger_reuses_the_same_instance_across_the_run():
    context = AgentContext.empty("session-reuse")
    context.metadata["windowTokens"] = 128_000
    first = ledger_for_context(context)
    first.try_charge("skills", "alpha", 512, priority=True)
    second = ledger_for_context(context)
    assert second is first
    assert second.by_source["skills"] == 512


def test_fallback_ledger_still_enforces_invariants():
    """The absolute-pool fallback is a legal configuration, not a disabled budget."""
    ledger = InjectionLedger.create(0, 0)
    assert ledger.try_charge("nested", "src/AGENTS.md", 4_001) is False
    assert ledger.try_charge("nested", "src/AGENTS.md", 3_000) is True
    assert ledger.used() <= ledger.limits.total
