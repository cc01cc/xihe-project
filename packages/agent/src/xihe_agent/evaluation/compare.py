"""Baseline/candidate comparison for evaluation reports (PLAN-0511 M3)."""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field

from xihe_agent.evaluation.report import STATUS_FAILED, STATUS_NOT_EVALUATED, STATUS_PASSED, EvalReport


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


def _assert_comparable(baseline: EvalReport, candidate: EvalReport) -> None:
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


def _assertion_status(report: EvalReport, task_id: str) -> dict[str, bool]:
    for task in report.tasks:
        if task.task_id == task_id:
            return {a.assertion_id: a.passed for a in task.assertions}
    return {}


def _usage_delta(baseline: EvalReport, candidate: EvalReport, task_id: str) -> dict[str, float]:
    def usage(report: EvalReport) -> dict[str, float]:
        for task in report.tasks:
            if task.task_id == task_id:
                return task.usage
        return {}

    base, cand = usage(baseline), usage(candidate)
    keys = set(base) | set(cand)
    return {k: round(cand.get(k, 0.0) - base.get(k, 0.0), 6) for k in sorted(keys)}


def _duration(report: EvalReport, task_id: str) -> int | None:
    for task in report.tasks:
        if task.task_id == task_id:
            return task.duration_ms
    return None


def compare_reports(baseline: EvalReport, candidate: EvalReport) -> ComparisonReport:
    """Diff two reports; raises ValueError when they are not comparable."""
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
