"""PLAN-0493 T2.2 (L0): effective loop-guard resolution and ceiling clamps.

Frozen states (mirroring PLAN-0492 T2.1):
1. nothing configured -> code defaults (2/3/5, 3/5, 2/5, window 20; exempt =
   builtin list only);
2. escalate/window values above a positive ceiling -> clamped to the ceiling;
3. ceiling 0 -> no clamp;
4. run overrides win, the clamp still applies, and ``loopExemptTools`` (JSON
   text array) appends to the builtin set — builtin items are irremovable,
   invalid values fall back to the builtin list.
"""

import xihe_agent.app_state as app_state
from xihe_agent.app_state import _resolve_loop_guard
from xihe_agent.context.loop_detection import BUILTIN_EXEMPT_TOOLS


def test_loop_guard_defaults_when_nothing_configured(monkeypatch):
    monkeypatch.setattr(app_state.config_client, "_effective_cache", {})

    thresholds, exempt = _resolve_loop_guard({}, {})

    # M0 calibrated 2026-10-13: all defaults kept
    # (PLAN-0493 evidence/m0-observed-repeats.md §2).
    assert (
        thresholds.repeat_warn,
        thresholds.repeat_refuse,
        thresholds.repeat_escalate,
        thresholds.error_warn,
        thresholds.error_escalate,
        thresholds.stale_warn,
        thresholds.stale_escalate,
        thresholds.window,
    ) == (2, 3, 5, 3, 5, 2, 5, 20)
    assert exempt == frozenset(BUILTIN_EXEMPT_TOOLS)


def test_loop_guard_positive_ceiling_clamps_escalate_and_window(monkeypatch):
    monkeypatch.setattr(
        app_state.config_client,
        "_effective_cache",
        {
            "agent-runtime": {
                "loopRepeatEscalate": "50",
                "loopWindowSize": "200",
                "loopRepeatEscalateCeiling": "10",
                "loopWindowSizeCeiling": "50",
            }
        },
    )

    thresholds, _ = _resolve_loop_guard({}, {})

    assert thresholds.repeat_escalate == 10
    assert thresholds.window == 50
    # tier-1 thresholds have no ceiling and stay untouched
    assert thresholds.repeat_warn == 2
    assert thresholds.repeat_refuse == 3


def test_loop_guard_zero_ceiling_means_no_clamp(monkeypatch):
    monkeypatch.setattr(
        app_state.config_client,
        "_effective_cache",
        {
            "agent-runtime": {
                "loopRepeatEscalate": "50",
                "loopWindowSize": "200",
                "loopRepeatEscalateCeiling": "0",
                "loopWindowSizeCeiling": "0",
            }
        },
    )

    thresholds, _ = _resolve_loop_guard({}, {})

    assert thresholds.repeat_escalate == 50
    assert thresholds.window == 200


def test_loop_guard_overrides_merge_and_still_clamp(monkeypatch):
    monkeypatch.setattr(
        app_state.config_client,
        "_effective_cache",
        {
            "agent-runtime": {
                "loopRepeatEscalate": "4",
                "loopRepeatEscalateCeiling": "10",
            }
        },
    )

    thresholds, _ = _resolve_loop_guard(
        {"agent-runtime": {"loopRepeatEscalate": "8", "loopRepeatWarn": "1"}},
        {"agent-runtime": {"loopRepeatEscalate": "99", "loopWindowSize": "30"}},
    )

    # workspace override wins, then the hard ceiling clamps it
    assert thresholds.repeat_escalate == 10
    assert thresholds.repeat_warn == 1
    assert thresholds.window == 30


def test_loop_guard_invalid_values_fall_back_to_defaults(monkeypatch):
    monkeypatch.setattr(
        app_state.config_client,
        "_effective_cache",
        {
            "agent-runtime": {
                "loopRepeatWarn": "abc",
                "loopRepeatRefuse": "0",
                "loopWindowSize": "-3",
            }
        },
    )

    thresholds, _ = _resolve_loop_guard({}, {})

    assert thresholds.repeat_warn == 2
    assert thresholds.repeat_refuse == 3
    assert thresholds.window == 20


def test_loop_exempt_tools_append_to_builtin_list(monkeypatch):
    monkeypatch.setattr(
        app_state.config_client,
        "_effective_cache",
        {
            "agent-runtime": {
                "loopExemptTools": '["my_poll_tool", "Custom.Probe"]',
            }
        },
    )

    _, exempt = _resolve_loop_guard({}, {})

    assert set(BUILTIN_EXEMPT_TOOLS) <= set(exempt)
    assert "my_poll_tool" in exempt
    assert "custom.probe" in exempt


def test_loop_exempt_tools_invalid_falls_back_to_builtin(monkeypatch):
    for raw in ('{"not": "a list"}', "not json at all", '["", " "]'):
        monkeypatch.setattr(
            app_state.config_client,
            "_effective_cache",
            {"agent-runtime": {"loopExemptTools": raw}},
        )
        _, exempt = _resolve_loop_guard({}, {})
        assert exempt == frozenset(BUILTIN_EXEMPT_TOOLS), raw
