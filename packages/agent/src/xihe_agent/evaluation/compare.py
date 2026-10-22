"""Baseline/candidate comparison for evaluation reports (PLAN-0511 M3)."""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field

from xihe_agent.evaluation.report import (
    STATUS_FAILED,
    STATUS_NOT_EVALUATED,
    STATUS_PASSED,
    EvalReport,
    EvalReportV2,
    TaskReport,
    TaskReportV2,
)

ReportLike = EvalReport | EvalReportV2


class TaskDelta(BaseModel):
    """Per-task difference between baseline and candidate reports."""

    model_config = ConfigDict(extra="forbid")

    task_id: str
    baseline_status: str
    candidate_status: str
    changed_assertions: list[str] = Field(default_factory=list)
    usage_delta: dict[str, float] = Field(default_factory=dict)
    duration_delta_ms: int | None = None


class ComparisonReport(BaseModel):
    """Comparability-checked diff between two evaluation reports."""

    model_config = ConfigDict(extra="forbid")

    dataset_hash: str
    scorer_version: str
    mode: str
    baseline_eval_run_id: str
    candidate_eval_run_id: str
    tasks: list[TaskDelta] = Field(default_factory=list)
    aggregate_delta: dict[str, int] = Field(default_factory=dict)


def _assert_comparable(baseline: ReportLike, candidate: ReportLike) -> None:
    if baseline.schema_version != candidate.schema_version:
        raise ValueError(
            f"report schema mismatch: {baseline.schema_version} != {candidate.schema_version}"
        )
    if baseline.dataset_hash != candidate.dataset_hash:
        raise ValueError(f"dataset hash mismatch: {baseline.dataset_hash} != {candidate.dataset_hash}")
    if baseline.dataset_version != candidate.dataset_version:
        raise ValueError(
            f"dataset version mismatch: {baseline.dataset_version} != {candidate.dataset_version}"
        )
    if baseline.scorer_version != candidate.scorer_version:
        raise ValueError(f"scorer version mismatch: {baseline.scorer_version} != {candidate.scorer_version}")
    if baseline.mode != candidate.mode:
        raise ValueError(f"mode mismatch: {baseline.mode} != {candidate.mode}")


def _find_task(report: ReportLike, task_id: str) -> TaskReport | TaskReportV2 | None:
    for task in report.tasks:
        if task.task_id == task_id:
            return task
    return None


def _assertion_status(report: ReportLike, task_id: str) -> dict[str, bool]:
    """Merge assertion outcomes across attempts; any failure marks the assertion failed."""
    task = _find_task(report, task_id)
    if task is None:
        return {}
    if isinstance(task, TaskReportV2):
        merged: dict[str, bool] = {}
        for attempt in task.attempts:
            for assertion in attempt.assertions:
                merged[assertion.assertion_id] = merged.get(assertion.assertion_id, True) and assertion.passed
        return merged
    return {a.assertion_id: a.passed for a in task.assertions}


def _usage_delta(baseline: ReportLike, candidate: ReportLike, task_id: str) -> dict[str, float]:
    def usage(report: ReportLike) -> dict[str, float]:
        task = _find_task(report, task_id)
        if task is None:
            return {}
        if isinstance(task, TaskReportV2):
            totals: dict[str, float] = {}
            for attempt in task.attempts:
                for key, value in attempt.usage.items():
                    totals[key] = totals.get(key, 0.0) + value
            return totals
        return task.usage

    base, cand = usage(baseline), usage(candidate)
    keys = set(base) | set(cand)
    return {k: round(cand.get(k, 0.0) - base.get(k, 0.0), 6) for k in sorted(keys)}


def _duration(report: ReportLike, task_id: str) -> int | None:
    task = _find_task(report, task_id)
    if task is None:
        return None
    if isinstance(task, TaskReportV2):
        values = [a.duration_ms for a in task.attempts if a.duration_ms is not None]
        return sum(values) if values else None
    return task.duration_ms


def compare_reports(baseline: ReportLike, candidate: ReportLike) -> ComparisonReport:
    """Diff two same-schema reports; raises ValueError when they are not comparable."""
    _assert_comparable(baseline, candidate)
    base_tasks = {t.task_id: t for t in baseline.tasks}
    cand_tasks = {t.task_id: t for t in candidate.tasks}
    deltas: list[TaskDelta] = []
    for task_id in sorted(set(base_tasks) | set(cand_tasks)):
        base = base_tasks.get(task_id)
        cand = cand_tasks.get(task_id)
        base_a = _assertion_status(baseline, task_id)
        cand_a = _assertion_status(candidate, task_id)
        changed = sorted(k for k in set(base_a) | set(cand_a) if base_a.get(k) != cand_a.get(k))
        base_dur, cand_dur = _duration(baseline, task_id), _duration(candidate, task_id)
        dur_delta = None
        if base_dur is not None and cand_dur is not None:
            dur_delta = cand_dur - base_dur
        deltas.append(
            TaskDelta(
                task_id=task_id,
                baseline_status=base.status if base else STATUS_NOT_EVALUATED,
                candidate_status=cand.status if cand else STATUS_NOT_EVALUATED,
                changed_assertions=changed,
                usage_delta=_usage_delta(baseline, candidate, task_id),
                duration_delta_ms=dur_delta,
            )
        )
    agg_delta = {
        STATUS_PASSED: candidate.aggregate.get(STATUS_PASSED, 0) - baseline.aggregate.get(STATUS_PASSED, 0),
        STATUS_FAILED: candidate.aggregate.get(STATUS_FAILED, 0) - baseline.aggregate.get(STATUS_FAILED, 0),
        STATUS_NOT_EVALUATED: (
            candidate.aggregate.get(STATUS_NOT_EVALUATED, 0) - baseline.aggregate.get(STATUS_NOT_EVALUATED, 0)
        ),
    }
    return ComparisonReport(
        dataset_hash=baseline.dataset_hash,
        scorer_version=baseline.scorer_version,
        mode=baseline.mode,
        baseline_eval_run_id=baseline.eval_run_id,
        candidate_eval_run_id=candidate.eval_run_id,
        tasks=deltas,
        aggregate_delta=agg_delta,
    )
