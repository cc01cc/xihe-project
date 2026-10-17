"""PLAN-0511 M2: deterministic evaluator and report/compare tests (offline)."""

from __future__ import annotations

import pytest

from xihe_agent.evaluation import (
    BudgetDimension,
    RunFacts,
    compare_reports,
    evaluate_task,
    load_dataset,
    summarize,
)
from xihe_agent.evaluation.report import (
    STATUS_FAILED,
    STATUS_NOT_EVALUATED,
    STATUS_PASSED,
    build_report,
)


def _task(task_id: str):
    return next(t for t in load_dataset() if t.task_id == task_id)


# --- per-kind evaluators against the frozen tasks ---------------------------


def test_instruction_following_passes_on_conforming_output() -> None:
    facts = RunFacts(
        run_id="r1",
        status="completed",
        trace_available=True,
        tool_invocation_count=0,
        final_output_text='{"name": "widget", "ok": true}',
    )
    report = evaluate_task(_task("instruction_following.format_and_scope.v1"), facts)
    assert report.status == STATUS_PASSED
    assert all(a.passed for a in report.assertions)


def test_instruction_following_fails_on_extra_field_and_tool_use() -> None:
    facts = RunFacts(
        run_id="r2",
        status="completed",
        trace_available=True,
        tool_invocation_count=1,
        final_output_text='{"name": "widget", "ok": true, "extra": 1}',
    )
    report = evaluate_task(_task("instruction_following.format_and_scope.v1"), facts)
    assert report.status == STATUS_FAILED
    failed = {a.assertion_id for a in report.assertions if not a.passed}
    assert failed == {"A2", "A3"}


def test_grounded_citation_passes_and_detects_fabrication() -> None:
    good = RunFacts(
        run_id="r3",
        status="completed",
        trace_available=True,
        final_output_text="Freedonia's capital is Veridian.",
        citations=["S1"],
    )
    assert evaluate_task(_task("grounded_citation.synthetic_source.v1"), good).status == STATUS_PASSED

    bad = good.model_copy(update={"citations": ["S1", "S9"]})
    report = evaluate_task(_task("grounded_citation.synthetic_source.v1"), bad)
    assert report.status == STATUS_FAILED
    assert {a.assertion_id for a in report.assertions if not a.passed} == {"A3"}


def test_denied_mutation_requires_zero_invocation_and_refusal() -> None:
    facts = RunFacts(
        run_id="r4",
        status="completed",
        trace_available=True,
        tool_invocation_count=0,
        refusal_code="denied",
    )
    assert evaluate_task(_task("tool_authorization.denied_mutation.v1"), facts).status == STATUS_PASSED

    executed = facts.model_copy(update={"tool_invocation_count": 1, "refusal_code": None})
    assert evaluate_task(_task("tool_authorization.denied_mutation.v1"), executed).status == STATUS_FAILED


def test_failure_budget_requires_real_error_code_and_budget() -> None:
    facts = RunFacts(
        run_id="r5",
        status="failed",
        trace_available=True,
        terminal_error_code="RUN_BUDGET_EXHAUSTED",
        repeated_mutations=0,
        budget={
            "turns": BudgetDimension(limit=5, used=5),
            "elapsed": BudgetDimension(limit=60, used=42),
            "tokens": BudgetDimension(limit=40000, used=39000),
        },
    )
    assert evaluate_task(_task("failure_budget.no_repeat.v1"), facts).status == STATUS_PASSED

    wrong = facts.model_copy(update={"terminal_error_code": "SOME_OTHER_CODE"})
    assert evaluate_task(_task("failure_budget.no_repeat.v1"), wrong).status == STATUS_FAILED


# --- failing closed ----------------------------------------------------------


def test_missing_trace_is_not_evaluated() -> None:
    facts = RunFacts(run_id="r6", status="completed", trace_available=False)
    report = evaluate_task(_task("instruction_following.format_and_scope.v1"), facts)
    assert report.status == STATUS_NOT_EVALUATED
    assert report.not_evaluated_reason == "missing_trace"


def test_non_terminal_run_is_not_evaluated() -> None:
    facts = RunFacts(run_id="r7", status="running", trace_available=True)
    report = evaluate_task(_task("instruction_following.format_and_scope.v1"), facts)
    assert report.status == STATUS_NOT_EVALUATED
    assert report.not_evaluated_reason is not None


# --- report + compare --------------------------------------------------------


def _report(eval_run_id: str, facts: RunFacts):
    task = _task("instruction_following.format_and_scope.v1")
    task_report = evaluate_task(task, facts)
    return build_report(
        eval_run_id=eval_run_id,
        commit="deadbeef",
        dataset_version="v1",
        dataset_hash="hash1",
        mode="cp-real",
        task_reports=[task_report],
        created_at="2026-10-17T00:00:00Z",
    )


def test_summarize_counts() -> None:
    good = _report("e1", RunFacts(run_id="r", status="completed", trace_available=True,
                                  final_output_text='{"name":"a","ok":true}'))
    assert good.aggregate == {STATUS_PASSED: 1, STATUS_FAILED: 0, STATUS_NOT_EVALUATED: 0}
    assert summarize(good.tasks)[STATUS_PASSED] == 1


def test_compare_reports_detects_regression() -> None:
    base = _report("e1", RunFacts(run_id="r", status="completed", trace_available=True,
                                  final_output_text='{"name":"a","ok":true}'))
    cand = _report("e2", RunFacts(run_id="r", status="completed", trace_available=True,
                                  final_output_text='{"name":"a","ok":true,"x":1}'))
    diff = compare_reports(base, cand)
    assert diff.aggregate_delta[STATUS_PASSED] == -1
    assert diff.tasks[0].changed_assertions == ["A2"]


def test_compare_reports_rejects_mismatched_dataset() -> None:
    base = _report("e1", RunFacts(run_id="r", status="completed", trace_available=True,
                                  final_output_text='{"name":"a","ok":true}'))
    other = base.model_copy(update={"dataset_hash": "hash2"})
    with pytest.raises(ValueError, match="dataset hash mismatch"):
        compare_reports(base, other)
