"""PLAN-0493 T1.4 (L0): loop/progress detection unit tests.

Six frozen assertions (tasks T1.4) plus window/signature contract checks:
1. same action with a swapped volatile key hits (signature insensitivity);
2. zero-progress loop (idempotent same signature + same result) hits;
3. an authorized/approved silent retry does NOT hit (boundary reset);
4. an exempt (poll/probe) tool never hits;
5. different arguments / different tool never hits;
6. a tier-1 refusal never terminates the Run (module keeps accepting).

Thresholds are constructed explicitly — no reliance on defaults.
"""

from __future__ import annotations

import hashlib

from xihe_agent.context.loop_detection import (
    BUILTIN_EXEMPT_TOOLS,
    IDEMPOTENT_TOOLS,
    LoopObservationWindow,
    LoopThresholds,
    canonicalize_args,
    compute_signature,
)

SMALL = LoopThresholds(
    repeat_warn=2,
    repeat_refuse=3,
    repeat_escalate=5,
    error_warn=3,
    error_escalate=5,
    stale_warn=2,
    stale_escalate=5,
    window=20,
)


def _run_attempt(window: LoopObservationWindow, tool: str, args: dict, **result_kw):
    """Full attempt cycle: pre_check then record_result (the frozen contract)."""
    verdict = window.pre_check(tool, args)
    if verdict.level == "refuse":
        window.record_result(
            tool, args, ok=True, result_text=result_kw.get("refusal", "refused")
        )
        return verdict
    recorded = window.record_result(tool, args, **result_kw)
    return verdict if verdict.level != "ok" else recorded


# T1.4 assertion ① — 换键相同动作（易变字段不同）→ 命中。
def test_same_action_with_swapped_volatile_key_hits():
    window = LoopObservationWindow(SMALL)
    base = {"path": "notes.md", "requestId": "r-1"}

    first = window.pre_check("read_file", base)
    second = window.pre_check("read_file", {**base, "requestId": "r-2"})
    third = window.pre_check("read_file", {**base, "requestId": "r-3", "toolCallId": "tc-9"})

    assert (first.level, second.level, third.level) == ("ok", "warn", "refuse")
    assert compute_signature("read_file", base) == compute_signature(
        "read_file", {"path": "notes.md", "requestId": "totally-different"}
    )
    assert third.message  # tier-1 carries model-facing text


# T1.4 assertion ② — 零进展循环（幂等同签名同结果）→ 命中到升级。
# 使用非豁免的幂等工具（glob）：豁免清单优先，第二信号只对幂等∩非豁免生效。
def test_zero_progress_loop_escalates():
    window = LoopObservationWindow(SMALL)
    args = {"pattern": "*.ts", "path": "src"}

    v1 = window.record_result("glob", args, ok=True, result_text='{"files":[]}')
    v2 = window.record_result("glob", args, ok=True, result_text='{"files":[]}')
    v5 = None
    for _ in range(3):
        v5 = window.record_result("glob", args, ok=True, result_text='{"files":[]}')

    assert (v1.level, v1.signal) == ("ok", "none")
    assert (v2.level, v2.signal) == ("warn", "stale")
    assert v5 is not None and (v5.level, v5.signal) == ("escalate", "stale")


# T1.4 assertion ③ — 经授权/审批的静默重试（边界后重试）→ 不命中。
def test_approved_silent_retry_after_boundary_not_hit():
    window = LoopObservationWindow(SMALL)
    args = {"path": "src/app.py"}

    window.pre_check("read_file", args)
    window.record_result("read_file", args, ok=True, result_text="v1")
    assert window.pre_check("read_file", args).level == "warn"
    window.record_result("read_file", args, ok=True, result_text="v2")

    window.mark_boundary("approval")

    after = window.pre_check("read_file", args)
    assert after.level == "ok"
    assert after.repeat_streak == 1
    # window history is retained across the boundary
    assert len(window) == 2


# T1.4 assertion ④ — 排除表内工具（轮询/探活）→ 不命中。
def test_exempt_poll_tool_never_hits():
    window = LoopObservationWindow(SMALL)
    args = {"jobId": "job-1"}

    for _ in range(12):
        verdict = window.pre_check("get_background_process", args)
        recorded = window.record_result(
            "get_background_process", args, ok=True, result_text="running"
        )
        assert verdict.level == "ok"
        assert recorded.level == "ok"

    # backend-prefixed discovery name is matched too
    prefixed = window.pre_check("runtime__get_background_process", {"jobId": "job-1"})
    window.record_result(
        "runtime__get_background_process", {"jobId": "job-1"}, ok=True, result_text="running"
    )
    assert prefixed.level == "ok"

    # exempt failures are also never judged
    failed = window.record_result(
        "watch_directory", {"path": "."}, ok=False, error_key="Timeout"
    )
    assert failed.level == "ok"
    assert len(window) == 14
    assert set(BUILTIN_EXEMPT_TOOLS) <= {
        "get_background_process",
        "list_background_processes",
        "read_command_output",
        "watch_directory",
        "get_file_info",
    }


# T1.4 assertion ⑤ — 不同参数 / 不同工具 → 不命中。
def test_different_args_or_tool_never_hits():
    window = LoopObservationWindow(SMALL)
    payloads = [
        ("read_file", {"path": "a.md"}),
        ("read_file", {"path": "b.md"}),
        ("grep", {"pattern": "foo"}),
        ("read_file_range", {"path": "a.md", "start": 0}),
    ]
    for i in range(10):
        tool, args = payloads[i % len(payloads)]
        verdict = window.pre_check(tool, args)
        window.record_result(tool, args, ok=True, result_text=f"out-{i}")
        assert verdict.level == "ok"

    # failures of a different class reset the consecutive-failure streak
    for _ in range(2):
        window.record_result("write_file", {"path": "x"}, ok=False, error_key="EACCES")
    other = window.record_result("write_file", {"path": "x"}, ok=False, error_key="Timeout")
    assert other.level == "ok"


# T1.4 assertion ⑥ — tier-1 拒绝后 Run 未终止（模块继续接受观测）。
def test_tier1_refuse_does_not_terminate_run():
    window = LoopObservationWindow(SMALL)
    args = {"path": "loop.md"}

    refuse = None
    for _ in range(3):
        verdict = _run_attempt(window, "read_file", args)
        if verdict.level == "refuse":
            refuse = verdict
    assert refuse is not None and refuse.level == "refuse"

    # after the refusal the window keeps accepting work and the escalate
    # ladder continues (Run never receives a terminal signal from tier-1)
    escalate = None
    for _ in range(2):
        escalate = _run_attempt(window, "read_file", args)
    assert escalate is not None and escalate.level == "escalate"
    assert escalate.signal == "repeat"
    assert len(window) == 5
    # only the four frozen levels exist — no stop/terminate verdict possible
    assert refuse.level in {"ok", "warn", "refuse", "escalate"}


# error-streak ladder: warn @3, escalate @5, success resets.
def test_error_streak_ladder_and_reset():
    window = LoopObservationWindow(SMALL)
    args = {"path": "missing.txt"}

    for _ in range(2):
        assert window.record_result("read_file", args, ok=False, error_key="NotFound").level == "ok"
    warn = window.record_result("read_file", args, ok=False, error_key="NotFound")
    assert (warn.level, warn.signal, warn.error_streak) == ("warn", "error", 3)

    assert window.record_result("read_file", args, ok=True, result_text="found").level == "ok"
    for _ in range(4):
        window.record_result("read_file", args, ok=False, error_key="NotFound")
    escalate = window.record_result("read_file", args, ok=False, error_key="NotFound")
    assert (escalate.level, escalate.signal) == ("escalate", "error")


# bounded window eviction (verify V8: 有界淘汰最旧).
def test_window_is_bounded_and_evicts_oldest():
    window = LoopObservationWindow(LoopThresholds(window=3))
    for i in range(10):
        tool, args = "read_file", {"path": f"f{i}.md"}
        window.pre_check(tool, args)
        window.record_result(tool, args, ok=True, result_text=str(i))

    assert len(window) == 3
    recent = window.recent()
    assert [r.result_hash for r in recent] == [
        hashlib.sha256(str(i).encode()).hexdigest() for i in (7, 8, 9)
    ]


# signature contract (T1.1): key order irrelevant, keys casefolded,
# values trimmed but case-preserved, empty args normalized.
def test_signature_normalization_contract():
    assert compute_signature("t", {"B": 1, "a": " x "}) == compute_signature(
        "t", {"a": "x", "b": 1}
    )
    assert compute_signature("t", {"a": "X"}) != compute_signature("t", {"a": "x"})
    assert canonicalize_args(None) == "{}"
    assert canonicalize_args({}) == "{}"
    assert canonicalize_args("") == "{}"
    assert compute_signature("t", None) == compute_signature("t", {})
    assert compute_signature("t", {"a": None}) == compute_signature("t", {})
    # unparseable string input stays deterministic (trimmed)
    assert compute_signature("t", " raw ") == compute_signature("t", "raw")
    # tool name participates in the digest
    assert compute_signature("t1", {}) != compute_signature("t2", {})


# default table matches the frozen design values (2/3/5, 3/5, 2/5, 20).
def test_default_thresholds_match_design_table():
    defaults = LoopThresholds()
    assert (
        defaults.repeat_warn,
        defaults.repeat_refuse,
        defaults.repeat_escalate,
        defaults.error_warn,
        defaults.error_escalate,
        defaults.stale_warn,
        defaults.stale_escalate,
        defaults.window,
    ) == (2, 3, 5, 3, 5, 2, 5, 20)
    assert set(BUILTIN_EXEMPT_TOOLS) <= IDEMPOTENT_TOOLS
