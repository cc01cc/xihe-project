"""PLAN-0540 M2: v2 lane runner, attempt isolation and error classification tests."""

from __future__ import annotations

from pathlib import Path

import httpx
import pytest

from xihe_agent.evaluation import (
    REASON_INFRA_INSUFFICIENT,
    RunTerminal,
    TraceResponse,
    load_dataset,
    run_dataset_v2,
)
from xihe_agent.evaluation.report import STATUS_FAILED, STATUS_NOT_EVALUATED, STATUS_PASSED

V2_PATH = Path(__file__).resolve().parents[2] / "evaluation" / "datasets" / "v2.jsonl"
TASKS = load_dataset(V2_PATH)
BY_ID = {task.task_id: task for task in TASKS}

_OUTPUTS = {
    "instruction_following.format_and_scope.v1": '{"name": "widget", "ok": true}',
    "grounded_citation.synthetic_source.v1": "Freedonia's capital is Veridian. [S1]",
}
_FAILING_TOOL_EVENT = {
    "eventId": "e1",
    "source": "mcp_invocation",
    "kind": "mcp.invocation",
    "status": "succeeded",
    "toolName": "always_failing",
}


class _ScriptedClient:
    """CP stand-in with per-task scripted terminals and failures."""

    def __init__(self, script: dict[str, list[object]] | None = None, *, traces: bool = True) -> None:
        self._script = {key: list(values) for key, values in (script or {}).items()}
        self._traces = traces
        self.sessions: list[str] = []
        self.run_ids: list[str] = []
        self._task_by_run: dict[str, str] = {}
        self._run_seq = 0

    def create_session(self) -> str:
        session_id = f"sess-{len(self.sessions) + 1}"
        self.sessions.append(session_id)
        return session_id

    def create_branch(self, session_id: str) -> str:
        return f"branch-{session_id}"

    def _task_id(self, idempotency_key: str) -> str:
        return idempotency_key.split(":attempt-")[0].rsplit(":", 1)[-1]

    def create_run(self, *, session_id, branch_id, content, provider, model, tool_mode, idempotency_key) -> str:
        self._run_seq += 1
        run_id = f"run-{self._run_seq}"
        self.run_ids.append(run_id)
        self._task_by_run[run_id] = self._task_id(idempotency_key)
        return run_id

    def wait_terminal(self, run_id: str, timeout_s: float) -> RunTerminal:
        task_id = self._task_by_run[run_id]
        queue = self._script.get(task_id)
        outcome = queue.pop(0) if queue else RunTerminal(status="completed", duration_ms=10)
        if isinstance(outcome, BaseException):
            raise outcome
        return outcome

    def get_trace(self, run_id: str) -> TraceResponse:
        if not self._traces:
            raise ValueError("trace unavailable")
        task_id = self._task_by_run[run_id]
        events = [_FAILING_TOOL_EVENT] if task_id == "failure_budget.attempt_rate.v2" else []
        return TraceResponse.model_validate({"runId": run_id, "completeness": "complete", "events": events})

    def read_final_output(self, session_id: str, run_id: str) -> str | None:
        return _OUTPUTS.get(self._task_by_run[run_id])


def _run(tasks, *, script=None, **kwargs):
    params = {
        "eval_run_id": "eval-1",
        "commit": "deadbeef",
        "dataset_version": "v2",
        "dataset_hash": "hash1",
    }
    params.update(kwargs)
    return run_dataset_v2(_ScriptedClient(script), tasks, **params)


def test_lane_filters_tasks_and_sets_report_identity() -> None:
    client = _ScriptedClient(
        {"failure_budget.no_repeat.v2": [RunTerminal(status="failed", error_code="RUN_BUDGET_EXHAUSTED")]}
    )
    report = run_dataset_v2(
        client,
        TASKS,
        lane="invariant",
        eval_run_id="eval-1",
        commit="deadbeef",
        dataset_version="v2",
        dataset_hash="hash1",
        tool_surface_enabled=True,
    )
    assert report.schema_version == 2
    assert report.scorer_version == "v2"
    assert report.lane == "invariant"
    by_id = {task.task_id: task for task in report.tasks}
    assert set(by_id) == {"tool_authorization.denied_mutation.v1", "failure_budget.no_repeat.v2"}
    assert by_id["tool_authorization.denied_mutation.v1"].not_evaluated_reason == "no_denial_observability"
    assert by_id["failure_budget.no_repeat.v2"].status == STATUS_PASSED


def test_behavior_lane_runs_one_task_per_attempt_in_isolated_sessions() -> None:
    client = _ScriptedClient()
    report = run_dataset_v2(
        client,
        [BY_ID["failure_budget.attempt_rate.v2"]],
        lane="behavior",
        eval_run_id="eval-1",
        commit="deadbeef",
        dataset_version="v2",
        dataset_hash="hash1",
        attempts_override=3,
        min_valid_attempts=3,
        tool_surface_enabled=True,
    )
    task = report.tasks[0]
    assert task.attempts_planned == 3
    assert len(task.attempts) == 3
    assert task.status == STATUS_PASSED
    assert task.behavior_stats is not None
    assert task.behavior_stats.rate == 1.0
    assert len(client.sessions) == 3
    assert len(set(client.sessions)) == 3


def test_attempts_override_rejected_for_invariant_lane() -> None:
    with pytest.raises(ValueError, match="only valid for the behavior lane"):
        _run(TASKS, lane="invariant", attempts_override=2)


def test_unknown_lane_rejected() -> None:
    with pytest.raises(ValueError, match="unknown lane"):
        _run(TASKS, lane="flaky")


def test_v1_dataset_rejected() -> None:
    from xihe_agent.evaluation import load_dataset as load

    v1 = load(Path(__file__).resolve().parents[2] / "evaluation" / "datasets" / "v1.jsonl")
    with pytest.raises(ValueError, match="v2 dataset"):
        _run(v1, lane="invariant")


def test_connection_error_is_infra_and_batch_continues() -> None:
    client = _ScriptedClient(
        {
            "instruction_following.format_and_scope.v1": [
                httpx.ConnectError("boom"),
                RunTerminal(status="completed", duration_ms=10),
            ]
        },
    )
    report = run_dataset_v2(
        client,
        [BY_ID["instruction_following.format_and_scope.v1"], BY_ID["grounded_citation.synthetic_source.v1"]],
        lane="behavior",
        eval_run_id="eval-1",
        commit="deadbeef",
        dataset_version="v2",
        dataset_hash="hash1",
        attempts_override=2,
        min_valid_attempts=1,
        tool_surface_enabled=True,
    )
    by_id = {task.task_id: task for task in report.tasks}
    assert by_id["instruction_following.format_and_scope.v1"].status == STATUS_PASSED
    assert by_id["instruction_following.format_and_scope.v1"].behavior_stats.infra_failures == 1
    assert by_id["instruction_following.format_and_scope.v1"].infra_attempts[0].reason == "connection_error"
    assert by_id["grounded_citation.synthetic_source.v1"].status == STATUS_PASSED


def test_credential_error_is_infra() -> None:
    request = httpx.Request("GET", "http://cp/api/v1/chat/runs/run-1")
    unauthorized = httpx.HTTPStatusError(
        "unauthorized", request=request, response=httpx.Response(401, request=request)
    )
    client = _ScriptedClient({"instruction_following.format_and_scope.v1": [unauthorized]})
    report = run_dataset_v2(
        client,
        [BY_ID["instruction_following.format_and_scope.v1"]],
        lane="behavior",
        eval_run_id="eval-1",
        commit="deadbeef",
        dataset_version="v2",
        dataset_hash="hash1",
        attempts_override=1,
        min_valid_attempts=1,
        tool_surface_enabled=True,
    )
    task = report.tasks[0]
    assert task.status == STATUS_NOT_EVALUATED
    assert task.not_evaluated_reason == REASON_INFRA_INSUFFICIENT
    assert task.infra_attempts[0].reason == "credential_error"


def test_timeout_is_failed_attempt() -> None:
    client = _ScriptedClient(
        {"failure_budget.no_repeat.v2": [RunTerminal(status="timeout", error_code="EVAL_TIMEOUT")]}
    )
    report = run_dataset_v2(
        client,
        [BY_ID["failure_budget.no_repeat.v2"]],
        lane="invariant",
        eval_run_id="eval-1",
        commit="deadbeef",
        dataset_version="v2",
        dataset_hash="hash1",
        tool_surface_enabled=True,
    )
    task = report.tasks[0]
    assert task.status == STATUS_FAILED
    assert task.attempts[0].status == STATUS_FAILED
    assert task.attempts[0].error_code == "EVAL_TIMEOUT"


def test_missing_trace_is_infra() -> None:
    client = _ScriptedClient({"failure_budget.attempt_rate.v2": [RunTerminal(status="completed")]}, traces=False)
    report = run_dataset_v2(
        client,
        [BY_ID["failure_budget.attempt_rate.v2"]],
        lane="behavior",
        eval_run_id="eval-1",
        commit="deadbeef",
        dataset_version="v2",
        dataset_hash="hash1",
        attempts_override=5,
        min_valid_attempts=3,
        tool_surface_enabled=True,
    )
    task = report.tasks[0]
    assert task.status == STATUS_NOT_EVALUATED
    assert task.not_evaluated_reason == REASON_INFRA_INSUFFICIENT
    assert task.behavior_stats.infra_failures == 5
    assert all(attempt.error_code == "missing_trace" for attempt in task.attempts)


def test_missing_tool_surface_skips_without_running() -> None:
    client = _ScriptedClient()
    report = run_dataset_v2(
        client,
        [BY_ID["failure_budget.attempt_rate.v2"]],
        lane="behavior",
        eval_run_id="eval-1",
        commit="deadbeef",
        dataset_version="v2",
        dataset_hash="hash1",
        tool_surface_enabled=False,
    )
    task = report.tasks[0]
    assert task.status == STATUS_NOT_EVALUATED
    assert task.not_evaluated_reason == "no_tool_surface"
    assert task.attempts == []
    assert task.attempts_planned == 5
    assert client.sessions == []
