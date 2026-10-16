"""Event-sourced context provider implementation."""

from typing import cast

from xihe_agent.context.store_client import CPContextServiceClient
from xihe_agent.interfaces.context import AgentContext, ContextProvider
from xihe_agent.interfaces.history_safety import mask_historical_messages
from xihe_agent.interfaces.message import TextMessage


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
        authoritative branch it chose itself. `after_sequence` is a cursor hint
        only (PLAN-0416 T2.4) — CP returns the complete visible branch state.
        """
        snapshot = await self._cp_client.get_context_snapshot(
            aggregate_id, after_sequence=after_sequence, run_id=run_id
        )
        context = AgentContext.from_snapshot(snapshot)
        # Snapshot history is always concrete TextMessage (see AgentContext), and the
        # mask preserves each element's concrete type by rewriting TextMessage copies
        # in place; the cast documents that invariant for the narrowed declaration.
        context.messages = cast(
            "list[TextMessage]", mask_historical_messages(context.messages)
        )
        return context
