"""PLAN-0511 M1: v1 dataset schema/loader contract tests (v1 is frozen)."""

from __future__ import annotations

from pathlib import Path

import pytest

from xihe_agent.evaluation import (
    DATASET_SCHEMA_VERSION,
    DATASET_VERSION,
    dataset_sha256,
    default_dataset_path,
    load_dataset,
)

V1_PATH = Path(__file__).resolve().parents[2] / "evaluation" / "datasets" / "v1.jsonl"

EXPECTED_TASK_IDS = {
    "instruction_following.format_and_scope.v1",
    "grounded_citation.synthetic_source.v1",
    "tool_authorization.denied_mutation.v1",
    "failure_budget.no_repeat.v1",
}


def test_dataset_version_and_path() -> None:
    assert DATASET_VERSION == "v2"
    assert DATASET_SCHEMA_VERSION == 2
    assert default_dataset_path().name == "v2.jsonl"
    assert default_dataset_path().is_file()
    assert V1_PATH.is_file()


def test_v1_dataset_has_the_four_frozen_tasks() -> None:
    tasks = load_dataset(V1_PATH)
    assert {t.task_id for t in tasks} == EXPECTED_TASK_IDS
    assert all(t.data_class == "synthetic" for t in tasks)


def test_every_v1_task_has_at_least_one_hard_assertion() -> None:
    for task in load_dataset(V1_PATH):
        assert task.hard_assertions, task.task_id
        assert all(a.kind and a.assertion_id for a in task.hard_assertions)


def test_failure_budget_pins_real_error_codes() -> None:
    task = next(t for t in load_dataset(V1_PATH) if t.task_id == "failure_budget.no_repeat.v1")
    code = next(a for a in task.hard_assertions if a.assertion_id == "A2")
    assert code.kind == "terminal_error_code"
    assert set(code.expected["enum"]) == {"RUN_BUDGET_EXHAUSTED", "RUN_NO_PROGRESS"}


def test_denied_mutation_asserts_zero_invocation() -> None:
    task = next(t for t in load_dataset(V1_PATH) if t.task_id == "tool_authorization.denied_mutation.v1")
    inv = next(a for a in task.hard_assertions if a.assertion_id == "A1")
    assert inv.kind == "tool_invocation_count"
    assert inv.expected["equals"] == 0


def test_sha256_is_stable_hex() -> None:
    digest = dataset_sha256()
    assert len(digest) == 64
    assert digest == dataset_sha256()


def test_duplicate_task_id_rejected(tmp_path) -> None:
    row = V1_PATH.read_text(encoding="utf-8").splitlines()[0]
    bad = tmp_path / "bad.jsonl"
    bad.write_text(f"{row}\n{row}\n", encoding="utf-8")
    with pytest.raises(ValueError, match="duplicate taskId"):
        load_dataset(bad)


def test_bad_schema_version_rejected(tmp_path) -> None:
    bad = tmp_path / "bad.jsonl"
    bad.write_text('{"schemaVersion": 999, "taskId": "x"}\n', encoding="utf-8")
    with pytest.raises(ValueError, match="unsupported schema_version"):
        load_dataset(bad)
