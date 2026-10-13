"""PLAN-0492 T2.1 (L0): effective run budget resolution and ceiling clamps.

Four frozen states:
1. nothing configured -> code defaults (25 / 600 / 0);
2. value above a positive ceiling -> clamped to the ceiling;
3. ceiling 0 -> no clamp (value unchanged);
4. run overrides win over the pulled effective config, and the clamp still
   applies to the resolved value (user cannot exceed the hard ceiling).
"""

import xihe_agent.app_state as app_state
from xihe_agent.app_state import _resolve_run_budget


def test_run_budget_defaults_when_nothing_configured(monkeypatch):
    monkeypatch.setattr(app_state.config_client, "_effective_cache", {})

    budget = _resolve_run_budget({}, {})

    # Token defaults calibrated 2026-10-13 from real-provider runs
    # (p95=25535 over 15 runs; PLAN-0492 evidence/m0-token-calibration.md).
    assert (budget.max_turns, budget.max_elapsed_seconds, budget.max_tokens) == (25, 600, 38303)


def test_run_budget_positive_ceiling_clamps_value(monkeypatch):
    monkeypatch.setattr(
        app_state.config_client,
        "_effective_cache",
        {
            "agent-runtime": {
                "runMaxTurns": "80",
                "runMaxElapsedSeconds": "7200",
                "runMaxTokens": "0",
                "runMaxTurnsCeiling": "100",
                "runMaxElapsedSecondsCeiling": "3600",
                "runMaxTokensCeiling": "0",
            }
        },
    )

    budget = _resolve_run_budget({}, {})

    assert budget.max_turns == 80
    assert budget.max_elapsed_seconds == 3600
    assert budget.max_tokens == 0

    monkeypatch.setattr(
        app_state.config_client,
        "_effective_cache",
        {
            "agent-runtime": {
                "runMaxTurns": "500",
                "runMaxTurnsCeiling": "100",
            }
        },
    )
    clamped = _resolve_run_budget({}, {})
    assert clamped.max_turns == 100


def test_run_budget_zero_ceiling_means_no_clamp(monkeypatch):
    monkeypatch.setattr(
        app_state.config_client,
        "_effective_cache",
        {
            "agent-runtime": {
                "runMaxTurns": "500",
                "runMaxElapsedSeconds": "99999",
                "runMaxTurnsCeiling": "0",
                "runMaxElapsedSecondsCeiling": "0",
            }
        },
    )

    budget = _resolve_run_budget({}, {})

    assert budget.max_turns == 500
    assert budget.max_elapsed_seconds == 99999


def test_run_budget_overrides_merge_and_still_clamp(monkeypatch):
    monkeypatch.setattr(
        app_state.config_client,
        "_effective_cache",
        {
            "agent-runtime": {
                "runMaxTurns": "25",
                "runMaxTurnsCeiling": "100",
            }
        },
    )

    budget = _resolve_run_budget({"agent-runtime": {"runMaxTurns": "60"}}, {})

    assert budget.max_turns == 60

    over_limit = _resolve_run_budget(
        {"agent-runtime": {"runMaxTurns": "250"}},
        {"agent-runtime": {"runMaxTurns": "300"}},
    )
    assert over_limit.max_turns == 100


def test_run_budget_invalid_values_fall_back_to_defaults(monkeypatch):
    monkeypatch.setattr(
        app_state.config_client,
        "_effective_cache",
        {
            "agent-runtime": {
                "runMaxTurns": "not-a-number",
                "runMaxElapsedSeconds": "-30",
            }
        },
    )

    budget = _resolve_run_budget({}, {})

    assert budget.max_turns == 25
    assert budget.max_elapsed_seconds == 600
