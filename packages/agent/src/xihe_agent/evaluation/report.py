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
from xihe_agent.evaluation.schema import EvalTask

SCORER_VERSION = "v1"
REPORT_SCHEMA_VERSION = 1

STATUS_PASSED = "passed"
STATUS_FAILED = "failed"
STATUS_NOT_EVALUATED = "not_evaluated"


class TaskReport(BaseModel):
    """Per-task evaluation outcome (content-free)."""

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
    """Full evaluation run report for one dataset/commit/provider configuration."""

    model_config = ConfigDict(extra="forbid")

    schema_version: int = REPORT_SCHEMA_VERSION
    eval_run_id: str
    created_at: str
    commit: str
    dataset_version: str
    dataset_hash: str
    scorer_version: str = SCORER_VERSION
    mode: str
    provider: str | None = None
    model: str | None = None
    prompt_version: str | None = None
    tasks: list[TaskReport] = Field(default_factory=list)
    aggregate: dict[str, int] = Field(default_factory=dict)


def evaluate_task(task: EvalTask, facts: RunFacts) -> TaskReport:
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
    if not facts.is_terminal():
        base.not_evaluated_reason = f"non_terminal_status:{facts.status}"
        return base
    base.trace_ref = f"chat_run:{facts.run_id}"
    results = [evaluate_assertion(a, facts) for a in task.hard_assertions]
    base.assertions = results
    base.status = STATUS_PASSED if all(r.passed for r in results) else STATUS_FAILED
    return base


def summarize(tasks: list[TaskReport]) -> dict[str, int]:
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
    """Assemble a report, computing the aggregate from task statuses."""
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
