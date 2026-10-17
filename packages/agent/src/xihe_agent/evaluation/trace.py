"""PLAN-0509 Trace read models and fact derivation for the runner (PLAN-0511).

The CP trace response is a content-free projection (see `RunTraceReadService`).
These models mirror that wire shape; `derive_facts` turns a terminal Run plus its
trace into the content-free `RunFacts` the evaluators consume.
"""

from __future__ import annotations

import re

from pydantic import BaseModel, ConfigDict, Field

from xihe_agent.evaluation.facts import BudgetDimension, RunFacts

_CITATION_RE = re.compile(r"\[([A-Za-z0-9_.:-]{1,64})\]")

# Trace event kinds that represent an actual tool/MCP/Runtime invocation.
INVOCATION_KINDS = {"mcp.invocation", "runtime.job"}
_EFFECTIVE_INVOCATION_STATUSES = {"started", "succeeded", "failed", "pending", "ambiguous"}


class TraceUsage(BaseModel):
    model_config = ConfigDict(extra="ignore", populate_by_name=True)

    input_tokens: int | None = Field(default=None, alias="inputTokens")
    output_tokens: int | None = Field(default=None, alias="outputTokens")
    total_tokens: int | None = Field(default=None, alias="totalTokens")


class TraceEvent(BaseModel):
    model_config = ConfigDict(extra="ignore", populate_by_name=True)

    event_id: str = Field(alias="eventId")
    occurred_at: str | None = Field(default=None, alias="occurredAt")
    source: str
    kind: str
    status: str | None = None
    duration_ms: int | None = Field(default=None, alias="durationMs")
    provider_id: str | None = Field(default=None, alias="providerId")
    model_id: str | None = Field(default=None, alias="modelId")
    error_code: str | None = Field(default=None, alias="errorCode")
    usage: TraceUsage | None = None
    tool_name: str | None = Field(default=None, alias="toolName")
    references: dict[str, str] = Field(default_factory=dict)


class TraceResponse(BaseModel):
    model_config = ConfigDict(extra="ignore", populate_by_name=True)

    run_id: str = Field(alias="runId")
    completeness: str = "complete"
    events: list[TraceEvent] = Field(default_factory=list)


def extract_citations(text: str | None) -> list[str]:
    """Extract bracketed citation tokens (the v1 synthetic citation format)."""
    if not text:
        return []
    return [m.group(1) for m in _CITATION_RE.finditer(text)]


def _count_invocations(events: list[TraceEvent]) -> int:
    return sum(
        1
        for e in events
        if e.kind in INVOCATION_KINDS and e.status in _EFFECTIVE_INVOCATION_STATUSES
    )


def _count_repeated_mutations(events: list[TraceEvent]) -> int:
    """Count succeeded mutations beyond the first occurrence of the same tool."""
    seen: dict[str, int] = {}
    for e in events:
        if e.kind in INVOCATION_KINDS and e.status == "succeeded" and e.tool_name:
            seen[e.tool_name] = seen.get(e.tool_name, 0) + 1
    return sum(max(0, count - 1) for count in seen.values())


def _sum_usage(events: list[TraceEvent]) -> dict[str, float]:
    total = 0.0
    for e in events:
        if e.usage and e.usage.total_tokens is not None:
            total += e.usage.total_tokens
    return {"total_tokens": total} if total else {}


def derive_facts(
    *,
    run_id: str,
    run_status: str,
    trace: TraceResponse | None,
    final_output_text: str | None,
    run_error_code: str | None = None,
    refusal_code: str | None = None,
    budget: dict[str, BudgetDimension] | None = None,
    duration_ms: int | None = None,
) -> RunFacts:
    """Derive content-free facts from a terminal Run and its trace."""
    events = trace.events if trace is not None else []
    terminal_code = run_error_code
    if terminal_code is None:
        for e in events:
            if e.kind == "run.lifecycle" and e.error_code:
                terminal_code = e.error_code
                break
    return RunFacts(
        run_id=run_id,
        status=run_status,
        trace_available=trace is not None,
        terminal_error_code=terminal_code,
        refusal_code=refusal_code,
        tool_invocation_count=_count_invocations(events),
        completed_mutations=sum(
            1 for e in events if e.kind in INVOCATION_KINDS and e.status == "succeeded"
        ),
        repeated_mutations=_count_repeated_mutations(events),
        final_output_text=final_output_text,
        citations=extract_citations(final_output_text),
        usage=_sum_usage(events),
        duration_ms=duration_ms,
        budget=budget or {},
    )
