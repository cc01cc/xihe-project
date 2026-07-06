"""Event adapter abstraction.

Translates framework-specific raw events (e.g. LangGraph `astream_events`)
into the uniform SSE `AgentEvent` protocol used by the UI.

Note: this is **not** the Event Sourcing domain event. Domain events are
introduced by PLAN-035 and are persisted in the CP Event Store.
"""

from abc import ABC, abstractmethod
from typing import Any

from xihe_agent.interfaces.agent_runner import AgentEvent


class EventAdapter(ABC):
    """Translates framework raw events into `AgentEvent` instances."""

    @abstractmethod
    def translate(self, raw_event: dict[str, Any]) -> AgentEvent | list[AgentEvent] | None:
        """Translate a single raw event into zero or more `AgentEvent` objects."""
        ...
