"""PLAN-0540 gate v2 acceptance matrix over evaluation report schema 2."""

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

from xihe_agent.evaluation.__main__ import main
from xihe_agent.evaluation.gate import (
    STATE_FAIL,
    STATE_GATE_ERROR,
    STATE_NOT_EVALUATED,
    STATE_PASS,
)
from xihe_agent.evaluation.gate_v2 import evaluate_gate_v2

DATASET_HASH = "a" * 64
COMMIT = "c0ffee00" + "0" * 32
INV_PASS = "failure_budget.no_repeat.v2"
INV_EXPECTED = "tool_authorization.denied_mutation.v1"
BEHAVIOR_TASKS = [
    "instruction_following.format_and_scope.v1",
    "grounded_citation.synthetic_source.v1",
    "failure_budget.attempt_rate.v2",
]
EXPECTED_REASON = "no_denial_observability"
DEFAULT_BASELINE = object()


def _threshold(metric_id: str, type_: str, scope: str, **extra) -> dict:
    return {
        "metric_id": metric_id,
        "type": type_,
        "scope": scope,
        "owner": "test",
        "rationale": "test",
        "source": "test",
        "repeat_window": "test",
        **extra,
    }


def _thresholds() -> list[dict]:
    return [
        _threshold("hard_assertion_zero_failure", "zero_failure", "invariant", expected_attempts=1),
        _threshold(
            "behavior_rate_min",
            "behavior_rate_min",
            "behavior",
            value=0.8,
            min_valid=3,
            expected_attempts=5,
        ),
        _threshold("expected_task_status", "not_evaluated_le_baseline", "all"),
    ]


def _config(**overrides) -> dict:
    payload = {
        "schema_version": 2,
        "threshold_set_version": "gate-v2-test",
        "max_age": "P14D",
        "dataset_version": "v2",
        "dataset_hash": DATASET_HASH,
        "scorer_version": "v2",
        "mode": "cp-real",
        "required_evaluated_task_ids": [*BEHAVIOR_TASKS, INV_PASS],
        "expected_not_evaluated_task_ids": [INV_EXPECTED],
        "expected_not_evaluated_reasons": [EXPECTED_REASON],
        "thresholds": _thresholds(),
    }
    payload.update(overrides)
    return payload


def _write(path: Path, payload) -> Path:
    path.write_text(json.dumps(payload), encoding="utf-8")
    return path


def _attempt(
    run_id: str,
    *,
    status: str = "passed",
    assertions: list[dict] | None = None,
    error_code: str | None = None,
) -> dict:
    if assertions is None:
        passed = status == "passed"
        assertions = [
            {"assertion_id": "A1", "kind": "json_schema", "passed": passed, "detail": "x"}
        ]
    return {
        "run_id": run_id,
        "status": status,
        "error_code": error_code,
        "assertions": assertions,
        "usage": {},
        "duration_ms": 1,
    }


def _invariant_task(
    task_id: str,
    *,
    status: str = "passed",
    planned: int = 1,
    attempts: list[dict] | None = None,
    reason: str | None = None,
) -> dict:
    if attempts is None:
        if status == "not_evaluated":
            attempts = []
        else:
            attempts = [
                _attempt(
                    f"{task_id}-run",
                    status=status,
                    error_code="ASSERTION_FAILED" if status == "failed" else None,
                )
            ]
    return {
        "task_id": task_id,
        "category": task_id.split(".")[0],
        "assertion_class": "invariant",
        "status": status,
        "attempts_planned": planned,
        "attempts": attempts,
        "infra_attempts": [],
        "behavior_stats": None,
        "not_evaluated_reason": reason,
    }


def _behavior_task(
    task_id: str,
    *,
    status: str = "passed",
    planned: int = 5,
    met: int = 5,
    infra: int = 0,
    attempts: list[dict] | None = None,
    stats: dict | None = None,
    reason: str | None = None,
) -> dict:
    if attempts is None:
        attempts = [
            _attempt(
                f"{task_id}-r{index}",
                status="not_evaluated" if index < infra else ("passed" if index < met else "failed"),
                assertions=[] if index < infra else None,
                error_code="missing_trace" if index < infra else None,
            )
            for index in range(planned)
        ]
    if stats is None:
        valid = planned - infra
        stats = {
            "attempts": planned,
            "met": met,
            "rate": met / valid if valid else None,
            "infra_failures": infra,
        }
    return {
        "task_id": task_id,
        "category": task_id.split(".")[0],
        "assertion_class": "behavior",
        "status": status,
        "attempts_planned": planned,
        "attempts": attempts,
        "infra_attempts": [],
        "behavior_stats": stats,
        "not_evaluated_reason": reason,
    }


def _report(
    tasks: list[dict],
    *,
    lane: str,
    schema_version: int = 2,
    commit: str = COMMIT,
    dataset_version: str = "v2",
    dataset_hash: str = DATASET_HASH,
    scorer_version: str = "v2",
    mode: str = "cp-real",
    created_at: str | None = None,
    eval_run_id: str | None = None,
) -> dict:
    return {
        "schema_version": schema_version,
        "eval_run_id": eval_run_id or f"eval-{lane}",
        "created_at": created_at or datetime.now(UTC).isoformat(),
        "commit": commit,
        "dataset_version": dataset_version,
        "dataset_hash": dataset_hash,
        "scorer_version": scorer_version,
        "mode": mode,
        "lane": lane,
        "tasks": tasks,
    }


def _invariant_report(*, inv_task=None, expected_task=None, **report_overrides) -> dict:
    tasks = [
        inv_task or _invariant_task(INV_PASS),
        expected_task
        or _invariant_task(INV_EXPECTED, status="not_evaluated", reason=EXPECTED_REASON),
    ]
    return _report(tasks, lane="invariant", **report_overrides)


def _behavior_report(*, tasks=None, **report_overrides) -> dict:
    if tasks is None:
        tasks = [_behavior_task(task_id) for task_id in BEHAVIOR_TASKS]
    return _report(tasks, lane="behavior", **report_overrides)


def _baseline() -> dict:
    tasks = [_behavior_task(task_id) for task_id in BEHAVIOR_TASKS]
    tasks.append(_invariant_task(INV_PASS))
    tasks.append(_invariant_task(INV_EXPECTED, status="not_evaluated", reason=EXPECTED_REASON))
    return _report(tasks, lane="behavior", eval_run_id="baseline")


def _run(tmp_path: Path, config_path: Path, reports: list[dict], *, baseline=DEFAULT_BASELINE, target=COMMIT):
    paths = [
        _write(tmp_path / f"report-{index}.json", report)
        for index, report in enumerate(reports)
    ]
    baseline_report = _baseline() if baseline is DEFAULT_BASELINE else baseline
    baseline_path = _write(tmp_path / "baseline.json", baseline_report) if baseline_report else None
    return evaluate_gate_v2(
        report_paths=paths,
        baseline_path=baseline_path,
        config_path=config_path,
        target_commit=target,
    )


def _config_error(tmp_path: Path, **overrides) -> str | None:
    path = _write(tmp_path / "bad-config.json", _config(**overrides))
    result = _run(tmp_path, path, [_invariant_report(), _behavior_report()])
    assert result.state == STATE_GATE_ERROR
    return result.error_code


@pytest.fixture()
def config_path(tmp_path: Path) -> Path:
    return _write(tmp_path / "gate-v2.json", _config())


def test_pass_merges_invariant_and_behavior_reports(tmp_path, config_path):
    result = _run(tmp_path, config_path, [_invariant_report(), _behavior_report()])
    assert result.state == STATE_PASS
    assert result.exit_code == 0
    assert result.failures == [] and result.not_evaluated == []
    assert {ref.task_id for ref in result.diagnostic_refs} == {*BEHAVIOR_TASKS, INV_PASS}


def test_invariant_failure_fails_with_attempt_assertion(tmp_path, config_path):
    inv = _invariant_report(inv_task=_invariant_task(INV_PASS, status="failed"))
    result = _run(tmp_path, config_path, [inv, _behavior_report()])
    assert result.state == STATE_FAIL
    assert result.exit_code == 1
    assert result.failures[0].task_id == INV_PASS
    assert result.failures[0].assertion_id == "A1"
    assert result.failures[0].metric_id == "hard_assertion_zero_failure"
    assert result.failures[0].error_code == "ASSERTION_FAILED"


def test_behavior_failure_with_empty_assertions_fails_on_rate(tmp_path, config_path):
    attempts = [
        _attempt(f"r{index}", status="passed" if index < 2 else "failed", assertions=[])
        for index in range(5)
    ]
    task = _behavior_task(BEHAVIOR_TASKS[0], status="failed", met=2, attempts=attempts)
    report = _behavior_report(tasks=[task, *[_behavior_task(t) for t in BEHAVIOR_TASKS[1:]]])
    result = _run(tmp_path, config_path, [_invariant_report(), report])
    assert result.state == STATE_FAIL
    assert result.failures[0].task_id == BEHAVIOR_TASKS[0]
    assert result.failures[0].error_code == "behavior_rate_below_min"


def test_behavior_rate_at_threshold_passes_despite_task_status_failed(tmp_path, config_path):
    task = _behavior_task(BEHAVIOR_TASKS[0], status="failed", met=4)
    report = _behavior_report(tasks=[task, *[_behavior_task(t) for t in BEHAVIOR_TASKS[1:]]])
    result = _run(tmp_path, config_path, [_invariant_report(), report])
    assert result.state == STATE_PASS


def test_min_valid_gate_marks_infra_insufficient(tmp_path, config_path):
    task = _behavior_task(BEHAVIOR_TASKS[0], infra=3, met=2)
    report = _behavior_report(tasks=[task, *[_behavior_task(t) for t in BEHAVIOR_TASKS[1:]]])
    result = _run(tmp_path, config_path, [_invariant_report(), report])
    assert result.state == STATE_NOT_EVALUATED
    assert result.exit_code == 2
    assert any(
        item.task_id == BEHAVIOR_TASKS[0] and item.reason_code == "infra_insufficient"
        for item in result.not_evaluated
    )


def test_report_not_evaluated_reason_propagates(tmp_path, config_path):
    task = _behavior_task(
        BEHAVIOR_TASKS[0],
        status="not_evaluated",
        met=0,
        infra=5,
        reason="infra_insufficient",
    )
    report = _behavior_report(tasks=[task, *[_behavior_task(t) for t in BEHAVIOR_TASKS[1:]]])
    result = _run(tmp_path, config_path, [_invariant_report(), report])
    assert result.state == STATE_NOT_EVALUATED
    assert any(item.reason_code == "infra_insufficient" for item in result.not_evaluated)


def test_missing_required_task_not_evaluated(tmp_path, config_path):
    report = _behavior_report(tasks=[_behavior_task(t) for t in BEHAVIOR_TASKS[1:]])
    result = _run(tmp_path, config_path, [_invariant_report(), report])
    assert result.state == STATE_NOT_EVALUATED
    assert result.not_evaluated[0].task_id == BEHAVIOR_TASKS[0]
    assert result.not_evaluated[0].reason_code == "missing_required_task"


def test_missing_expected_task_not_evaluated(tmp_path, config_path):
    inv = _report([_invariant_task(INV_PASS)], lane="invariant")
    result = _run(tmp_path, config_path, [inv, _behavior_report()])
    assert result.state == STATE_NOT_EVALUATED
    assert any(
        item.task_id == INV_EXPECTED and item.reason_code == "missing_expected_task"
        for item in result.not_evaluated
    )


def test_unexpected_expected_reason_not_evaluated(tmp_path, config_path):
    expected = _invariant_task(INV_EXPECTED, status="not_evaluated", reason="EVAL_TIMEOUT")
    result = _run(tmp_path, config_path, [_invariant_report(expected_task=expected), _behavior_report()])
    assert result.state == STATE_NOT_EVALUATED
    assert any(item.reason_code == "EVAL_TIMEOUT" for item in result.not_evaluated)


def test_expected_task_failed_fails(tmp_path, config_path):
    expected = _invariant_task(INV_EXPECTED, status="failed")
    result = _run(tmp_path, config_path, [_invariant_report(expected_task=expected), _behavior_report()])
    assert result.state == STATE_FAIL
    assert result.failures[0].task_id == INV_EXPECTED
    assert result.failures[0].metric_id == "expected_task_status"
    assert result.failures[0].error_code == "expected_task_failed"


def test_coverage_shrink_fails(tmp_path, config_path):
    extra = _behavior_task(
        "extra.task.v1", status="not_evaluated", met=0, infra=5, reason="no_tool_surface"
    )
    report = _behavior_report(tasks=[*[_behavior_task(t) for t in BEHAVIOR_TASKS], extra])
    result = _run(tmp_path, config_path, [_invariant_report(), report])
    assert result.state == STATE_FAIL
    assert result.failures[0].error_code == "coverage_shrunk"


def test_duplicate_task_id_within_report_is_gate_error(tmp_path, config_path):
    report = _behavior_report(tasks=[_behavior_task(BEHAVIOR_TASKS[0]), _behavior_task(BEHAVIOR_TASKS[0])])
    result = _run(tmp_path, config_path, [_invariant_report(), report])
    assert result.state == STATE_GATE_ERROR
    assert result.error_code == f"duplicate_task_id:{BEHAVIOR_TASKS[0]}"


def test_duplicate_task_id_across_reports_is_gate_error(tmp_path, config_path):
    first = _behavior_report()
    second = _behavior_report(tasks=[_behavior_task(BEHAVIOR_TASKS[0])], eval_run_id="eval-dup")
    result = _run(tmp_path, config_path, [_invariant_report(), first, second])
    assert result.state == STATE_GATE_ERROR
    assert result.error_code == f"duplicate_task_id:{BEHAVIOR_TASKS[0]}"


def test_lane_class_mismatch_is_gate_error(tmp_path, config_path):
    task_id = "failure_budget.mismatch.v1"
    report = _behavior_report(tasks=[_invariant_task(task_id)])
    result = _run(tmp_path, config_path, [_invariant_report(), report])
    assert result.state == STATE_GATE_ERROR
    assert result.error_code == f"lane_class_mismatch:{task_id}"


def test_unknown_task_status_is_gate_error(tmp_path, config_path):
    task = _behavior_task(BEHAVIOR_TASKS[0])
    task["status"] = "skipped"
    report = _behavior_report(tasks=[task, *[_behavior_task(t) for t in BEHAVIOR_TASKS[1:]]])
    result = _run(tmp_path, config_path, [_invariant_report(), report])
    assert result.error_code == f"unknown_task_status:{BEHAVIOR_TASKS[0]}"


def test_attempts_planned_mismatch_with_attempt_list(tmp_path, config_path):
    task = _behavior_task(BEHAVIOR_TASKS[0], planned=4)
    task["attempts"] = [_attempt(f"r{index}") for index in range(5)]
    report = _behavior_report(tasks=[task, *[_behavior_task(t) for t in BEHAVIOR_TASKS[1:]]])
    result = _run(tmp_path, config_path, [_invariant_report(), report])
    assert result.error_code == f"attempts_planned_mismatch:{BEHAVIOR_TASKS[0]}"


def test_attempts_planned_mismatch_with_threshold(tmp_path, config_path):
    report = _behavior_report(tasks=[_behavior_task(t, planned=3, met=3) for t in BEHAVIOR_TASKS])
    result = _run(tmp_path, config_path, [_invariant_report(), report])
    assert result.error_code == f"attempts_planned_mismatch:{BEHAVIOR_TASKS[0]}"


def test_invariant_attempts_planned_mismatch_with_threshold(tmp_path, config_path):
    task = _invariant_task(INV_PASS, planned=2, attempts=[_attempt("r1"), _attempt("r2")])
    result = _run(tmp_path, config_path, [_invariant_report(inv_task=task), _behavior_report()])
    assert result.error_code == f"attempts_planned_mismatch:{INV_PASS}"


def test_behavior_stats_missing_is_gate_error(tmp_path, config_path):
    task = _behavior_task(BEHAVIOR_TASKS[0])
    task["behavior_stats"] = None
    report = _behavior_report(tasks=[task, *[_behavior_task(t) for t in BEHAVIOR_TASKS[1:]]])
    result = _run(tmp_path, config_path, [_invariant_report(), report])
    assert result.error_code == f"missing_behavior_stats:{BEHAVIOR_TASKS[0]}"


def test_behavior_stats_invalid_is_gate_error(tmp_path, config_path):
    task = _behavior_task(
        BEHAVIOR_TASKS[0],
        stats={"attempts": 5, "met": 5, "rate": 1.0, "infra_failures": 6},
    )
    report = _behavior_report(tasks=[task, *[_behavior_task(t) for t in BEHAVIOR_TASKS[1:]]])
    result = _run(tmp_path, config_path, [_invariant_report(), report])
    assert result.error_code == f"behavior_stats_invalid:{BEHAVIOR_TASKS[0]}"


def test_report_tasks_missing_is_gate_error(tmp_path, config_path):
    result = _run(tmp_path, config_path, [_invariant_report(), _behavior_report(tasks=[])])
    assert result.error_code == "report_tasks_missing"


def test_stale_report_is_gate_error(tmp_path, config_path):
    old = (datetime.now(UTC) - timedelta(days=30)).isoformat()
    result = _run(tmp_path, config_path, [_invariant_report(created_at=old), _behavior_report()])
    assert result.error_code == "report_stale"


def test_invalid_lane_is_gate_error(tmp_path, config_path):
    report = _report([_behavior_task(BEHAVIOR_TASKS[0])], lane="mixed")
    result = _run(tmp_path, config_path, [_invariant_report(), report])
    assert result.error_code == "lane_invalid"


def test_commit_mismatch_is_gate_error(tmp_path, config_path):
    report = _behavior_report(commit="other")
    result = _run(tmp_path, config_path, [_invariant_report(), report])
    assert result.error_code == "candidate_commit_mismatch"


def test_v1_baseline_is_gate_error(tmp_path, config_path):
    baseline = _baseline()
    baseline["schema_version"] = 1
    result = _run(tmp_path, config_path, [_invariant_report(), _behavior_report()], baseline=baseline)
    assert result.error_code == "baseline_report_schema_incompatible"


def test_v1_candidate_is_gate_error(tmp_path, config_path):
    result = _run(tmp_path, config_path, [_invariant_report(schema_version=1), _behavior_report()])
    assert result.error_code == "report_schema_incompatible"


def test_missing_baseline_for_threshold_is_gate_error(tmp_path, config_path):
    result = _run(tmp_path, config_path, [_invariant_report(), _behavior_report()], baseline=None)
    assert result.error_code == "baseline_required_for_threshold"


def test_empty_report_list_is_gate_error(tmp_path, config_path):
    result = evaluate_gate_v2(
        report_paths=[],
        baseline_path=None,
        config_path=config_path,
        target_commit=COMMIT,
    )
    assert result.error_code == "report_unreadable"


def test_duplicate_metric_id_is_gate_error(tmp_path, config_path):
    thresholds = _thresholds()
    thresholds[1]["metric_id"] = thresholds[0]["metric_id"]
    assert _config_error(tmp_path, thresholds=thresholds) == "duplicate_metric_id:hard_assertion_zero_failure"


def test_unknown_threshold_type_is_gate_error(tmp_path, config_path):
    thresholds = _thresholds()
    thresholds[0]["type"] = "mystery_type"
    assert _config_error(tmp_path, thresholds=thresholds) == "unknown_threshold_type:mystery_type"


def test_unknown_threshold_scope_is_gate_error(tmp_path, config_path):
    thresholds = _thresholds()
    thresholds[0]["scope"] = "frontend"
    assert _config_error(tmp_path, thresholds=thresholds) == "unknown_threshold_scope:frontend"


def test_threshold_scope_mismatch_is_gate_error(tmp_path, config_path):
    thresholds = _thresholds()
    thresholds[0]["scope"] = "behavior"
    assert (
        _config_error(tmp_path, thresholds=thresholds)
        == "threshold_scope_mismatch:hard_assertion_zero_failure"
    )


def test_duplicate_threshold_type_is_gate_error(tmp_path, config_path):
    thresholds = _thresholds()
    thresholds[2] = _threshold(
        "hard_assertion_zero_failure_dup", "zero_failure", "invariant", expected_attempts=1
    )
    assert _config_error(tmp_path, thresholds=thresholds) == "duplicate_threshold_type:zero_failure"


def test_expected_reason_with_infra_code_is_gate_error(tmp_path, config_path):
    assert (
        _config_error(tmp_path, expected_not_evaluated_reasons=["infra_insufficient"])
        == "expected_reason_is_infra:infra_insufficient"
    )


def test_task_status_conflict_is_gate_error(tmp_path, config_path):
    assert (
        _config_error(tmp_path, expected_not_evaluated_task_ids=[INV_EXPECTED, INV_PASS])
        == f"task_status_conflict:{INV_PASS}"
    )


def test_cli_dispatches_v2_and_prints_snake_case(tmp_path, config_path, capsys):
    inv = _write(tmp_path / "inv.json", _invariant_report())
    beh = _write(tmp_path / "beh.json", _behavior_report())
    baseline = _write(tmp_path / "base.json", _baseline())
    code = main(
        [
            "gate",
            "--report",
            str(inv),
            "--report",
            str(beh),
            "--baseline",
            str(baseline),
            "--config",
            str(config_path),
            "--target-commit",
            COMMIT,
        ]
    )
    assert code == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload["schema_version"] == 2
    assert payload["state"] == STATE_PASS
    assert "threshold_set_version" in payload
    assert "thresholdSetVersion" not in payload


def test_cli_rejects_multiple_reports_for_v1_config(tmp_path, capsys):
    v1_config = Path(__file__).resolve().parents[2] / "evaluation" / "gate-v1.json"
    report = _write(tmp_path / "r.json", _report([], lane="invariant"))
    code = main(
        [
            "gate",
            "--report",
            str(report),
            "--report",
            str(report),
            "--config",
            str(v1_config),
            "--target-commit",
            COMMIT,
        ]
    )
    assert code == 3
    payload = json.loads(capsys.readouterr().out)
    assert payload["errorCode"] == "multiple_reports_require_gate_schema_2"
