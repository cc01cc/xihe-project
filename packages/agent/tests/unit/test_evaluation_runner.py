"""PLAN-0511 M2: trace-derived facts and v1 runner orchestration tests (offline)."""

from __future__ import annotations

from pathlib import Path

from xihe_agent.evaluation import (
    BudgetDimension,
    RunTerminal,
    TraceResponse,
    derive_facts,
    extract_citations,
    load_dataset,
    run_dataset,
)
from xihe_agent.evaluation.report import STATUS_NOT_EVALUATED, STATUS_PASSED
from xihe_agent.evaluation.runner import tool_mode_for

V1_PATH = Path(__file__).resolve().parents[2] / "evaluation" / "datasets" / "v1.jsonl"
V1_TASKS = load_dataset(V1_PATH)


def _trace(events: list[dict]) -> TraceResponse:
    return TraceResponse.model_validate({"runId": "run-1", "completeness": "complete", "events": events})


def test_extract_citations() -> None:
    assert extract_citations("Answer [S1] and [S2].") == ["S1", "S2"]
    assert extract_citations(None) == []
    assert extract_citations("no citations here") == []


def test_derive_facts_counts_invocations_and_repeats() -> None:
    trace = _trace(
        [
            {"eventId": "e1", "source": "mcp_invocation", "kind": "mcp.invocation", "status": "succeeded", "toolName": "apply_patch"},
            {"eventId": "e2", "source": "mcp_invocation", "kind": "mcp.invocation", "status": "succeeded", "toolName": "apply_patch"},
            {"eventId": "e3", "source": "context_event", "kind": "context.source", "status": "resolved"},
        ]
    )
    facts = derive_facts(run_id="run-1", run_status="failed", trace=trace, final_output_text="[S1] done")
    assert facts.tool_invocation_count == 2
    assert facts.completed_mutations == 2
    assert facts.repeated_mutations == 1
    assert facts.citations == ["S1"]
    assert facts.trace_available is True


def test_derive_facts_reads_terminal_error_code_from_lifecycle() -> None:
    trace = _trace(
        [{"eventId": "e1", "source": "chat_run", "kind": "run.lifecycle", "status": "failed", "errorCode": "RUN_BUDGET_EXHAUSTED"}]
    )
    facts = derive_facts(run_id="run-1", run_status="failed", trace=trace, final_output_text=None)
    assert facts.terminal_error_code == "RUN_BUDGET_EXHAUSTED"


def test_derive_facts_without_trace_is_not_evaluated_source() -> None:
    facts = derive_facts(run_id="run-1", run_status="completed", trace=None, final_output_text="x")
    assert facts.trace_available is False


class _FakeCpClient:
    """Minimal CP stand-in returning scripted terminal outcomes and traces."""

    def __init__(self, outputs: dict[str, str]) -> None:
        self._outputs = outputs
        self.counter = 0

    def create_session(self) -> str:
        self.counter += 1
        return f"sess-{self.counter}"

    def create_branch(self, session_id: str) -> str:
        return f"branch-{session_id}"

    def create_run(self, *, session_id, branch_id, content, provider, model, tool_mode, idempotency_key) -> str:
        return f"run-{session_id}"

    def wait_terminal(self, run_id: str, timeout_s: float) -> RunTerminal:
        return RunTerminal(status="completed", duration_ms=123)

    def get_trace(self, run_id: str) -> TraceResponse:
        return _trace([])

    def read_final_output(self, session_id: str, run_id: str) -> str | None:
        # sess-N maps to the Nth task in dataset order
        tasks = V1_TASKS
        idx = int(session_id.split("-")[1]) - 1
        return self._outputs.get(tasks[idx].task_id)


def test_tool_mode_mapping() -> None:
    assert tool_mode_for("instruction_following") == "none"
    assert tool_mode_for("tool_authorization") == "workspace"


def test_run_dataset_produces_report() -> None:
    tasks = V1_TASKS
    outputs = {
        "instruction_following.format_and_scope.v1": '{"name": "widget", "ok": true}',
        "grounded_citation.synthetic_source.v1": "Freedonia's capital is Veridian. [S1]",
        "tool_authorization.denied_mutation.v1": "I cannot perform that mutation.",
        "failure_budget.no_repeat.v1": "Stopped due to repeated failures.",
    }
    client = _FakeCpClient(outputs)
    report = run_dataset(
        client,
        tasks,
        eval_run_id="eval-1",
        commit="deadbeef",
        dataset_version="v1",
        dataset_hash="hash1",
        provider="xiaomi",
        model="mimo",
    )
    assert report.mode == "cp-real"
    assert len(report.tasks) == 4
    # tool-less tasks with conforming output pass; others fail or are not-evaluated
    by_id = {t.task_id: t for t in report.tasks}
    assert by_id["instruction_following.format_and_scope.v1"].status == STATUS_PASSED


def test_run_dataset_missing_trace_is_not_evaluated() -> None:
    class _NoTraceClient(_FakeCpClient):
        def get_trace(self, run_id: str) -> TraceResponse:
            raise ValueError("trace unavailable")

    tasks = V1_TASKS[:1]
    report = run_dataset(
        _NoTraceClient({}),
        tasks,
        eval_run_id="eval-2",
        commit="c",
        dataset_version="v1",
        dataset_hash="h",
    )
    assert report.tasks[0].status == STATUS_NOT_EVALUATED


def test_tool_categories_not_evaluated_without_tool_surface() -> None:
    class _NoTraceClient(_FakeCpClient):
        def get_trace(self, run_id: str) -> TraceResponse:
            raise ValueError("trace unavailable")

    report = run_dataset(
        _NoTraceClient({}),
        V1_TASKS,
        eval_run_id="eval-3",
        commit="c",
        dataset_version="v1",
        dataset_hash="h",
        tool_surface_enabled=False,
    )
    tool_reports = [t for t in report.tasks if t.category in {"tool_authorization", "failure_budget"}]
    assert len(tool_reports) == 2
    assert all(t.status == STATUS_NOT_EVALUATED for t in tool_reports)
    assert all(t.not_evaluated_reason == "no_tool_surface" for t in tool_reports)


def test_tool_authorization_deferred_reason_when_surface_enabled() -> None:
    """PLAN-0532 D1-C1: the denied-mutation task keeps an explicit reason."""

    class _NoTraceClient(_FakeCpClient):
        def get_trace(self, run_id: str) -> TraceResponse:
            raise ValueError("trace unavailable")

        def read_final_output(self, session_id: str, run_id: str) -> str | None:
            return None

    report = run_dataset(
        _NoTraceClient({}),
        V1_TASKS,
        eval_run_id="eval-4",
        commit="c",
        dataset_version="v1",
        dataset_hash="h",
        tool_surface_enabled=True,
    )
    by_id = {t.task_id: t for t in report.tasks}
    deferred = by_id["tool_authorization.denied_mutation.v1"]
    assert deferred.status == STATUS_NOT_EVALUATED
    assert deferred.not_evaluated_reason == "no_denial_observability"
    # The budget task still executes: its not_evaluated reason comes from the
    # missing trace, never from the tool-surface skip.
    budget = by_id["failure_budget.no_repeat.v1"]
    assert budget.not_evaluated_reason == "missing_trace"


def test_budget_dimension_used() -> None:
    dim = BudgetDimension(limit=3, used=3)
    assert dim.used == dim.limit
