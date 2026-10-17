"""Loader and integrity helpers for the versioned evaluation dataset (PLAN-0511)."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

from xihe_agent.evaluation.schema import DATASET_SCHEMA_VERSION, EvalTask

DATASET_VERSION = "v1"


def default_dataset_path() -> Path:
    """Return the repository dataset path for the current DATASET_VERSION."""
    return Path(__file__).resolve().parents[3] / "evaluation" / "datasets" / f"{DATASET_VERSION}.jsonl"


def load_dataset(path: Path | None = None) -> list[EvalTask]:
    """Load and validate the JSONL dataset, failing closed on the first bad row."""
    dataset_path = path or default_dataset_path()
    tasks: list[EvalTask] = []
    for lineno, raw in enumerate(dataset_path.read_text(encoding="utf-8").splitlines(), start=1):
        line = raw.strip()
        if not line:
            continue
        try:
            data = json.loads(line)
        except json.JSONDecodeError as exc:
            raise ValueError(f"{dataset_path}:{lineno}: invalid JSON: {exc}") from exc
        if data.get("schemaVersion") != DATASET_SCHEMA_VERSION:
            raise ValueError(
                f"{dataset_path}:{lineno}: unsupported schemaVersion={data.get('schemaVersion')!r}, "
                f"expected {DATASET_SCHEMA_VERSION}"
            )
        tasks.append(EvalTask.model_validate(data))
    if not tasks:
        raise ValueError(f"{dataset_path}: dataset is empty")
    _assert_unique_task_ids(tasks)
    return tasks


def dataset_sha256(path: Path | None = None) -> str:
    """Return the SHA-256 of the raw dataset file (comparability fingerprint)."""
    dataset_path = path or default_dataset_path()
    return hashlib.sha256(dataset_path.read_bytes()).hexdigest()


def _assert_unique_task_ids(tasks: list[EvalTask]) -> None:
    seen: set[str] = set()
    for task in tasks:
        if task.task_id in seen:
            raise ValueError(f"duplicate taskId: {task.task_id}")
        seen.add(task.task_id)
