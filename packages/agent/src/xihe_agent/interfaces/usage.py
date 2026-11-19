"""Run-level telemetry: token usage, duration, turns, tool calls, cost."""

from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any


@dataclass
class RunUsage:
    """Tracks cumulative usage for a single agent run."""

    input_tokens: int = 0
    output_tokens: int = 0
    total_tokens: int = 0
    turns: int = 0
    tool_calls: int = 0
    tool_results: int = 0
    started_at: datetime = field(default_factory=lambda: datetime.now(UTC))
    finished_at: datetime | None = None
    duration_ms: int = 0
    cost: float | None = None
    cost_currency: str = "USD"
    cost_note: str = ""
    # PLAN-294 decisions #13/#14: local estimation of the input size (the
    # compression signal) kept NEXT TO the provider-reported value so audits
    # can diff estimator vs truth per run. `source` is real (provider usage
    # chunk) / estimated (local tokenizer) / fallback (no counters at all).
    estimated_input_tokens: int = 0
    source: str = "fallback"
    # task-101 (B): two numbers side by side. total_tokens stays the REAL
    # consumption (provider-reported input+output, semantics unchanged);
    # budget_consumed is the budget-charged amount under budget_accounting:
    #   growth     -> (input - cache_read) + output  (a cached prefix is not re-charged)
    #   cumulative -> input + output                 (today rule, rollback switch)
    # cache_read_tokens is None when the provider reports no such counter at all
    # -> fail-open: charge the full input. A reported 0 is NOT missing: 0 is a
    # legitimate no-hit and must be honoured (B-1 section 4.2).
    cache_read_input_tokens: int = 0
    budget_consumed: int = 0
    budget_accounting: str = "growth"

    def record_llm_usage(
        self,
        input_tokens: int = 0,
        output_tokens: int = 0,
        cache_read_tokens: int | None = None,
        accounting: str | None = None,
    ) -> int:
        """Record one LLM call; returns the charge this call added to the budget."""
        mode = accounting or self.budget_accounting
        if mode not in ("growth", "cumulative"):
            mode = "growth"
        self.budget_accounting = mode
        effective_cache: int | None = None
        if cache_read_tokens is not None:
            effective_cache = max(0, min(int(cache_read_tokens), max(0, input_tokens)))
            self.cache_read_input_tokens += effective_cache
        self.input_tokens += input_tokens
        self.output_tokens += output_tokens
        self.total_tokens = self.input_tokens + self.output_tokens
        if mode == "cumulative":
            charge = input_tokens + output_tokens
        elif effective_cache is None:
            charge = input_tokens + output_tokens  # fail-open: never the no-charge branch
        else:
            charge = (input_tokens - effective_cache) + output_tokens
        self.budget_consumed += charge
        return charge

    def record_turn(self) -> None:
        self.turns += 1

    def record_tool_call(self) -> None:
        self.tool_calls += 1

    def record_tool_result(self) -> None:
        self.tool_results += 1

    def finish(self) -> None:
        self.finished_at = datetime.now(UTC)
        self.duration_ms = int((self.finished_at - self.started_at).total_seconds() * 1000)

    def to_dict(self) -> dict[str, Any]:
        return {
            "inputTokens": self.input_tokens,
            "outputTokens": self.output_tokens,
            "totalTokens": self.total_tokens,
            "cacheReadInputTokens": self.cache_read_input_tokens,
            "budgetConsumed": self.budget_consumed,
            "budgetAccounting": self.budget_accounting,
            "turns": self.turns,
            "toolCalls": self.tool_calls,
            "toolResults": self.tool_results,
            "durationMs": self.duration_ms,
            "cost": self.cost,
            "costCurrency": self.cost_currency,
            "costNote": self.cost_note,
            "estimatedInputTokens": self.estimated_input_tokens,
            "source": self.source,
        }

    def to_event_payload(self) -> dict[str, Any]:
        return {
            "usage": self.to_dict(),
        }
