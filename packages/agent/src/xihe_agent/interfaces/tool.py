"""Tool abstraction for the agent module.

Replaces direct `BaseTool` inheritance. Concrete tools implement `BaseAgentTool`
and expose a JSON Schema via `ToolSpec`. LangChain-specific adapters can wrap
`BaseAgentTool` instances into `BaseTool` when needed.
"""

from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from xihe_agent.interfaces.context import AgentContext


@dataclass(frozen=True)
class ToolSpec:
    """Static description of a tool callable by the agent."""

    name: str
    description: str
    input_schema: dict[str, Any]


class BaseAgentTool(ABC):
    """Agent tool that does not depend on LangChain `BaseTool`."""

    @abstractmethod
    async def execute(self, input: dict[str, Any], context: "AgentContext") -> dict[str, Any]:
        """Execute the tool with the given input and request context.

        The `context` parameter is typed as `AgentContext` in PLAN-035; during
        PLAN-033 M1 it is kept as a forward reference to avoid a circular import.
        """
        ...

    @property
    @abstractmethod
    def spec(self) -> ToolSpec:
        """Return the static tool specification."""
        ...
