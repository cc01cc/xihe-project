"""PLAN-0511 M1: dataset schema/loader contract tests."""

from __future__ import annotations

import pytest

from xihe_agent.evaluation import (
    DATASET_SCHEMA_VERSION,
    DATASET_VERSION,
    dataset_sha256,
    default_dataset_path,
    load_dataset,
)

EXPECTED_TASK_IDS = {
    "instruction_following.format_and_scope.v1",
    "grounded_citation.synthetic_source.v1",
    "tool_authorization.denied_mutation.v1",
    "failure_budget.no_repeat.v1",
}


def test_dataset_version_and_path() -> None:
    assert DATASET_VERSION == "v1"
    assert DATASET_SCHEMA_VERSION == 1
    assert default_dataset_path().name == "v1.jsonl"
    assert default_dataset_path().is_file()


def test_dataset_has_the_four_frozen_tasks() -> None:
    tasks = load_dataset()
    assert {t.task_id for t in tasks} == EXPECTED_TASK_IDS
    assert all(t.data_class == "synthetic" for t in tasks)


def test_every_task_has_at_least_one_hard_assertion() -> None:
    for task in load_dataset():
        assert task.hard_assertions, task.task_id
        assert all(a.kind and a.assertion_id for a in task.hard_assertions)


def test_failure_budget_pins_real_error_codes() -> None:
    task = next(t for t in load_dataset() if t.task_id == "failure_budget.no_repeat.v1")
    code = next(a for a in task.hard_assertions if a.assertion_id == "A2")
    assert code.kind == "terminal_error_code"
    assert set(code.expected["enum"]) == {"RUN_BUDGET_EXHAUSTED", "RUN_NO_PROGRESS"}


def test_denied_mutation_asserts_zero_invocation() -> None:
    task = next(t for t in load_dataset() if t.task_id == "tool_authorization.denied_mutation.v1")
    inv = next(a for a in task.hard_assertions if a.assertion_id == "A1")
    assert inv.kind == "tool_invocation_count"
    assert inv.expected["equals"] == 0


def test_sha256_is_stable_hex() -> None:
    digest = dataset_sha256()
    assert len(digest) == 64
    assert digest == dataset_sha256()


def test_duplicate_task_id_rejected(tmp_path) -> None:
    row = default_dataset_path().read_text(encoding="utf-8").splitlines()[0]
    bad = tmp_path / "bad.jsonl"
    bad.write_text(f"{row}\n{row}\n", encoding="utf-8")
    with pytest.raises(ValueError, match="duplicate taskId"):
        load_dataset(bad)


def test_bad_schema_version_rejected(tmp_path) -> None:
    bad = tmp_path / "bad.jsonl"
    bad.write_text('{"schemaVersion": 999, "taskId": "x"}\n', encoding="utf-8")
    with pytest.raises(ValueError, match="unsupported schemaVersion"):
        load_dataset(bad)
