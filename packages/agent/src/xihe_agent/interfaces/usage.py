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

    def record_llm_usage(
        self,
        input_tokens: int = 0,
        output_tokens: int = 0,
    ) -> None:
        self.input_tokens += input_tokens
        self.output_tokens += output_tokens
        self.total_tokens = self.input_tokens + self.output_tokens

    def record_turn(self) -> None:
        self.turns += 1

    def record_tool_call(self) -> None:
        self.tool_calls += 1

    def record_tool_result(self) -> None:
        self.tool_results += 1

    def finish(self) -> None:
        self.finished_at = datetime.now(UTC)
        self.duration_ms = int(
            (self.finished_at - self.started_at).total_seconds() * 1000
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "inputTokens": self.input_tokens,
            "outputTokens": self.output_tokens,
            "totalTokens": self.total_tokens,
            "turns": self.turns,
            "toolCalls": self.tool_calls,
            "toolResults": self.tool_results,
            "durationMs": self.duration_ms,
            "cost": self.cost,
            "costCurrency": self.cost_currency,
            "costNote": self.cost_note,
        }

    def to_event_payload(self) -> dict[str, Any]:
        return {
            "usage": self.to_dict(),
        }
