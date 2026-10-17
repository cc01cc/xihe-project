"""Normalized, content-free facts observed for one evaluated Run (PLAN-0511).

These facts are derived by the runner from the CP ChatRun terminal state and the
PLAN-0509 Trace read API. Evaluators consume only these facts so hard assertions
stay deterministic and never depend on raw prompt/response bodies.
"""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field


class BudgetDimension(BaseModel):
    """One run-budget dimension as observed (limit vs used)."""

    model_config = ConfigDict(extra="forbid")

    limit: float
    used: float


class RunFacts(BaseModel):
    """Content-free observable facts for a single ChatRun."""

    model_config = ConfigDict(extra="forbid")

    run_id: str
    status: str
    trace_available: bool = False
    terminal_error_code: str | None = None
    refusal_code: str | None = None
    tool_invocation_count: int = 0
    completed_mutations: int = 0
    repeated_mutations: int = 0
    final_output_text: str | None = None
    citations: list[str] = Field(default_factory=list)
    usage: dict[str, float] = Field(default_factory=dict)
    duration_ms: int | None = None
    budget: dict[str, BudgetDimension] = Field(default_factory=dict)

    def is_terminal(self) -> bool:
        return self.status in {"completed", "failed", "cancelled"}
