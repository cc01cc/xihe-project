"""Machine-readable evaluation report models and assembly (PLAN-0511).

The report is content-free: it never carries raw prompt/response bodies, tool
arguments/results, credentials, or trace bodies. Raw output stays under the
git-ignored `.local/evaluation/<evalRunId>/raw/` directory owned by the runner.
"""

from __future__ import annotations

from datetime import UTC, datetime

from pydantic import BaseModel, ConfigDict, Field

from xihe_agent.evaluation.evaluator import AssertionResult, evaluate_assertion
from xihe_agent.evaluation.facts import RunFacts
from xihe_agent.evaluation.schema import EvalTask, EvalTaskV2

SCORER_VERSION_V1 = "v1"
SCORER_VERSION = "v2"
REPORT_SCHEMA_VERSION = 2
V1_REPORT_SCHEMA_VERSION = 1

STATUS_PASSED = "passed"
STATUS_FAILED = "failed"
STATUS_NOT_EVALUATED = "not_evaluated"

REASON_INFRA_INSUFFICIENT = "infra_insufficient"


class TaskReport(BaseModel):
    """Per-task evaluation outcome for a v1 report (content-free)."""

    model_config = ConfigDict(extra="forbid")

    task_id: str
    category: str
    status: str
    assertions: list[AssertionResult] = Field(default_factory=list)
    run_id: str | None = None
    trace_ref: str | None = None
    usage: dict[str, float] = Field(default_factory=dict)
    duration_ms: int | None = None
    error_code: str | None = None
    not_evaluated_reason: str | None = None


class EvalReport(BaseModel):
    """v1 evaluation report; frozen for reading historical reports."""

    model_config = ConfigDict(extra="forbid")

    schema_version: int = V1_REPORT_SCHEMA_VERSION
    eval_run_id: str
    created_at: str
    commit: str
    dataset_version: str
    dataset_hash: str
    scorer_version: str = SCORER_VERSION_V1
    mode: str
    provider: str | None = None
    model: str | None = None
    prompt_version: str | None = None
    tasks: list[TaskReport] = Field(default_factory=list)
    aggregate: dict[str, int] = Field(default_factory=dict)


class AttemptReport(BaseModel):
    """Outcome of one attempt; infra attempts carry a reason code in error_code."""

    model_config = ConfigDict(extra="forbid")

    run_id: str | None = None
    status: str
    error_code: str | None = None
    assertions: list[AssertionResult] = Field(default_factory=list)
    usage: dict[str, float] = Field(default_factory=dict)
    duration_ms: int | None = None


class InfraAttempt(BaseModel):
    """An attempt that could not be judged; excluded from the behavior rate."""

    model_config = ConfigDict(extra="forbid")

    run_id: str | None = None
    reason: str
    error_code: str | None = None


class BehaviorStats(BaseModel):
    """Fixed-N statistics for one behavior task."""

    model_config = ConfigDict(extra="forbid")

    attempts: int
    met: int
    rate: float | None
    infra_failures: int


class TaskReportV2(BaseModel):
    """Per-task evaluation outcome for a v2 report (content-free)."""

    model_config = ConfigDict(extra="forbid")

    task_id: str
    category: str
    assertion_class: str
    status: str
    attempts_planned: int
    attempts: list[AttemptReport] = Field(default_factory=list)
    infra_attempts: list[InfraAttempt] = Field(default_factory=list)
    behavior_stats: BehaviorStats | None = None
    not_evaluated_reason: str | None = None


class EvalReportV2(BaseModel):
    """v2 evaluation report for one lane, dataset and commit."""

    model_config = ConfigDict(extra="forbid")

    schema_version: int = REPORT_SCHEMA_VERSION
    eval_run_id: str
    created_at: str
    commit: str
    dataset_version: str
    dataset_hash: str
    scorer_version: str = SCORER_VERSION
    mode: str
    lane: str
    provider: str | None = None
    model: str | None = None
    prompt_version: str | None = None
    tasks: list[TaskReportV2] = Field(default_factory=list)
    aggregate: dict[str, int] = Field(default_factory=dict)


def evaluate_task(task: EvalTask | EvalTaskV2, facts: RunFacts) -> TaskReport:
    """Evaluate one task against observed facts, failing closed to not_evaluated."""
    base = TaskReport(
        task_id=task.task_id,
        category=task.category,
        status=STATUS_NOT_EVALUATED,
        run_id=facts.run_id,
        usage=dict(facts.usage),
        duration_ms=facts.duration_ms,
        error_code=facts.terminal_error_code,
    )
    if not facts.trace_available:
        base.not_evaluated_reason = "missing_trace"
        return base
    if facts.status == "timeout":
        # A run that never reaches a terminal state is a real failure signal,
        # not a missing observation (see review/round-15.md B1).
        base.status = STATUS_FAILED
        base.error_code = facts.terminal_error_code or "EVAL_TIMEOUT"
        return base
    if not facts.is_terminal():
        base.not_evaluated_reason = f"non_terminal_status:{facts.status}"
        return base
    base.trace_ref = f"chat_run:{facts.run_id}"
    results = [evaluate_assertion(a, facts) for a in task.hard_assertions]
    base.assertions = results
    base.status = STATUS_PASSED if all(r.passed for r in results) else STATUS_FAILED
    return base


def summarize(tasks: list[TaskReport] | list[TaskReportV2]) -> dict[str, int]:
    """Aggregate counts by status."""
    counts = {STATUS_PASSED: 0, STATUS_FAILED: 0, STATUS_NOT_EVALUATED: 0}
    for task in tasks:
        counts[task.status] = counts.get(task.status, 0) + 1
    return counts


def build_report(
    *,
    eval_run_id: str,
    commit: str,
    dataset_version: str,
    dataset_hash: str,
    mode: str,
    task_reports: list[TaskReport],
    provider: str | None = None,
    model: str | None = None,
    prompt_version: str | None = None,
    created_at: str | None = None,
) -> EvalReport:
    """Assemble a v1 report, computing the aggregate from task statuses."""
    return EvalReport(
        eval_run_id=eval_run_id,
        created_at=created_at or datetime.now(UTC).isoformat(),
        commit=commit,
        dataset_version=dataset_version,
        dataset_hash=dataset_hash,
        mode=mode,
        provider=provider,
        model=model,
        prompt_version=prompt_version,
        tasks=task_reports,
        aggregate=summarize(task_reports),
    )


def evaluate_attempt(task: EvalTask | EvalTaskV2, facts: RunFacts) -> AttemptReport:
    """Evaluate one attempt, failing closed to not_evaluated (infra).

    Timeout is checked before trace availability: a submitted run that never
    terminated is a real failure signal even when its trace is missing.
    """
    base = AttemptReport(
        run_id=facts.run_id,
        status=STATUS_NOT_EVALUATED,
        error_code=facts.terminal_error_code,
        usage=dict(facts.usage),
        duration_ms=facts.duration_ms,
    )
    if facts.status == "timeout":
        base.status = STATUS_FAILED
        base.error_code = facts.terminal_error_code or "EVAL_TIMEOUT"
        return base
    if not facts.trace_available:
        base.error_code = "missing_trace"
        return base
    if not facts.is_terminal():
        base.error_code = "non_terminal_run"
        return base
    results = [evaluate_assertion(a, facts) for a in task.hard_assertions]
    base.assertions = results
    base.status = STATUS_PASSED if all(r.passed for r in results) else STATUS_FAILED
    return base


def evaluate_task_v2(
    task: EvalTaskV2,
    attempts: list[AttemptReport],
    *,
    min_valid_attempts: int,
    attempts_planned: int | None = None,
) -> TaskReportV2:
    """Aggregate per-attempt outcomes into a v2 task report.

    invariant: any failed attempt fails the task.
    behavior: rate = met / (attempts - infra_failures); the task passes only
    when every valid attempt met its assertions. Fewer valid attempts than
    `min_valid_attempts` yields not_evaluated(infra_insufficient).
    """
    planned = task.attempts if attempts_planned is None else attempts_planned
    if planned != len(attempts):
        raise ValueError(
            f"{task.task_id}: attempts={len(attempts)} does not match attempts_planned={planned}"
        )
    infra = [a for a in attempts if a.status == STATUS_NOT_EVALUATED]
    report = TaskReportV2(
        task_id=task.task_id,
        category=task.category,
        assertion_class=task.assertion_class,
        status=STATUS_NOT_EVALUATED,
        attempts_planned=planned,
        attempts=attempts,
        infra_attempts=[
            InfraAttempt(run_id=a.run_id, reason=a.error_code or "unknown_infra") for a in infra
        ],
    )
    if task.assertion_class == "invariant":
        if any(a.status == STATUS_FAILED for a in attempts):
            report.status = STATUS_FAILED
        elif infra:
            report.not_evaluated_reason = infra[0].error_code or REASON_INFRA_INSUFFICIENT
        else:
            report.status = STATUS_PASSED
        return report

    valid = [a for a in attempts if a.status in {STATUS_PASSED, STATUS_FAILED}]
    met = sum(1 for a in valid if a.status == STATUS_PASSED)
    report.behavior_stats = BehaviorStats(
        attempts=planned,
        met=met,
        rate=met / len(valid) if valid else None,
        infra_failures=len(infra),
    )
    if len(valid) < min_valid_attempts:
        report.not_evaluated_reason = REASON_INFRA_INSUFFICIENT
    elif met == len(valid):
        report.status = STATUS_PASSED
    else:
        report.status = STATUS_FAILED
    return report


def build_report_v2(
    *,
    eval_run_id: str,
    commit: str,
    dataset_version: str,
    dataset_hash: str,
    mode: str,
    lane: str,
    task_reports: list[TaskReportV2],
    provider: str | None = None,
    model: str | None = None,
    prompt_version: str | None = None,
    created_at: str | None = None,
) -> EvalReportV2:
    """Assemble a v2 report, computing the aggregate from task statuses."""
    return EvalReportV2(
        eval_run_id=eval_run_id,
        created_at=created_at or datetime.now(UTC).isoformat(),
        commit=commit,
        dataset_version=dataset_version,
        dataset_hash=dataset_hash,
        mode=mode,
        lane=lane,
        provider=provider,
        model=model,
        prompt_version=prompt_version,
        tasks=task_reports,
        aggregate=summarize(task_reports),
    )
