"""PLAN-0540 gate v2 over evaluation report schema 2.

States and exit codes are frozen:

    PASS 0 | FAIL 1 | NOT_EVALUATED 2 | GATE_ERROR 3

Only PASS may exit 0. Gate v2 consumes one or more lane reports, merges them
by `task_id` and applies class-aware thresholds:

    zero_failure            invariant tasks (metric: hard_assertion_zero_failure)
    behavior_rate_min       behavior tasks  (metric: behavior_rate_min)
    not_evaluated_le_baseline expected tasks (metric: expected_task_status)

Wire format is snake_case end to end (PLAN-0540 decision #10/#11). Legacy v1
reports/configs stay on `gate.py` and keep their camelCase contract.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from xihe_agent.evaluation.gate import (
    EXIT_CODES,
    STATE_FAIL,
    STATE_GATE_ERROR,
    STATE_NOT_EVALUATED,
    STATE_PASS,
    GateConfigError,
    _load_report,
    _utcnow,
    parse_duration,
)

GATE_SCHEMA_VERSION = 2
SUPPORTED_REPORT_SCHEMA = 2
LANES = {"invariant", "behavior"}
TASK_STATUSES = {"passed", "failed", "not_evaluated"}
THRESHOLD_TYPES = {"zero_failure", "behavior_rate_min", "not_evaluated_le_baseline"}
THRESHOLD_SCOPES = {"invariant", "behavior", "all"}
INFRA_REASONS = {"infra_insufficient", "missing_trace", "non_terminal_run"}
EXPECTED_TASK_STATUS_METRIC = "expected_task_status"


class ThresholdV2(BaseModel):
    model_config = ConfigDict(extra="forbid")

    metric_id: str
    type: str
    scope: str = "all"
    value: float | None = None
    min_valid: int | None = None
    expected_attempts: int | None = None
    owner: str
    rationale: str
    source: str
    repeat_window: str


class GateConfigV2(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schema_version: int
    threshold_set_version: str
    max_age: str
    dataset_version: str
    dataset_hash: str
    scorer_version: str
    mode: str
    required_evaluated_task_ids: list[str] = Field(min_length=1)
    expected_not_evaluated_task_ids: list[str] = Field(default_factory=list)
    expected_not_evaluated_reasons: list[str] = Field(default_factory=list)
    thresholds: list[ThresholdV2] = Field(min_length=1)


class GateFailureV2(BaseModel):
    model_config = ConfigDict(extra="forbid")

    task_id: str
    assertion_id: str | None = None
    metric_id: str
    error_code: str | None = None


class GateNotEvaluatedV2(BaseModel):
    model_config = ConfigDict(extra="forbid")

    task_id: str
    reason_code: str


class DiagnosticRefV2(BaseModel):
    model_config = ConfigDict(extra="forbid")

    task_id: str
    eval_run_id: str
    run_id: str | None = None


class GateResultV2(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schema_version: int = GATE_SCHEMA_VERSION
    state: str
    exit_code: int
    candidate_commit: str | None = None
    baseline_ref: str | None = None
    dataset_version: str | None = None
    scorer_version: str | None = None
    threshold_set_version: str | None = None
    evaluated_at: str
    failures: list[GateFailureV2] = Field(default_factory=list)
    not_evaluated: list[GateNotEvaluatedV2] = Field(default_factory=list)
    diagnostic_refs: list[DiagnosticRefV2] = Field(default_factory=list)
    error_code: str | None = None


def load_config_v2(path: Path) -> GateConfigV2:
    if not path.is_file():
        raise GateConfigError(f"gate config not found: {path}")
    try:
        return GateConfigV2.model_validate(json.loads(path.read_text(encoding="utf-8")))
    except (json.JSONDecodeError, ValidationError) as exc:
        raise GateConfigError(f"gate config invalid: {exc}") from exc


def _error(
    code: str, *, evaluated_at: str, threshold_set_version: str | None = None
) -> GateResultV2:
    return GateResultV2(
        state=STATE_GATE_ERROR,
        exit_code=EXIT_CODES[STATE_GATE_ERROR],
        evaluated_at=evaluated_at,
        threshold_set_version=threshold_set_version,
        error_code=code,
    )


def _parse_timestamp(value: Any) -> datetime | None:
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC)


def _identity_error(
    report: dict[str, Any],
    config: GateConfigV2,
    *,
    max_age: Any,
    now: datetime,
    baseline: bool,
) -> str | None:
    prefix = "baseline_" if baseline else ""
    if report.get("schema_version") != SUPPORTED_REPORT_SCHEMA:
        return f"{prefix}report_schema_incompatible"
    if report.get("dataset_version") != config.dataset_version:
        return f"{prefix}dataset_version_mismatch"
    if report.get("dataset_hash") != config.dataset_hash:
        return f"{prefix}dataset_hash_mismatch"
    if report.get("scorer_version") != config.scorer_version:
        return f"{prefix}scorer_version_mismatch"
    if report.get("mode") != config.mode:
        return f"{prefix}mode_mismatch"
    if str(report.get("lane")) not in LANES:
        return f"{prefix}lane_invalid"
    created_at = _parse_timestamp(report.get("created_at"))
    if created_at is None:
        return f"{prefix}report_timestamp_invalid"
    if now - created_at > max_age:
        return f"{prefix}report_stale"
    return None


def _validate_config(config: GateConfigV2) -> str | None:
    required = config.required_evaluated_task_ids
    expected = config.expected_not_evaluated_task_ids
    if len(set(required)) != len(required):
        return "duplicate_required_task_id"
    if len(set(expected)) != len(expected):
        return "duplicate_expected_task_id"
    overlap = set(required) & set(expected)
    if overlap:
        return f"task_status_conflict:{sorted(overlap)[0]}"
    for reason in config.expected_not_evaluated_reasons:
        if reason in INFRA_REASONS:
            return f"expected_reason_is_infra:{reason}"

    seen_metrics: set[str] = set()
    seen_types: set[str] = set()
    for threshold in config.thresholds:
        if threshold.metric_id in seen_metrics:
            return f"duplicate_metric_id:{threshold.metric_id}"
        seen_metrics.add(threshold.metric_id)
        if threshold.type not in THRESHOLD_TYPES:
            return f"unknown_threshold_type:{threshold.type}"
        if threshold.type in seen_types:
            return f"duplicate_threshold_type:{threshold.type}"
        seen_types.add(threshold.type)
        if threshold.scope not in THRESHOLD_SCOPES:
            return f"unknown_threshold_scope:{threshold.scope}"
        if threshold.type == "zero_failure":
            if threshold.scope != "invariant":
                return f"threshold_scope_mismatch:{threshold.metric_id}"
            if threshold.value not in (None, 0):
                return f"threshold_config_invalid:{threshold.metric_id}"
            if threshold.expected_attempts is not None and threshold.expected_attempts < 1:
                return f"threshold_config_invalid:{threshold.metric_id}"
        elif threshold.type == "behavior_rate_min":
            if threshold.scope != "behavior":
                return f"threshold_scope_mismatch:{threshold.metric_id}"
            if threshold.value is None or not 0 <= threshold.value <= 1:
                return f"threshold_config_invalid:{threshold.metric_id}"
            if threshold.min_valid is None or threshold.min_valid < 1:
                return f"threshold_config_invalid:{threshold.metric_id}"
            if threshold.expected_attempts is None or threshold.expected_attempts < 1:
                return f"threshold_config_invalid:{threshold.metric_id}"
        elif threshold.type == "not_evaluated_le_baseline":
            if threshold.scope != "all":
                return f"threshold_scope_mismatch:{threshold.metric_id}"
    return None


def _merge_tasks(
    reports: list[dict[str, Any]],
) -> tuple[dict[str, dict[str, Any]], str | None]:
    by_id: dict[str, dict[str, Any]] = {}
    for report in reports:
        lane = str(report.get("lane"))
        seen_in_report: set[str] = set()
        tasks = report.get("tasks")
        if not isinstance(tasks, list) or not tasks:
            return {}, "report_tasks_missing"
        for task in tasks:
            if not isinstance(task, dict) or not task.get("task_id"):
                return {}, "report_task_invalid"
            task_id = str(task["task_id"])
            if task_id in seen_in_report or task_id in by_id:
                return {}, f"duplicate_task_id:{task_id}"
            seen_in_report.add(task_id)
            if str(task.get("assertion_class")) != lane:
                return {}, f"lane_class_mismatch:{task_id}"
            if str(task.get("status")) not in TASK_STATUSES:
                return {}, f"unknown_task_status:{task_id}"
            attempts = task.get("attempts")
            planned = task.get("attempts_planned")
            if not isinstance(planned, int) or not isinstance(attempts, list):
                return {}, f"attempts_planned_mismatch:{task_id}"
            if len(attempts) > planned:
                return {}, f"attempts_planned_mismatch:{task_id}"
            if str(task.get("status")) != "not_evaluated" and len(attempts) != planned:
                return {}, f"attempts_planned_mismatch:{task_id}"
            by_id[task_id] = task
    return by_id, None


def _first_failed_assertion(task: dict[str, Any]) -> str | None:
    for attempt in task.get("attempts") or []:
        if not isinstance(attempt, dict):
            continue
        for assertion in attempt.get("assertions") or []:
            if isinstance(assertion, dict) and assertion.get("passed") is False:
                return str(assertion.get("assertion_id"))
    return None


def _failure_error_code(task: dict[str, Any]) -> str | None:
    for attempt in task.get("attempts") or []:
        if isinstance(attempt, dict) and attempt.get("status") == "failed":
            return str(attempt["error_code"]) if attempt.get("error_code") else None
    return None


def _first_run_id(task: dict[str, Any]) -> str | None:
    for attempt in task.get("attempts") or []:
        if isinstance(attempt, dict) and attempt.get("run_id"):
            return str(attempt["run_id"])
    return None


def evaluate_gate_v2(
    *,
    report_paths: list[Path],
    baseline_path: Path | None,
    config_path: Path,
    target_commit: str | None = None,
    now: datetime | None = None,
) -> GateResultV2:
    evaluated_at = (now or _utcnow()).isoformat()
    try:
        config = load_config_v2(config_path)
    except GateConfigError as exc:
        return _error(str(exc), evaluated_at=evaluated_at)

    try:
        max_age = parse_duration(config.max_age)
    except GateConfigError as exc:
        return _error(
            str(exc), evaluated_at=evaluated_at, threshold_set_version=config.threshold_set_version
        )

    config_error = _validate_config(config)
    if config_error:
        return _error(
            config_error,
            evaluated_at=evaluated_at,
            threshold_set_version=config.threshold_set_version,
        )
    by_type = {threshold.type: threshold for threshold in config.thresholds}

    baseline: dict[str, Any] | None = None
    if baseline_path is not None:
        try:
            baseline = _load_report(baseline_path)
        except (OSError, ValueError, json.JSONDecodeError):
            return _error(
                "baseline_unreadable",
                evaluated_at=evaluated_at,
                threshold_set_version=config.threshold_set_version,
            )
        error = _identity_error(
            baseline,
            config,
            max_age=max_age,
            now=now or _utcnow(),
            baseline=True,
        )
        if error:
            return _error(
                error,
                evaluated_at=evaluated_at,
                threshold_set_version=config.threshold_set_version,
            )

    reports: list[dict[str, Any]] = []
    if not report_paths:
        return _error(
            "report_unreadable",
            evaluated_at=evaluated_at,
            threshold_set_version=config.threshold_set_version,
        )
    for path in report_paths:
        try:
            report = _load_report(path)
        except (OSError, ValueError, json.JSONDecodeError):
            return _error(
                "report_unreadable",
                evaluated_at=evaluated_at,
                threshold_set_version=config.threshold_set_version,
            )
        error = _identity_error(
            report,
            config,
            max_age=max_age,
            now=now or _utcnow(),
            baseline=False,
        )
        if error:
            return _error(
                error,
                evaluated_at=evaluated_at,
                threshold_set_version=config.threshold_set_version,
            )
        reports.append(report)

    def gate_error(code: str) -> GateResultV2:
        result = _error(
            code, evaluated_at=evaluated_at, threshold_set_version=config.threshold_set_version
        )
        result.candidate_commit = str(reports[0].get("commit")) if reports[0].get("commit") else None
        return result

    target = target_commit or _git_head()
    if not target:
        return gate_error("target_commit_unavailable")
    commits = {str(report.get("commit")) for report in reports}
    if len(commits) != 1 or commits.pop() != target:
        return gate_error("candidate_commit_mismatch")

    by_id, merge_error = _merge_tasks(reports)
    if merge_error:
        return gate_error(merge_error)

    result = GateResultV2(
        state=STATE_PASS,
        exit_code=EXIT_CODES[STATE_PASS],
        candidate_commit=target,
        baseline_ref=str(baseline.get("eval_run_id")) if baseline else None,
        dataset_version=config.dataset_version,
        scorer_version=config.scorer_version,
        threshold_set_version=config.threshold_set_version,
        evaluated_at=evaluated_at,
    )

    required_invariant: list[dict[str, Any]] = []
    required_behavior: list[dict[str, Any]] = []
    for task_id in config.required_evaluated_task_ids:
        task = by_id.get(task_id)
        if task is None:
            result.not_evaluated.append(
                GateNotEvaluatedV2(task_id=task_id, reason_code="missing_required_task")
            )
            continue
        status = str(task.get("status"))
        assertion_class = str(task.get("assertion_class"))
        if status == "not_evaluated":
            result.not_evaluated.append(
                GateNotEvaluatedV2(
                    task_id=task_id,
                    reason_code=str(task.get("not_evaluated_reason") or "not_evaluated"),
                )
            )
        elif assertion_class == "invariant":
            required_invariant.append(task)
        else:
            required_behavior.append(task)
        result.diagnostic_refs.append(
            DiagnosticRefV2(
                task_id=task_id,
                eval_run_id=str(
                    next(
                        (
                            report.get("eval_run_id")
                            for report in reports
                            if any(
                                isinstance(t, dict) and t.get("task_id") == task_id
                                for t in report.get("tasks") or []
                            )
                        ),
                        "",
                    )
                ),
                run_id=_first_run_id(task),
            )
        )

    def check_expected_attempts(task: dict[str, Any], threshold: ThresholdV2) -> str | None:
        if threshold.expected_attempts is None:
            return None
        if task.get("attempts_planned") != threshold.expected_attempts:
            return f"attempts_planned_mismatch:{task.get('task_id')}"
        return None

    if required_invariant:
        threshold = by_type.get("zero_failure")
        if threshold is None:
            return gate_error("zero_failure_threshold_missing")
        for task in required_invariant:
            error = check_expected_attempts(task, threshold)
            if error:
                return gate_error(error)
            if str(task.get("status")) == "failed":
                result.failures.append(
                    GateFailureV2(
                        task_id=str(task.get("task_id")),
                        assertion_id=_first_failed_assertion(task),
                        metric_id=threshold.metric_id,
                        error_code=_failure_error_code(task),
                    )
                )

    if required_behavior:
        threshold = by_type.get("behavior_rate_min")
        if threshold is None:
            return gate_error("missing_threshold_for_class:behavior")
        for task in required_behavior:
            task_id = str(task.get("task_id"))
            stats = task.get("behavior_stats")
            if not isinstance(stats, dict):
                return gate_error(f"missing_behavior_stats:{task_id}")
            attempts = stats.get("attempts")
            infra_failures = stats.get("infra_failures")
            rate = stats.get("rate")
            if (
                not isinstance(attempts, int)
                or not isinstance(infra_failures, int)
                or infra_failures < 0
                or infra_failures > attempts
                or (rate is not None and not isinstance(rate, (int, float)))
            ):
                return gate_error(f"behavior_stats_invalid:{task_id}")
            if attempts != task.get("attempts_planned"):
                return gate_error(f"attempts_planned_mismatch:{task_id}")
            error = check_expected_attempts(task, threshold)
            if error:
                return gate_error(error)
            valid = attempts - infra_failures
            # The behavior-threshold config validation above already rejects
            # thresholds whose value / min_valid are unset or out of range;
            # rebind locally (fail-closed on config drift) so the comparisons
            # below stay typed instead of comparing against None.
            min_valid = threshold.min_valid
            threshold_value = threshold.value
            if min_valid is None or threshold_value is None:
                return gate_error(f"threshold_config_invalid:{threshold.metric_id}")
            if rate is None or valid < min_valid:
                result.not_evaluated.append(
                    GateNotEvaluatedV2(task_id=task_id, reason_code="infra_insufficient")
                )
            elif isinstance(rate, (int, float)) and float(rate) < threshold_value:
                result.failures.append(
                    GateFailureV2(
                        task_id=task_id,
                        metric_id=threshold.metric_id,
                        error_code="behavior_rate_below_min",
                    )
                )

    expected_threshold = by_type.get("not_evaluated_le_baseline")
    for task_id in config.expected_not_evaluated_task_ids:
        task = by_id.get(task_id)
        if task is None:
            result.not_evaluated.append(
                GateNotEvaluatedV2(task_id=task_id, reason_code="missing_expected_task")
            )
            continue
        status = str(task.get("status"))
        if status == "failed":
            if expected_threshold is None:
                return gate_error("expected_task_threshold_missing")
            result.failures.append(
                GateFailureV2(
                    task_id=task_id,
                    metric_id=expected_threshold.metric_id,
                    error_code="expected_task_failed",
                )
            )
        elif status == "not_evaluated":
            reason = str(task.get("not_evaluated_reason") or "not_evaluated")
            if reason not in config.expected_not_evaluated_reasons:
                result.not_evaluated.append(
                    GateNotEvaluatedV2(task_id=task_id, reason_code=reason)
                )

    if expected_threshold is not None:
        if baseline is None:
            return gate_error("baseline_required_for_threshold")
        candidate_count = sum(
            1 for task in by_id.values() if str(task.get("status")) == "not_evaluated"
        )
        baseline_count = sum(
            1
            for task in baseline.get("tasks") or []
            if isinstance(task, dict) and str(task.get("status")) == "not_evaluated"
        )
        if candidate_count > baseline_count:
            result.failures.append(
                GateFailureV2(
                    task_id="*",
                    metric_id=expected_threshold.metric_id,
                    error_code="coverage_shrunk",
                )
            )

    if result.not_evaluated:
        result.state = STATE_NOT_EVALUATED
    elif result.failures:
        result.state = STATE_FAIL
    result.exit_code = EXIT_CODES[result.state]
    return result


def _git_head() -> str | None:
    import subprocess

    try:
        out = subprocess.run(
            ["git", "rev-parse", "HEAD"], capture_output=True, text=True, check=False, timeout=10
        )
        return out.stdout.strip() or None
    except (OSError, subprocess.SubprocessError):
        return None
