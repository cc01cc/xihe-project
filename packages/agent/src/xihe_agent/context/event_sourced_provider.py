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
        run_id: str | None = None,
    ) -> AgentContext:
        """PLAN-0410 T2.3: `run_id` scopes the snapshot to the Run's branch.

        CP resolves and validates the branch; the Agent never submits an
        authoritative branch it chose itself.
        """
        snapshot = await self._cp_client.get_context_snapshot(
            aggregate_id, after_sequence=after_sequence, run_id=run_id
        )
        return AgentContext.from_snapshot(snapshot)
