"""Loader and integrity helpers for the versioned evaluation dataset (PLAN-0511).

PLAN-0540 adds v2: the file-level `schema_version` selects the row model, and a
file may not mix v1 camelCase rows with v2 snake_case rows.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

from xihe_agent.evaluation.schema import (
    SUPPORTED_DATASET_SCHEMA_VERSIONS,
    EvalTask,
    EvalTaskLike,
    EvalTaskV2,
)

DATASET_VERSION = "v2"

_ROW_MODELS: dict[int, type[EvalTask] | type[EvalTaskV2]] = {1: EvalTask, 2: EvalTaskV2}
_VERSION_KEY = {1: "schemaVersion", 2: "schema_version"}


def default_dataset_path() -> Path:
    """Return the repository dataset path for the current DATASET_VERSION."""
    return Path(__file__).resolve().parents[3] / "evaluation" / "datasets" / f"{DATASET_VERSION}.jsonl"


def _row_version(data: dict[str, Any], *, dataset_path: Path, lineno: int) -> int:
    """Read the schema version from one row, accepting either file style."""
    for key in _VERSION_KEY.values():
        if key in data:
            value = data[key]
            if not isinstance(value, int) or isinstance(value, bool):
                raise ValueError(f"{dataset_path}:{lineno}: invalid schema version {value!r}")
            return value
    raise ValueError(f"{dataset_path}:{lineno}: missing schema version field")


def load_dataset(path: Path | None = None) -> list[EvalTaskLike]:
    """Load and validate the JSONL dataset, dispatching on the file-level version."""
    dataset_path = path or default_dataset_path()
    rows: list[tuple[int, dict[str, Any]]] = []
    for lineno, raw in enumerate(dataset_path.read_text(encoding="utf-8").splitlines(), start=1):
        line = raw.strip()
        if not line:
            continue
        try:
            data = json.loads(line)
        except json.JSONDecodeError as exc:
            raise ValueError(f"{dataset_path}:{lineno}: invalid JSON: {exc}") from exc
        if not isinstance(data, dict):
            raise ValueError(f"{dataset_path}:{lineno}: dataset row is not a JSON object")
        rows.append((lineno, data))
    if not rows:
        raise ValueError(f"{dataset_path}: dataset is empty")

    version = _row_version(rows[0][1], dataset_path=dataset_path, lineno=rows[0][0])
    if version not in SUPPORTED_DATASET_SCHEMA_VERSIONS:
        raise ValueError(
            f"{dataset_path}:{rows[0][0]}: unsupported schema_version={version!r}, "
            f"supported {SUPPORTED_DATASET_SCHEMA_VERSIONS}"
        )
    model = _ROW_MODELS[version]
    version_key = _VERSION_KEY[version]
    tasks: list[EvalTaskLike] = []
    for lineno, data in rows:
        if version_key not in data:
            raise ValueError(
                f"{dataset_path}:{lineno}: row does not match file-level schema_version={version}"
            )
        if data[version_key] != version:
            raise ValueError(
                f"{dataset_path}:{lineno}: mixed schema_version={data[version_key]!r} "
                f"in a schema_version={version} file"
            )
        tasks.append(model.model_validate(data))
    _assert_unique_task_ids(tasks)
    return tasks


def dataset_sha256(path: Path | None = None) -> str:
    """Return the SHA-256 of the raw dataset file (comparability fingerprint)."""
    dataset_path = path or default_dataset_path()
    return hashlib.sha256(dataset_path.read_bytes()).hexdigest()


def _assert_unique_task_ids(tasks: list[EvalTaskLike]) -> None:
    seen: set[str] = set()
    for task in tasks:
        if task.task_id in seen:
            raise ValueError(f"duplicate taskId: {task.task_id}")
        seen.add(task.task_id)
