"""Dataset runner orchestration for the offline evaluation suite (PLAN-0511 M2).

The runner drives each task through the CP public Chat API as a real ChatRun,
waits for the terminal state, reads the PLAN-0509 trace, derives content-free
facts and evaluates the task. The CP transport is abstracted behind `CpClient`
so the orchestration is unit-testable without a live stack.
"""

from __future__ import annotations

from typing import Protocol

from pydantic import BaseModel, ConfigDict

from xihe_agent.evaluation.report import (
    STATUS_NOT_EVALUATED,
    EvalReport,
    TaskReport,
    build_report,
    evaluate_task,
)
from xihe_agent.evaluation.schema import EvalTask
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


def _task_content(task: EvalTask) -> str:
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
    tasks: list[EvalTask],
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
