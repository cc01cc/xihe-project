"""PLAN-0512 gate acceptance matrix (spec/gate-contract.md)."""

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

from xihe_agent.evaluation.gate import (
    EXIT_CODES,
    STATE_FAIL,
    STATE_GATE_ERROR,
    STATE_NOT_EVALUATED,
    STATE_PASS,
    evaluate_gate,
    load_config,
    parse_duration,
)

DATASET_HASH = "a" * 64
COMMIT = "c0ffee00" + "0" * 32
EVALUATED = ["instruction_following.format_and_scope.v1", "grounded_citation.synthetic_source.v1"]
EXPECTED_NOT_EVALUATED = ["tool_authorization.denied_mutation.v1", "failure_budget.no_repeat.v1"]


def _task(task_id: str, status: str, *, assertions=None, reason=None, run_id="run-1"):
    return {
        "task_id": task_id,
        "category": task_id.split(".")[0],
        "status": status,
        "assertions": assertions or [],
        "run_id": run_id,
        "not_evaluated_reason": reason,
    }


def _passed_assertions():
    return [{"assertion_id": "A1", "kind": "json_schema", "passed": True, "detail": "ok"}]


def _report(tasks, *, created_at=None, commit=COMMIT, dataset_hash=DATASET_HASH):
    return {
        "schema_version": 1,
        "eval_run_id": "eval-test",
        "created_at": (created_at or datetime.now(UTC)).isoformat(),
        "commit": commit,
        "dataset_version": "v1",
        "dataset_hash": dataset_hash,
        "scorer_version": "v1",
        "mode": "cp-real",
        "tasks": tasks,
        "aggregate": {},
    }


def _full_tasks(failed_assertion: bool = False):
    tasks = [_task(t, "passed", assertions=_passed_assertions()) for t in EVALUATED]
    if failed_assertion:
        tasks[0]["status"] = "failed"
        tasks[0]["assertions"] = [
            {"assertion_id": "A1", "kind": "json_schema", "passed": False, "detail": "bad"}
        ]
        tasks[0]["error_code"] = "ASSERTION_FAILED"
    tasks += [_task(t, "not_evaluated", reason="no_tool_surface") for t in EXPECTED_NOT_EVALUATED]
    return tasks


@pytest.fixture()
def config_path(tmp_path: Path) -> Path:
    config = {
        "schemaVersion": 1,
        "thresholdSetVersion": "gate-test",
        "maxAge": "P14D",
        "datasetVersion": "v1",
        "datasetHash": DATASET_HASH,
        "scorerVersion": "v1",
        "mode": "cp-real",
        "requiredEvaluatedTaskIds": EVALUATED,
        "expectedNotEvaluatedTaskIds": EXPECTED_NOT_EVALUATED,
        "expectedNotEvaluatedReasons": ["no_tool_surface"],
        "thresholds": [
            {
                "metricId": "hard-assertion-zero-failure",
                "type": "zero_failure",
                "owner": "test",
                "rationale": "test",
                "source": "test",
                "repeatWindow": "test",
            },
            {
                "metricId": "not-evaluated-not-increased",
                "type": "not_evaluated_le_baseline",
                "owner": "test",
                "rationale": "test",
                "source": "test",
                "repeatWindow": "test",
            },
        ],
    }
    path = tmp_path / "gate-test.json"
    path.write_text(json.dumps(config), encoding="utf-8")
    return path


def _write(path: Path, payload) -> Path:
    path.write_text(json.dumps(payload), encoding="utf-8")
    return path


def run_gate(report_path, baseline_path, config_path, target_commit=COMMIT):
    return evaluate_gate(
        report_path=report_path,
        baseline_path=baseline_path,
        config_path=config_path,
        target_commit=target_commit,
    )


def test_matrix_pass(tmp_path, config_path):
    report = _write(tmp_path / "r.json", _report(_full_tasks()))
    baseline = _write(tmp_path / "b.json", _report(_full_tasks()))
    result = run_gate(report, baseline, config_path)
    assert result.state == STATE_PASS
    assert result.exit_code == 0
    assert result.failures == [] and result.not_evaluated == []
    assert {d.task_id for d in result.diagnostic_refs} == set(EVALUATED)


def test_matrix_fail_on_critical_assertion(tmp_path, config_path):
    report = _write(tmp_path / "r.json", _report(_full_tasks(failed_assertion=True)))
    baseline = _write(tmp_path / "b.json", _report(_full_tasks()))
    result = run_gate(report, baseline, config_path)
    assert result.state == STATE_FAIL
    assert result.exit_code == 1
    assert result.failures[0].assertion_id == "A1"
    assert result.failures[0].metric_id == "hard-assertion-zero-failure"


def test_matrix_not_evaluated_when_required_task_degrades(tmp_path, config_path):
    tasks = _full_tasks()
    tasks[0] = _task(EVALUATED[0], "not_evaluated", reason="no_tool_surface")
    report = _write(tmp_path / "r.json", _report(tasks))
    baseline = _write(tmp_path / "b.json", _report(_full_tasks()))
    result = run_gate(report, baseline, config_path)
    assert result.state == STATE_NOT_EVALUATED
    assert result.exit_code == 2


def test_matrix_fail_on_coverage_shrink_with_only_expected_tasks(tmp_path, config_path):
    tasks = _full_tasks()
    tasks.append(_task("extra.task.v1", "not_evaluated", reason="no_tool_surface"))
    report = _write(tmp_path / "r.json", _report(tasks))
    baseline = _write(tmp_path / "b.json", _report(_full_tasks()))
    result = run_gate(report, baseline, config_path)
    assert result.state == STATE_FAIL
    assert result.failures[0].error_code == "coverage_shrunk"


def test_matrix_not_evaluated_on_missing_task(tmp_path, config_path):
    tasks = [t for t in _full_tasks() if t["task_id"] != EVALUATED[0]]
    report = _write(tmp_path / "r.json", _report(tasks))
    baseline = _write(tmp_path / "b.json", _report(_full_tasks()))
    result = run_gate(report, baseline, config_path)
    assert result.state == STATE_NOT_EVALUATED
    assert result.exit_code == 2
    assert result.not_evaluated[0].reason_code == "missing_required_task"


def test_matrix_not_evaluated_on_unexpected_reason(tmp_path, config_path):
    tasks = _full_tasks()
    tasks[2] = _task(EXPECTED_NOT_EVALUATED[0], "not_evaluated", reason="EVAL_TIMEOUT")
    report = _write(tmp_path / "r.json", _report(tasks))
    baseline = _write(tmp_path / "b.json", _report(_full_tasks()))
    result = run_gate(report, baseline, config_path)
    assert result.state == STATE_NOT_EVALUATED
    assert any(n.reason_code == "EVAL_TIMEOUT" for n in result.not_evaluated)


def test_matrix_gate_error_on_missing_report(tmp_path, config_path):
    result = run_gate(tmp_path / "absent.json", None, config_path)
    assert result.state == STATE_GATE_ERROR
    assert result.exit_code == 3
    assert result.error_code == "report_unreadable"


def test_matrix_gate_error_on_v2_report_under_v1_config(tmp_path, config_path):
    report = _report(_full_tasks())
    report["schema_version"] = 2
    path = _write(tmp_path / "r.json", report)
    result = run_gate(path, None, config_path)
    assert result.state == STATE_GATE_ERROR
    assert result.error_code == "report_schema_incompatible"


def test_matrix_gate_error_on_stale_report(tmp_path, config_path):
    old = datetime.now(UTC) - timedelta(days=30)
    report = _write(tmp_path / "r.json", _report(_full_tasks(), created_at=old))
    baseline = _write(tmp_path / "b.json", _report(_full_tasks()))
    result = run_gate(report, baseline, config_path)
    assert result.state == STATE_GATE_ERROR
    assert result.error_code == "report_stale"


def test_matrix_gate_error_on_wrong_commit_and_hash(tmp_path, config_path):
    report = _write(tmp_path / "r.json", _report(_full_tasks(), commit="other"))
    result = run_gate(report, None, config_path)
    assert result.error_code == "candidate_commit_mismatch"

    bad_hash = _write(tmp_path / "r2.json", _report(_full_tasks(), dataset_hash="b" * 64))
    result2 = run_gate(bad_hash, None, config_path)
    assert result2.error_code == "dataset_hash_mismatch"


def test_matrix_gate_error_on_baseline_missing_for_threshold(tmp_path, config_path):
    report = _write(tmp_path / "r.json", _report(_full_tasks()))
    result = run_gate(report, None, config_path)
    assert result.state == STATE_GATE_ERROR
    assert result.error_code == "baseline_required_for_threshold"


def test_shipped_config_is_valid():
    config = load_config(Path(__file__).resolve().parents[2] / "evaluation" / "gate-v1.json")
    assert config.threshold_set_version == "gate-v1"
    assert parse_duration(config.max_age) > timedelta(0)
    assert all(t.source and t.owner and t.rationale and t.repeat_window for t in config.thresholds)


def _config_with(tmp_path: Path, config_path: Path, thresholds) -> Path:
    config = json.loads(config_path.read_text(encoding="utf-8"))
    config["thresholds"] = thresholds
    path = tmp_path / "gate-variant.json"
    path.write_text(json.dumps(config), encoding="utf-8")
    return path


def _threshold(metric_id: str, type_name: str) -> dict:
    return {
        "metricId": metric_id,
        "type": type_name,
        "owner": "test",
        "rationale": "test",
        "source": "test",
        "repeatWindow": "test",
    }


def test_unknown_threshold_type_is_gate_error(tmp_path, config_path):
    variant = _config_with(tmp_path, config_path, [_threshold("mystery", "mystery_type")])
    report = _write(tmp_path / "r.json", _report(_full_tasks()))
    result = run_gate(report, None, variant)
    assert result.state == STATE_GATE_ERROR
    assert result.error_code == "unknown_threshold_type:mystery_type"


def test_behavior_rate_min_on_v1_report_is_gate_error(tmp_path, config_path):
    variant = _config_with(tmp_path, config_path, [_threshold("behavior_rate_min", "behavior_rate_min")])
    report = _write(tmp_path / "r.json", _report(_full_tasks()))
    result = run_gate(report, None, variant)
    assert result.state == STATE_GATE_ERROR
    assert result.error_code == "threshold_type_requires_report_schema_2"


def test_failed_task_without_zero_failure_threshold_is_gate_error(tmp_path, config_path):
    variant = _config_with(
        tmp_path, config_path, [_threshold("not-evaluated-not-increased", "not_evaluated_le_baseline")]
    )
    report = _write(tmp_path / "r.json", _report(_full_tasks(failed_assertion=True)))
    baseline = _write(tmp_path / "b.json", _report(_full_tasks()))
    result = run_gate(report, baseline, variant)
    assert result.state == STATE_GATE_ERROR
    assert result.error_code == "zero_failure_threshold_missing"


def test_zero_failure_fails_failed_task_without_assertions(tmp_path, config_path):
    tasks = _full_tasks()
    tasks[0]["status"] = "failed"
    tasks[0]["assertions"] = []
    report = _write(tmp_path / "r.json", _report(tasks))
    baseline = _write(tmp_path / "b.json", _report(_full_tasks()))
    result = run_gate(report, baseline, config_path)
    assert result.state == STATE_FAIL
    assert result.failures[0].task_id == EVALUATED[0]
    assert result.failures[0].assertion_id is None


def test_machine_output_uses_camel_case_aliases(tmp_path, config_path):
    report = _write(tmp_path / "r.json", _report(_full_tasks()))
    baseline = _write(tmp_path / "b.json", _report(_full_tasks()))
    dumped = run_gate(report, baseline, config_path).model_dump(by_alias=True)
    assert {"schemaVersion", "exitCode", "candidateCommit", "thresholdSetVersion"} <= set(dumped)
    assert "notEvaluated" in dumped and "diagnosticRefs" in dumped


def test_exit_codes_frozen():
    assert EXIT_CODES == {STATE_PASS: 0, STATE_FAIL: 1, STATE_NOT_EVALUATED: 2, STATE_GATE_ERROR: 3}
