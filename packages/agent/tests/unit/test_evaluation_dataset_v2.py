"""PLAN-0540 M1: v2 dataset schema and loader dispatch tests."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from pydantic import ValidationError

from xihe_agent.evaluation import EvalTask, EvalTaskV2, load_dataset

DATASETS = Path(__file__).resolve().parents[2] / "evaluation" / "datasets"
V1_PATH = DATASETS / "v1.jsonl"
V2_PATH = DATASETS / "v2.jsonl"


def _rows(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def test_v1_file_still_loads_with_camel_aliases() -> None:
    tasks = load_dataset(V1_PATH)
    assert len(tasks) == 4
    assert all(isinstance(task, EvalTask) for task in tasks)
    assert {task.task_id for task in tasks} == {
        "instruction_following.format_and_scope.v1",
        "grounded_citation.synthetic_source.v1",
        "tool_authorization.denied_mutation.v1",
        "failure_budget.no_repeat.v1",
    }


def test_v2_file_parses_as_v2_tasks() -> None:
    tasks = load_dataset(V2_PATH)
    assert len(tasks) == 5
    assert all(isinstance(task, EvalTaskV2) for task in tasks)
    by_id = {task.task_id: task for task in tasks}
    assert by_id["instruction_following.format_and_scope.v1"].assertion_class == "behavior"
    assert by_id["instruction_following.format_and_scope.v1"].attempts == 5
    assert by_id["grounded_citation.synthetic_source.v1"].assertion_class == "behavior"
    assert by_id["tool_authorization.denied_mutation.v1"].assertion_class == "invariant"
    assert by_id["tool_authorization.denied_mutation.v1"].attempts == 1
    assert by_id["failure_budget.no_repeat.v2"].assertion_class == "invariant"
    assert by_id["failure_budget.no_repeat.v2"].attempts == 1
    assert by_id["failure_budget.attempt_rate.v2"].assertion_class == "behavior"
    assert by_id["failure_budget.attempt_rate.v2"].attempts == 5


def test_v2_assertion_expected_keys_are_snake_case() -> None:
    by_id = {task.task_id: task for task in load_dataset(V2_PATH)}
    citation = by_id["grounded_citation.synthetic_source.v1"]
    assert citation.hard_assertions[1].expected == {"source_id": "S1"}
    assert citation.hard_assertions[2].expected == {"allowed_source_ids": ["S1"]}
    budget = by_id["failure_budget.no_repeat.v2"]
    assert budget.hard_assertions[2].expected == {"repeated_completed_mutations": 0}
    rate = by_id["failure_budget.attempt_rate.v2"]
    assert rate.hard_assertions[0].expected["at_least"] == 1


def test_v2_rejects_camel_case_row_keys(tmp_path: Path) -> None:
    row = _rows(V2_PATH)[0]
    row["hardAssertions"] = row.pop("hard_assertions")
    bad = tmp_path / "bad.jsonl"
    bad.write_text(json.dumps(row) + "\n", encoding="utf-8")
    with pytest.raises(ValidationError):
        load_dataset(bad)


def test_v2_rejects_camel_case_assertion_keys(tmp_path: Path) -> None:
    row = _rows(V2_PATH)[0]
    row["hard_assertions"][0]["assertionId"] = row["hard_assertions"][0].pop("assertion_id")
    bad = tmp_path / "bad.jsonl"
    bad.write_text(json.dumps(row) + "\n", encoding="utf-8")
    with pytest.raises(ValidationError):
        load_dataset(bad)


def test_unknown_schema_version_rejected(tmp_path: Path) -> None:
    bad = tmp_path / "bad.jsonl"
    bad.write_text('{"schema_version": 999, "task_id": "x"}\n', encoding="utf-8")
    with pytest.raises(ValueError, match="unsupported schema_version"):
        load_dataset(bad)


def test_missing_schema_version_rejected(tmp_path: Path) -> None:
    bad = tmp_path / "bad.jsonl"
    bad.write_text('{"task_id": "x"}\n', encoding="utf-8")
    with pytest.raises(ValueError, match="missing schema version"):
        load_dataset(bad)


def test_mixed_schema_styles_rejected(tmp_path: Path) -> None:
    rows = _rows(V2_PATH)
    v1_row = json.loads(V1_PATH.read_text(encoding="utf-8").splitlines()[0])
    bad = tmp_path / "mixed.jsonl"
    bad.write_text(json.dumps(rows[0]) + "\n" + json.dumps(v1_row) + "\n", encoding="utf-8")
    with pytest.raises(ValueError, match="does not match file-level schema_version"):
        load_dataset(bad)


def test_mixed_schema_versions_rejected(tmp_path: Path) -> None:
    rows = _rows(V2_PATH)
    rows[1]["schema_version"] = 1
    bad = tmp_path / "mixed.jsonl"
    bad.write_text("\n".join(json.dumps(row) for row in rows[:2]) + "\n", encoding="utf-8")
    with pytest.raises(ValueError, match="mixed schema_version"):
        load_dataset(bad)


def test_v2_duplicate_task_id_rejected(tmp_path: Path) -> None:
    row = json.dumps(_rows(V2_PATH)[0])
    bad = tmp_path / "dup.jsonl"
    bad.write_text(f"{row}\n{row}\n", encoding="utf-8")
    with pytest.raises(ValueError, match="duplicate taskId"):
        load_dataset(bad)


def test_empty_dataset_rejected(tmp_path: Path) -> None:
    bad = tmp_path / "empty.jsonl"
    bad.write_text("\n", encoding="utf-8")
    with pytest.raises(ValueError, match="dataset is empty"):
        load_dataset(bad)
