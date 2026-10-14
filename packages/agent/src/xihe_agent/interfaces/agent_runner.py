"""AgentRunner abstraction.

Replaces direct usage of LangGraph `create_react_agent` / `CompiledStateGraph` in
the agent orchestration layer. Implementations are free to use LangGraph, Mastra,
or any other engine behind this interface.
"""

import asyncio
from abc import ABC, abstractmethod
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

from xihe_agent.interfaces.message import Message

if TYPE_CHECKING:
    from xihe_agent.context.loop_detection import LoopThresholds
    from xihe_agent.interfaces.context import AgentContext
    from xihe_agent.interfaces.tool import BaseAgentTool


@dataclass(frozen=True)
class AgentEvent:
    """Uniform event emitted to the UI via SSE.

    This is the protocol-level event, distinct from the Event Sourcing domain
    events defined in `interfaces.event`.
    """

    # "token" | "tool_call" | "tool_result" | "approval_request" | "status" | "error" | "done"
    # | "transport_progress" | "transport_attempt" (PLAN-0508 bounded transport telemetry)
    type: str
    data: dict[str, Any]


@dataclass(frozen=True)
class RunBudget:
    """PLAN-0492: effective cumulative budget for one ChatRun.

    Resolved from the CP ``agent-runtime`` config (merged effective + run
    overrides) and clamped by the instance-only ceilings at consumption time
    (``ceiling > 0 ? min(value, ceiling) : value``); the runner only enforces.
    A zero value disables that dimension (observation-only): the runner still
    counts and reports it, but never stops the run.

    - ``max_turns``: 1 turn = 1 LLM call (the ``llm_usage`` event, emitted
      once per ``on_chat_model_end``).
    - ``max_elapsed_seconds``: wall-clock of the run, excluding approval /
      human waits (waiting for a person is not "running away").
    - ``max_tokens``: cumulative ``RunUsage.total_tokens``.
    """

    max_turns: int = 0
    max_elapsed_seconds: int = 0
    max_tokens: int = 0


@dataclass(frozen=True)
class RunnerConfig:
    """Configuration for a single agent run."""

    model: str
    system_prompt: str
    tools: list["BaseAgentTool"]
    context: "AgentContext | None" = None
    metadata: dict[str, Any] = field(default_factory=dict)
    # PLAN-0492: CP-resolved run budget; None = no budget (legacy behavior).
    budget: RunBudget | None = None
    # PLAN-0493: CP-resolved loop/no-progress thresholds; None = code defaults.
    # ``loop_exempt_tools`` is the effective exempt set (builtin ∪ configured).
    loop: "LoopThresholds | None" = None
    loop_exempt_tools: frozenset[str] | None = None
    # PLAN-290 M0.3: when set, stream() must observe it and terminate the
    # LangGraph run, emitting error(code=cancelled) before usage.
    cancel_event: asyncio.Event | None = None
    # PLAN-0341 T1.6: fixed cumulative chars of tool results to keep before prune.
    prune_window_chars: int = 80_000
    # PLAN-0410 T2.3: the CP-given branch of this run's context; the prompt is
    # assembled from that branch's snapshot and a mismatch with the loaded
    # AgentContext fails closed instead of silently re-reading the Session.
    branch_id: str = ""
    # PLAN-0415: messages already contain the ordered per-dispatch projection.
    template_context: bool = False
    # Current user prompt only; template-context messages may also contain prior
    # history, which must not be re-appended as fresh prompt.admitted events.
    admitted_prompt: str | None = None
    # PLAN-0508: queue carrying the model's provider transport telemetry events
    # (populated by the transport_sink bound at model construction). The runner
    # fans these into the same SSE event stream; None keeps the run untouched.
    transport_events: asyncio.Queue[AgentEvent] | None = None


class AgentRunner(ABC):
    """Abstract agent executor."""

    @abstractmethod
    def stream(
        self,
        messages: list[Message],
        config: RunnerConfig,
    ) -> AsyncIterator[AgentEvent]:
        """Stream agent events for the given conversation.

        Implementations are async generators; callers iterate directly with
        ``async for`` (no ``await``).
        """
        ...

    @abstractmethod
    async def create_agent(
        self,
        tools: list["BaseAgentTool"],
        config: RunnerConfig,
    ) -> str:
        """Create an agent instance and return its agent_id."""
        ...
