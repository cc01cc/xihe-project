"""Event-sourced context provider implementation."""

from xihe_agent.context.store_client import CPContextServiceClient
from xihe_agent.interfaces.context import AgentContext, ContextProvider


class EventSourcedContextProvider(ContextProvider):
    """Loads `AgentContext` snapshots from the CP Context Projection Service."""

    def __init__(self, cp_client: CPContextServiceClient) -> None:
        self._cp_client = cp_client

    async def load(
        self,
        aggregate_id: str,
        after_sequence: int = 0,
    ) -> AgentContext:
        snapshot = await self._cp_client.get_context_snapshot(
            aggregate_id, after_sequence=after_sequence
        )
        return AgentContext.from_snapshot(snapshot)
