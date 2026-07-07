"""Context providers for the agent module.

This module adapts PLAN-035's Event Sourcing context management into the
agent runtime. The provider talks to the CP Context Service via HTTP.
"""

from xihe_agent.context.crash_recovery import CrashRecovery
from xihe_agent.context.event_sourced_provider import EventSourcedContextProvider
from xihe_agent.context.store_client import (
    CPContextServiceClient,
    CPEventStoreClient,
)

__all__ = [
    "CPContextServiceClient",
    "CPEventStoreClient",
    "CrashRecovery",
    "EventSourcedContextProvider",
]
