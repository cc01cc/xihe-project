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
    REASON_INFRA_INSUFFICIENT,
    REPORT_SCHEMA_VERSION,
    SCORER_VERSION,
    SCORER_VERSION_V1,
    STATUS_FAILED,
    STATUS_NOT_EVALUATED,
    STATUS_PASSED,
    V1_REPORT_SCHEMA_VERSION,
    AttemptReport,
    BehaviorStats,
    EvalReport,
    EvalReportV2,
    InfraAttempt,
    TaskReport,
    TaskReportV2,
    build_report,
    build_report_v2,
    evaluate_attempt,
    evaluate_task,
    evaluate_task_v2,
    summarize,
)
from xihe_agent.evaluation.runner import (
    LANES,
    CpClient,
    RunTerminal,
    run_dataset,
    run_dataset_v2,
    tool_mode_for,
)
from xihe_agent.evaluation.schema import (
    DATASET_SCHEMA_VERSION,
    SUPPORTED_DATASET_SCHEMA_VERSIONS,
    V2_SCHEMA_VERSION,
    EvalTask,
    EvalTaskV2,
    HardAssertion,
    HardAssertionV2,
)
from xihe_agent.evaluation.trace import TraceEvent, TraceResponse, derive_facts, extract_citations

__all__ = [
    "AssertionResult",
    "AttemptReport",
    "BehaviorStats",
    "BudgetDimension",
    "ComparisonReport",
    "CpClient",
    "DATASET_SCHEMA_VERSION",
    "DATASET_VERSION",
    "EvalReport",
    "EvalReportV2",
    "EvalTask",
    "EvalTaskV2",
    "HardAssertion",
    "HardAssertionV2",
    "InfraAttempt",
    "LANES",
    "REASON_INFRA_INSUFFICIENT",
    "REPORT_SCHEMA_VERSION",
    "RunFacts",
    "RunTerminal",
    "SCORER_VERSION",
    "SCORER_VERSION_V1",
    "STATUS_FAILED",
    "STATUS_NOT_EVALUATED",
    "STATUS_PASSED",
    "SUPPORTED_DATASET_SCHEMA_VERSIONS",
    "TaskDelta",
    "TaskReport",
    "TaskReportV2",
    "TraceEvent",
    "TraceResponse",
    "V1_REPORT_SCHEMA_VERSION",
    "V2_SCHEMA_VERSION",
    "build_report",
    "build_report_v2",
    "compare_reports",
    "dataset_sha256",
    "default_dataset_path",
    "derive_facts",
    "evaluate_assertion",
    "evaluate_attempt",
    "evaluate_task",
    "evaluate_task_v2",
    "extract_citations",
    "load_dataset",
    "run_dataset",
    "run_dataset_v2",
    "summarize",
    "tool_mode_for",
]
