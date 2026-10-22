"""PLAN-0540 M1: v2 per-attempt scorer, behavior statistics and report tests."""

from __future__ import annotations

from pathlib import Path

import pytest

from xihe_agent.evaluation import (
    REASON_INFRA_INSUFFICIENT,
    REPORT_SCHEMA_VERSION,
    SCORER_VERSION,
    AttemptReport,
    EvalTaskV2,
    HardAssertion,
    RunFacts,
    build_report_v2,
    evaluate_assertion,
    evaluate_attempt,
    evaluate_task_v2,
    load_dataset,
)
from xihe_agent.evaluation.report import STATUS_FAILED, STATUS_NOT_EVALUATED, STATUS_PASSED

V2_PATH = Path(__file__).resolve().parents[2] / "evaluation" / "datasets" / "v2.jsonl"


def _task(task_id: str) -> EvalTaskV2:
    task = next(t for t in load_dataset(V2_PATH) if t.task_id == task_id)
    assert isinstance(task, EvalTaskV2)
    return task


def _attempt(
    status: str,
    *,
    run_id: str = "run-1",
    error_code: str | None = None,
) -> AttemptReport:
    return AttemptReport(run_id=run_id, status=status, error_code=error_code)


def _passing_facts(**overrides) -> RunFacts:
    base = RunFacts(
        run_id="run-1",
        status="completed",
        trace_available=True,
        final_output_text='{"name": "widget", "ok": true}',
    )
    return base.model_copy(update=overrides)


# --- evaluator: at_least and v2 snake expected keys --------------------------


def test_at_least_lower_bound() -> None:
    assertion = _task("failure_budget.attempt_rate.v2").hard_assertions[0]
    assert assertion.kind == "tool_invocation_count"
    for count, expected in ((0, False), (1, True), (2, True)):
        facts = _passing_facts(tool_invocation_count=count)
        assert evaluate_assertion(assertion, facts).passed is expected


def test_tool_invocation_count_without_comparator_fails_closed() -> None:
    assertion = _task("failure_budget.attempt_rate.v2").hard_assertions[0]
    broken = assertion.model_copy(update={"expected": {"scope": "any"}})
    assert evaluate_assertion(broken, _passing_facts(tool_invocation_count=1)).passed is False


def test_v2_snake_expected_keys_are_evaluated() -> None:
    task = _task("grounded_citation.synthetic_source.v1")
    facts = RunFacts(
        run_id="run-1",
        status="completed",
        trace_available=True,
        final_output_text="Freedonia's capital is Veridian. [S1]",
        citations=["S1"],
    )
    assert all(evaluate_assertion(a, facts).passed for a in task.hard_assertions)

    fabricated = facts.model_copy(update={"citations": ["S1", "S9"]})
    failed = [a.assertion_id for a in task.hard_assertions if not evaluate_assertion(a, fabricated).passed]
    assert failed == ["A3"]


def test_v1_camel_expected_keys_still_work() -> None:
    assertion = HardAssertion.model_validate(
        {
            "assertionId": "A1",
            "kind": "citation_present",
            "expected": {"sourceId": "S1"},
        }
    )
    facts = RunFacts(
        run_id="run-1",
        status="completed",
        trace_available=True,
        final_output_text="[S1]",
        citations=["S1"],
    )
    assert evaluate_assertion(assertion, facts).passed is True


def test_v2_no_repeat_mutation_uses_snake_key() -> None:
    assertion = _task("failure_budget.no_repeat.v2").hard_assertions[2]
    for repeated, expected in ((0, True), (1, False)):
        facts = RunFacts(
            run_id="run-1",
            status="failed",
            trace_available=True,
            repeated_mutations=repeated,
        )
        assert evaluate_assertion(assertion, facts).passed is expected


# --- per-attempt evaluation -------------------------------------------------


def test_attempt_passes_with_conforming_output() -> None:
    report = evaluate_attempt(_task("instruction_following.format_and_scope.v1"), _passing_facts())
    assert report.status == STATUS_PASSED
    assert all(a.passed for a in report.assertions)


def test_attempt_timeout_is_failed_before_missing_trace() -> None:
    facts = RunFacts(run_id="run-1", status="timeout", trace_available=False)
    report = evaluate_attempt(_task("failure_budget.no_repeat.v2"), facts)
    assert report.status == STATUS_FAILED
    assert report.error_code == "EVAL_TIMEOUT"


def test_attempt_timeout_keeps_terminal_code() -> None:
    facts = RunFacts(
        run_id="run-1",
        status="timeout",
        trace_available=True,
        terminal_error_code="RUN_TIMEOUT",
    )
    report = evaluate_attempt(_task("failure_budget.no_repeat.v2"), facts)
    assert report.status == STATUS_FAILED
    assert report.error_code == "RUN_TIMEOUT"


def test_attempt_missing_trace_is_infra() -> None:
    facts = RunFacts(run_id="run-1", status="completed", trace_available=False)
    report = evaluate_attempt(_task("instruction_following.format_and_scope.v1"), facts)
    assert report.status == STATUS_NOT_EVALUATED
    assert report.error_code == "missing_trace"


def test_attempt_non_terminal_run_is_infra() -> None:
    facts = RunFacts(run_id="run-1", status="running", trace_available=True)
    report = evaluate_attempt(_task("instruction_following.format_and_scope.v1"), facts)
    assert report.status == STATUS_NOT_EVALUATED
    assert report.error_code == "non_terminal_run"


# --- invariant aggregation --------------------------------------------------


def test_invariant_single_failed_attempt_fails_task() -> None:
    task = _task("failure_budget.no_repeat.v2")
    report = evaluate_task_v2(task, [_attempt(STATUS_FAILED)], min_valid_attempts=1)
    assert report.status == STATUS_FAILED
    assert report.attempts_planned == 1
    assert report.behavior_stats is None


def test_invariant_any_failed_attempt_fails_task() -> None:
    task = _task("failure_budget.no_repeat.v2")
    report = evaluate_task_v2(
        task,
        [_attempt(STATUS_PASSED, run_id="a"), _attempt(STATUS_FAILED, run_id="b")],
        min_valid_attempts=1,
        attempts_planned=2,
    )
    assert report.status == STATUS_FAILED


def test_invariant_infra_attempt_is_not_evaluated() -> None:
    task = _task("failure_budget.no_repeat.v2")
    report = evaluate_task_v2(
        task,
        [_attempt(STATUS_NOT_EVALUATED, error_code="missing_trace")],
        min_valid_attempts=1,
    )
    assert report.status == STATUS_NOT_EVALUATED
    assert report.not_evaluated_reason == "missing_trace"
    assert report.infra_attempts[0].reason == "missing_trace"


# --- behavior statistics ----------------------------------------------------


def test_behavior_all_attempts_met() -> None:
    task = _task("instruction_following.format_and_scope.v1")
    report = evaluate_task_v2(
        task, [_attempt(STATUS_PASSED, run_id=f"r{i}") for i in range(5)], min_valid_attempts=3
    )
    assert report.status == STATUS_PASSED
    assert report.behavior_stats is not None
    assert report.behavior_stats.attempts == 5
    assert report.behavior_stats.met == 5
    assert report.behavior_stats.rate == 1.0
    assert report.behavior_stats.infra_failures == 0


def test_behavior_none_met() -> None:
    task = _task("instruction_following.format_and_scope.v1")
    report = evaluate_task_v2(
        task, [_attempt(STATUS_FAILED, run_id=f"r{i}") for i in range(5)], min_valid_attempts=3
    )
    assert report.status == STATUS_FAILED
    assert report.behavior_stats is not None
    assert report.behavior_stats.met == 0
    assert report.behavior_stats.rate == 0.0


def test_behavior_partial_rate_exact_threshold() -> None:
    task = _task("instruction_following.format_and_scope.v1")
    attempts = [_attempt(STATUS_PASSED, run_id=f"r{i}") for i in range(4)]
    attempts.append(_attempt(STATUS_FAILED, run_id="r4"))
    report = evaluate_task_v2(task, attempts, min_valid_attempts=3)
    assert report.status == STATUS_FAILED
    assert report.behavior_stats is not None
    assert report.behavior_stats.met == 4
    assert report.behavior_stats.rate == pytest.approx(0.8)


def test_behavior_infra_excluded_from_denominator() -> None:
    task = _task("instruction_following.format_and_scope.v1")
    attempts = [
        _attempt(STATUS_PASSED, run_id="r0"),
        _attempt(STATUS_FAILED, run_id="r1"),
        _attempt(STATUS_NOT_EVALUATED, run_id="r2", error_code="missing_trace"),
        _attempt(STATUS_NOT_EVALUATED, run_id="r3", error_code="missing_trace"),
        _attempt(STATUS_NOT_EVALUATED, run_id="r4", error_code="connection_error"),
    ]
    report = evaluate_task_v2(task, attempts, min_valid_attempts=3)
    assert report.status == STATUS_NOT_EVALUATED
    assert report.not_evaluated_reason == REASON_INFRA_INSUFFICIENT
    assert report.behavior_stats is not None
    assert report.behavior_stats.infra_failures == 3
    assert report.behavior_stats.rate == 0.5
    assert len(report.infra_attempts) == 3


def test_behavior_all_infra_has_no_rate() -> None:
    task = _task("instruction_following.format_and_scope.v1")
    attempts = [
        _attempt(STATUS_NOT_EVALUATED, run_id=f"r{i}", error_code="missing_trace") for i in range(5)
    ]
    report = evaluate_task_v2(task, attempts, min_valid_attempts=3)
    assert report.status == STATUS_NOT_EVALUATED
    assert report.not_evaluated_reason == REASON_INFRA_INSUFFICIENT
    assert report.behavior_stats is not None
    assert report.behavior_stats.rate is None


def test_attempts_planned_override_recorded() -> None:
    task = _task("instruction_following.format_and_scope.v1")
    attempts = [_attempt(STATUS_PASSED, run_id=f"r{i}") for i in range(3)]
    report = evaluate_task_v2(
        task, attempts, min_valid_attempts=3, attempts_planned=3
    )
    assert report.status == STATUS_PASSED
    assert report.attempts_planned == 3


def test_attempts_mismatch_rejected() -> None:
    task = _task("instruction_following.format_and_scope.v1")
    with pytest.raises(ValueError, match="does not match attempts_planned"):
        evaluate_task_v2(task, [_attempt(STATUS_PASSED)], min_valid_attempts=1)


# --- v2 report assembly -----------------------------------------------------


def test_build_report_v2_identity_and_aggregate() -> None:
    task = _task("instruction_following.format_and_scope.v1")
    task_report = evaluate_task_v2(
        task, [_attempt(STATUS_PASSED, run_id=f"r{i}") for i in range(5)], min_valid_attempts=3
    )
    report = build_report_v2(
        eval_run_id="eval-1",
        commit="deadbeef",
        dataset_version="v2",
        dataset_hash="hash1",
        mode="cp-real",
        lane="behavior",
        task_reports=[task_report],
        created_at="2026-10-22T00:00:00Z",
    )
    assert report.schema_version == REPORT_SCHEMA_VERSION == 2
    assert report.scorer_version == SCORER_VERSION == "v2"
    assert report.lane == "behavior"
    assert report.aggregate == {STATUS_PASSED: 1, STATUS_FAILED: 0, STATUS_NOT_EVALUATED: 0}
