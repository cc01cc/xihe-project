"""Dataset runner orchestration for the offline evaluation suite (PLAN-0511 M2).

The runner drives each task through the CP public Chat API as a real ChatRun,
waits for the terminal state, reads the PLAN-0509 trace, derives content-free
facts and evaluates the task. The CP transport is abstracted behind `CpClient`
so the orchestration is unit-testable without a live stack.
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Protocol

import httpx
from pydantic import BaseModel, ConfigDict

from xihe_agent.evaluation.report import (
    STATUS_NOT_EVALUATED,
    AttemptReport,
    EvalReport,
    EvalReportV2,
    TaskReport,
    TaskReportV2,
    build_report,
    build_report_v2,
    evaluate_attempt,
    evaluate_task,
    evaluate_task_v2,
)
from xihe_agent.evaluation.schema import EvalTask, EvalTaskV2
from xihe_agent.evaluation.trace import TraceResponse, derive_facts

# Categories that require workspace tools (host-mode only); others run tool-less.
WORKSPACE_CATEGORIES = {"tool_authorization", "failure_budget"}

# Categories that stay not_evaluated even when a tool surface exists, with a
# category-specific reason. PLAN-0532 D1-C1: the denied-mutation task cannot be
# proven with the current observation surface (a denied agent call already opens
# an invocation row before the grant gate, and the refusal is audit-log only), so
# v1 keeps it not_evaluated with an explicit reason instead of pretending it ran.
DEFERRED_CATEGORIES = {"tool_authorization": "no_denial_observability"}


class RunTerminal(BaseModel):
    """Terminal outcome of a ChatRun."""

    model_config = ConfigDict(extra="forbid")

    status: str
    error_code: str | None = None
    duration_ms: int | None = None


class CpClient(Protocol):
    """Transport abstraction over the CP public Chat API for one authenticated user."""

    def create_session(self) -> str: ...

    def create_branch(self, session_id: str) -> str: ...

    def create_run(
        self,
        *,
        session_id: str,
        branch_id: str,
        content: str,
        provider: str | None,
        model: str | None,
        tool_mode: str,
        idempotency_key: str,
    ) -> str: ...

    def wait_terminal(self, run_id: str, timeout_s: float) -> RunTerminal: ...

    def get_trace(self, run_id: str) -> TraceResponse: ...

    def read_final_output(self, session_id: str, run_id: str) -> str | None: ...


def _task_content(task: EvalTask | EvalTaskV2) -> str:
    """Compose the model input: synthetic context fixture first, then the instruction."""
    parts: list[str] = []
    fixture = task.context_fixture or {}
    sources = fixture.get("sources")
    if isinstance(sources, list) and sources:
        lines = ["Provided sources:"]
        for source in sources:
            if isinstance(source, dict):
                lines.append(f"[{source.get('id')}] {source.get('text')}")
        parts.append("\n".join(lines))
    messages = task.input.messages
    if messages:
        content = messages[-1].get("content")
        if isinstance(content, str):
            parts.append(content)
    return "\n\n".join(parts)


def tool_mode_for(category: str) -> str:
    return "workspace" if category in WORKSPACE_CATEGORIES else "none"


def run_dataset(
    client: CpClient,
    tasks: Sequence[EvalTask | EvalTaskV2],
    *,
    eval_run_id: str,
    commit: str,
    dataset_version: str,
    dataset_hash: str,
    provider: str | None = None,
    model: str | None = None,
    prompt_version: str | None = None,
    timeout_s: float = 120.0,
    tool_surface_enabled: bool = False,
) -> EvalReport:
    """Run every task as a real ChatRun and assemble a content-free report.

    Tool-requiring categories are reported `not_evaluated(no_tool_surface)` while
    no synthetic tool surface exists, instead of being trivially satisfied by an
    empty tool set (see 0511 review/round-15.md B2). When a tool surface is
    enabled, categories listed in DEFERRED_CATEGORIES keep their own explicit
    `not_evaluated` reason (PLAN-0532 D1-C1) instead of being executed.
    """
    task_reports: list[TaskReport] = []
    for task in tasks:
        reason: str | None = None
        if task.category in WORKSPACE_CATEGORIES and not tool_surface_enabled:
            reason = "no_tool_surface"
        elif task.category in DEFERRED_CATEGORIES:
            reason = DEFERRED_CATEGORIES[task.category]
        if reason:
            task_reports.append(
                TaskReport(
                    task_id=task.task_id,
                    category=task.category,
                    status=STATUS_NOT_EVALUATED,
                    not_evaluated_reason=reason,
                )
            )
            continue
        session_id = client.create_session()
        branch_id = client.create_branch(session_id)
        run_id = client.create_run(
            session_id=session_id,
            branch_id=branch_id,
            content=_task_content(task),
            provider=provider,
            model=model,
            tool_mode=tool_mode_for(task.category),
            idempotency_key=f"{eval_run_id}:{task.task_id}",
        )
        terminal = client.wait_terminal(run_id, timeout_s)
        try:
            trace: TraceResponse | None = client.get_trace(run_id)
        except (RuntimeError, ValueError):
            trace = None
        final_output = client.read_final_output(session_id, run_id)
        facts = derive_facts(
            run_id=run_id,
            run_status=terminal.status,
            trace=trace,
            final_output_text=final_output,
            run_error_code=terminal.error_code,
            duration_ms=terminal.duration_ms,
        )
        task_reports.append(evaluate_task(task, facts))
    return build_report(
        eval_run_id=eval_run_id,
        commit=commit,
        dataset_version=dataset_version,
        dataset_hash=dataset_hash,
        mode="cp-real",
        task_reports=task_reports,
        provider=provider,
        model=model,
        prompt_version=prompt_version,
    )


LANES = {"invariant", "behavior"}


def _classify_attempt_error(exc: BaseException) -> str:
    """Map a transport/runtime exception to a stable infra reason code."""
    if isinstance(exc, httpx.HTTPStatusError):
        status = exc.response.status_code
        return "credential_error" if status in {401, 403} else f"http_{status}"
    if isinstance(exc, httpx.RequestError):
        return "connection_error"
    if isinstance(exc, OSError):
        return "connection_error"
    return "runner_error"


def _run_attempt(
    client: CpClient,
    task: EvalTaskV2,
    *,
    eval_run_id: str,
    attempt_index: int,
    provider: str | None,
    model: str | None,
    timeout_s: float,
) -> AttemptReport:
    """Drive one independent session/run; never raise out of a single attempt."""
    try:
        session_id = client.create_session()
        branch_id = client.create_branch(session_id)
        run_id = client.create_run(
            session_id=session_id,
            branch_id=branch_id,
            content=_task_content(task),
            provider=provider,
            model=model,
            tool_mode=tool_mode_for(task.category),
            idempotency_key=f"{eval_run_id}:{task.task_id}:attempt-{attempt_index}",
        )
        terminal = client.wait_terminal(run_id, timeout_s)
        try:
            trace: TraceResponse | None = client.get_trace(run_id)
        except (RuntimeError, ValueError, httpx.HTTPError):
            trace = None
        final_output = client.read_final_output(session_id, run_id)
        facts = derive_facts(
            run_id=run_id,
            run_status=terminal.status,
            trace=trace,
            final_output_text=final_output,
            run_error_code=terminal.error_code,
            duration_ms=terminal.duration_ms,
        )
        return evaluate_attempt(task, facts)
    except Exception as exc:  # one failed attempt must not abort the lane
        return AttemptReport(status=STATUS_NOT_EVALUATED, error_code=_classify_attempt_error(exc))


def _skipped_task_report(task: EvalTaskV2, *, planned: int, reason: str) -> TaskReportV2:
    return TaskReportV2(
        task_id=task.task_id,
        category=task.category,
        assertion_class=task.assertion_class,
        status=STATUS_NOT_EVALUATED,
        attempts_planned=planned,
        not_evaluated_reason=reason,
    )


def run_dataset_v2(
    client: CpClient,
    tasks: Sequence[EvalTaskV2],
    *,
    lane: str,
    eval_run_id: str,
    commit: str,
    dataset_version: str,
    dataset_hash: str,
    min_valid_attempts: int = 3,
    attempts_override: int | None = None,
    provider: str | None = None,
    model: str | None = None,
    prompt_version: str | None = None,
    timeout_s: float = 120.0,
    tool_surface_enabled: bool = False,
) -> EvalReportV2:
    """Run one lane and return a v2 report; each attempt uses its own session.

    `--attempts` may only override behavior tasks; invariant tasks always run
    once. Exceptions are classified per attempt (infra vs timeout failure) and
    never abort the remaining tasks.
    """
    if lane not in LANES:
        raise ValueError(f"unknown lane {lane!r}, expected one of {sorted(LANES)}")
    if attempts_override is not None and lane != "behavior":
        raise ValueError("attempts_override is only valid for the behavior lane")
    if attempts_override is not None and attempts_override < 1:
        raise ValueError("attempts_override must be >= 1")
    if not all(isinstance(task, EvalTaskV2) for task in tasks):
        raise ValueError("lane runs require a v2 dataset")

    task_reports: list[TaskReportV2] = []
    for task in tasks:
        if task.assertion_class != lane:
            continue
        planned = 1 if lane == "invariant" else (attempts_override or task.attempts)
        reason: str | None = None
        if task.category in WORKSPACE_CATEGORIES and not tool_surface_enabled:
            reason = "no_tool_surface"
        elif task.category in DEFERRED_CATEGORIES:
            reason = DEFERRED_CATEGORIES[task.category]
        if reason:
            task_reports.append(_skipped_task_report(task, planned=planned, reason=reason))
            continue
        attempts = [
            _run_attempt(
                client,
                task,
                eval_run_id=eval_run_id,
                attempt_index=index,
                provider=provider,
                model=model,
                timeout_s=timeout_s,
            )
            for index in range(1, planned + 1)
        ]
        task_reports.append(
            evaluate_task_v2(
                task,
                attempts,
                min_valid_attempts=min_valid_attempts,
                attempts_planned=planned,
            )
        )
    return build_report_v2(
        eval_run_id=eval_run_id,
        commit=commit,
        dataset_version=dataset_version,
        dataset_hash=dataset_hash,
        mode="cp-real",
        lane=lane,
        task_reports=task_reports,
        provider=provider,
        model=model,
        prompt_version=prompt_version,
    )
