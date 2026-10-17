"""Offline Agent evaluation suite (PLAN-0511).

Implemented: versioned dataset schema + loader, deterministic hard-assertion
evaluators, content-free report models and a report comparator.
Pending (later milestones): the `cp-real` runner (needs a live local CP and
Provider credentials) and the quality gate (PLAN-0512).
"""

from __future__ import annotations

from xihe_agent.evaluation.compare import ComparisonReport, TaskDelta, compare_reports
from xihe_agent.evaluation.evaluator import AssertionResult, evaluate_assertion
from xihe_agent.evaluation.facts import BudgetDimension, RunFacts
from xihe_agent.evaluation.loader import (
    DATASET_VERSION,
    dataset_sha256,
    default_dataset_path,
    load_dataset,
)
from xihe_agent.evaluation.report import (
    REPORT_SCHEMA_VERSION,
    SCORER_VERSION,
    STATUS_FAILED,
    STATUS_NOT_EVALUATED,
    STATUS_PASSED,
    EvalReport,
    TaskReport,
    build_report,
    evaluate_task,
    summarize,
)
from xihe_agent.evaluation.schema import DATASET_SCHEMA_VERSION, EvalTask, HardAssertion

__all__ = [
    "AssertionResult",
    "BudgetDimension",
    "ComparisonReport",
    "DATASET_SCHEMA_VERSION",
    "DATASET_VERSION",
    "EvalReport",
    "EvalTask",
    "HardAssertion",
    "REPORT_SCHEMA_VERSION",
    "RunFacts",
    "SCORER_VERSION",
    "STATUS_FAILED",
    "STATUS_NOT_EVALUATED",
    "STATUS_PASSED",
    "TaskDelta",
    "TaskReport",
    "build_report",
    "compare_reports",
    "dataset_sha256",
    "default_dataset_path",
    "evaluate_assertion",
    "evaluate_task",
    "load_dataset",
    "summarize",
]
