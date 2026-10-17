"""Offline Agent evaluation suite (PLAN-0511).

First slice: versioned dataset schema + loader. The local runner (`run`/`compare`)
and the quality gate (PLAN-0512) are added in later milestones.
"""

from __future__ import annotations

from xihe_agent.evaluation.loader import (
    DATASET_VERSION,
    dataset_sha256,
    default_dataset_path,
    load_dataset,
)
from xihe_agent.evaluation.schema import DATASET_SCHEMA_VERSION, EvalTask, HardAssertion

__all__ = [
    "DATASET_SCHEMA_VERSION",
    "DATASET_VERSION",
    "EvalTask",
    "HardAssertion",
    "dataset_sha256",
    "default_dataset_path",
    "load_dataset",
]
