"""PLAN-0512 local quality-regression gate over PLAN-0511 reports.

Read-only: the gate never rewrites the report, baseline, dataset or thresholds.
States and exit codes are frozen by spec/gate-contract.md:

    PASS 0 | FAIL 1 | NOT_EVALUATED 2 | GATE_ERROR 3

Only PASS may exit 0. Missing data, stale data, unconfigured thresholds and
internal failures must never turn green.

Wire format (machine output and gate config) uses camelCase; Python attributes
are snake_case and serialize with `model_dump(by_alias=True)`.
"""

from __future__ import annotations

import json
import re
import subprocess
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, ValidationError

STATE_PASS = "PASS"
STATE_FAIL = "FAIL"
STATE_NOT_EVALUATED = "NOT_EVALUATED"
STATE_GATE_ERROR = "GATE_ERROR"

EXIT_CODES = {STATE_PASS: 0, STATE_FAIL: 1, STATE_NOT_EVALUATED: 2, STATE_GATE_ERROR: 3}

GATE_SCHEMA_VERSION = 1
SUPPORTED_REPORT_SCHEMA = 1

# Statuses in the PLAN-0511 report that are not a definite evaluated outcome.
NON_DEFINITE_STATUSES = {"not_evaluated", "unknown"}

_DURATION_RE = re.compile(r"^P(?:(?P<days>\d+)D)?(?:T(?:(?P<hours>\d+)H)?(?:(?P<minutes>\d+)M)?)?$")


class GateConfigError(Exception):
    """Raised when the gate config itself is missing or unusable."""


class Threshold(BaseModel):
    """One calibrated threshold; every field is mandatory evidence provenance."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    metric_id: str = Field(alias="metricId")
    type: str
    owner: str
    rationale: str
    source: str
    repeat_window: str = Field(alias="repeatWindow")


class GateConfig(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    schema_version: int = Field(alias="schemaVersion")
    threshold_set_version: str = Field(alias="thresholdSetVersion")
    max_age: str = Field(alias="maxAge")
    dataset_version: str = Field(alias="datasetVersion")
    dataset_hash: str = Field(alias="datasetHash")
    scorer_version: str = Field(alias="scorerVersion")
    mode: str
    required_evaluated_task_ids: list[str] = Field(alias="requiredEvaluatedTaskIds", min_length=1)
    expected_not_evaluated_task_ids: list[str] = Field(
        default_factory=list, alias="expectedNotEvaluatedTaskIds"
    )
    expected_not_evaluated_reasons: list[str] = Field(
        default_factory=list, alias="expectedNotEvaluatedReasons"
    )
    thresholds: list[Threshold] = Field(min_length=1)


class GateFailure(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    task_id: str = Field(alias="taskId")
    assertion_id: str | None = Field(default=None, alias="assertionId")
    metric_id: str = Field(alias="metricId")
    error_code: str | None = Field(default=None, alias="errorCode")


class GateNotEvaluated(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    task_id: str = Field(alias="taskId")
    reason_code: str = Field(alias="reasonCode")


class DiagnosticRef(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    task_id: str = Field(alias="taskId")
    eval_run_id: str = Field(alias="evalRunId")
    run_id: str | None = Field(default=None, alias="runId")


class GateResult(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    schema_version: int = Field(default=GATE_SCHEMA_VERSION, alias="schemaVersion")
    state: str
    exit_code: int = Field(alias="exitCode")
    candidate_commit: str | None = Field(default=None, alias="candidateCommit")
    baseline_ref: str | None = Field(default=None, alias="baselineRef")
    dataset_version: str | None = Field(default=None, alias="datasetVersion")
    scorer_version: str | None = Field(default=None, alias="scorerVersion")
    threshold_set_version: str | None = Field(default=None, alias="thresholdSetVersion")
    evaluated_at: str = Field(alias="evaluatedAt")
    failures: list[GateFailure] = Field(default_factory=list)
    not_evaluated: list[GateNotEvaluated] = Field(default_factory=list, alias="notEvaluated")
    diagnostic_refs: list[DiagnosticRef] = Field(default_factory=list, alias="diagnosticRefs")
    error_code: str | None = Field(default=None, alias="errorCode")


def _utcnow() -> datetime:
    return datetime.now(UTC)


def parse_duration(text: str) -> timedelta:
    match = _DURATION_RE.match(text.strip())
    if not match or not any(match.groupdict().values()):
        raise GateConfigError(f"invalid maxAge duration: {text!r}")
    parts = {k: int(v) for k, v in match.groupdict().items() if v is not None}
    return timedelta(**parts)


def load_config(path: Path) -> GateConfig:
    if not path.is_file():
        raise GateConfigError(f"gate config not found: {path}")
    try:
        return GateConfig.model_validate(json.loads(path.read_text(encoding="utf-8")))
    except (json.JSONDecodeError, ValidationError) as exc:
        raise GateConfigError(f"gate config invalid: {exc}") from exc


def _load_report(path: Path) -> dict[str, Any]:
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError("report is not a JSON object")
    return data


def _git_head() -> str | None:
    try:
        out = subprocess.run(
            ["git", "rev-parse", "HEAD"], capture_output=True, text=True, check=False, timeout=10
        )
        return out.stdout.strip() or None
    except (OSError, subprocess.SubprocessError):
        return None


def _error(code: str, *, evaluated_at: str, threshold_set_version: str | None = None) -> GateResult:
    return GateResult(
        state=STATE_GATE_ERROR,
        exitCode=EXIT_CODES[STATE_GATE_ERROR],
        evaluatedAt=evaluated_at,
        thresholdSetVersion=threshold_set_version,
        errorCode=code,
    )


def evaluate_gate(
    *,
    report_path: Path,
    baseline_path: Path | None,
    config_path: Path,
    target_commit: str | None = None,
    now: datetime | None = None,
) -> GateResult:
    """Run the gate; any unusable input resolves to GATE_ERROR (never PASS)."""
    evaluated_at = (now or _utcnow()).isoformat()
    try:
        config = load_config(config_path)
    except GateConfigError as exc:
        return _error(str(exc), evaluated_at=evaluated_at)

    try:
        max_age = parse_duration(config.max_age)
    except GateConfigError as exc:
        return _error(str(exc), evaluated_at=evaluated_at, threshold_set_version=config.threshold_set_version)

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

    try:
        report = _load_report(report_path)
    except (OSError, ValueError, json.JSONDecodeError):
        return _error(
            "report_unreadable",
            evaluated_at=evaluated_at,
            threshold_set_version=config.threshold_set_version,
        )

    def gate_error(code: str) -> GateResult:
        result = _error(code, evaluated_at=evaluated_at, threshold_set_version=config.threshold_set_version)
        result.candidate_commit = str(report.get("commit")) if report.get("commit") else None
        return result

    if report.get("schema_version") != SUPPORTED_REPORT_SCHEMA:
        return gate_error("report_schema_incompatible")
    if report.get("dataset_version") != config.dataset_version:
        return gate_error("dataset_version_mismatch")
    if report.get("dataset_hash") != config.dataset_hash:
        return gate_error("dataset_hash_mismatch")
    if report.get("scorer_version") != config.scorer_version:
        return gate_error("scorer_version_mismatch")
    if report.get("mode") != config.mode:
        return gate_error("mode_mismatch")

    target = target_commit or _git_head()
    if not target:
        return gate_error("target_commit_unavailable")
    if str(report.get("commit")) != target:
        return gate_error("candidate_commit_mismatch")

    created_raw = report.get("created_at")
    try:
        created_at = datetime.fromisoformat(str(created_raw).replace("Z", "+00:00"))
    except ValueError:
        return gate_error("report_timestamp_invalid")
    if created_at.tzinfo is None:
        created_at = created_at.replace(tzinfo=UTC)
    if (now or _utcnow()) - created_at > max_age:
        return gate_error("report_stale")

    tasks = report.get("tasks")
    if not isinstance(tasks, list) or not tasks:
        return gate_error("report_tasks_missing")
    by_id: dict[str, dict[str, Any]] = {
        str(t.get("task_id")): t for t in tasks if isinstance(t, dict) and t.get("task_id")
    }

    result = GateResult(
        state=STATE_PASS,
        exitCode=EXIT_CODES[STATE_PASS],
        candidateCommit=target,
        baselineRef=str(baseline.get("eval_run_id")) if baseline else None,
        datasetVersion=config.dataset_version,
        scorerVersion=config.scorer_version,
        thresholdSetVersion=config.threshold_set_version,
        evaluatedAt=evaluated_at,
    )

    # Required evaluated tasks must be present with a definite outcome.
    failed_required: list[dict[str, Any]] = []
    for task_id in config.required_evaluated_task_ids:
        task = by_id.get(task_id)
        if task is None:
            result.not_evaluated.append(
                GateNotEvaluated(taskId=task_id, reasonCode="missing_required_task")
            )
            continue
        status = str(task.get("status"))
        if status in NON_DEFINITE_STATUSES:
            reason = str(task.get("not_evaluated_reason") or status)
            result.not_evaluated.append(GateNotEvaluated(taskId=task_id, reasonCode=reason))
        elif status == "failed":
            failed_required.append(task)
        if task.get("run_id"):
            result.diagnostic_refs.append(
                DiagnosticRef(
                    taskId=task_id,
                    evalRunId=str(report.get("eval_run_id")),
                    runId=str(task.get("run_id")),
                )
            )

    # Expected-not-evaluated tasks must carry an expected reason (else environment issue).
    for task_id in config.expected_not_evaluated_task_ids:
        task = by_id.get(task_id)
        if task is None:
            result.not_evaluated.append(
                GateNotEvaluated(taskId=task_id, reasonCode="missing_expected_task")
            )
            continue
        if str(task.get("status")) == "not_evaluated":
            reason = str(task.get("not_evaluated_reason") or "unknown")
            if config.expected_not_evaluated_reasons and reason not in config.expected_not_evaluated_reasons:
                result.not_evaluated.append(GateNotEvaluated(taskId=task_id, reasonCode=reason))

    # Calibrated thresholds. Every configured type must be dispatched; a type
    # added to the config without an implementation must fail closed instead
    # of being silently skipped.
    has_zero_failure = False
    for threshold in config.thresholds:
        if threshold.type == "zero_failure":
            has_zero_failure = True
            for task in failed_required:
                assertion_id = next(
                    (
                        str(a.get("assertion_id"))
                        for a in task.get("assertions") or []
                        if isinstance(a, dict) and a.get("passed") is False
                    ),
                    None,
                )
                result.failures.append(
                    GateFailure(
                        taskId=str(task.get("task_id")),
                        assertionId=assertion_id,
                        metricId=threshold.metric_id,
                        errorCode=str(task.get("error_code")) if task.get("error_code") else None,
                    )
                )
        elif threshold.type == "not_evaluated_le_baseline":
            if baseline is None:
                # A baseline-relative threshold without a baseline is an unusable
                # configuration, not a task-level non-evaluation.
                return gate_error("baseline_required_for_threshold")
            candidate_count = sum(
                1 for t in tasks if isinstance(t, dict) and str(t.get("status")) == "not_evaluated"
            )
            baseline_count = sum(
                1
                for t in baseline.get("tasks") or []
                if isinstance(t, dict) and str(t.get("status")) == "not_evaluated"
            )
            if candidate_count > baseline_count:
                result.failures.append(
                    GateFailure(taskId="*", metricId=threshold.metric_id, errorCode="coverage_shrunk")
                )
        elif threshold.type == "behavior_rate_min":
            # PLAN-0540 v2-only threshold; a v1 report has no behavior_stats.
            return gate_error("threshold_type_requires_report_schema_2")
        else:
            return gate_error(f"unknown_threshold_type:{threshold.type}")

    if failed_required and not has_zero_failure:
        return gate_error("zero_failure_threshold_missing")

    if result.not_evaluated:
        result.state = STATE_NOT_EVALUATED
    elif result.failures:
        result.state = STATE_FAIL
    result.exit_code = EXIT_CODES[result.state]
    return result
