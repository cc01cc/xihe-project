"""AgentRunner abstraction.

Replaces direct usage of LangGraph `create_react_agent` / `CompiledStateGraph` in
the agent orchestration layer. Implementations are free to use LangGraph, Mastra,
or any other engine behind this interface.
"""

from abc import ABC, abstractmethod
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

from xihe_agent.interfaces.message import Message

if TYPE_CHECKING:
    from xihe_agent.interfaces.context import AgentContext
    from xihe_agent.interfaces.tool import BaseAgentTool


@dataclass(frozen=True)
class AgentEvent:
    """Uniform event emitted to the UI via SSE.

    This is the protocol-level event, distinct from the Event Sourcing domain
    events defined in `interfaces.event`.
    """

    type: str  # "token" | "tool_call" | "tool_result" | "status" | "error" | "done"
    data: dict[str, Any]


@dataclass(frozen=True)
class RunnerConfig:
    """Configuration for a single agent run."""

    model: str
    system_prompt: str
    tools: list["BaseAgentTool"]
    max_turns: int = 25
    context: "AgentContext | None" = None
    metadata: dict[str, Any] = field(default_factory=dict)


class AgentRunner(ABC):
    """Abstract agent executor."""

    @abstractmethod
    async def stream(
        self,
        messages: list[Message],
        config: RunnerConfig,
    ) -> AsyncIterator[AgentEvent]:
        """Stream agent events for the given conversation."""
        ...

    @abstractmethod
    async def create_agent(
        self,
        tools: list["BaseAgentTool"],
        config: RunnerConfig,
    ) -> str:
        """Create an agent instance and return its agent_id."""
        ...

    @abstractmethod
    async def reset(self, agent_id: str) -> None:
        """Reset the agent instance and emit a `runtime.state_cleared` event.

        Implementations must clear any framework-specific checkpoint / thread
        state and notify the context system via the event store.
        """
        ...
