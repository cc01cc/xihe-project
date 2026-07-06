"""Context projection abstraction.

`AgentContext` is the read-only snapshot that the Agent consumes. It is produced
by CP's `ContextProjectionService` from the Event Store and returned via the
`/snapshot` endpoint.
"""

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any, Literal

from xihe_agent.interfaces.message import Message, TextMessage

ContextSourceType = Literal[
    "agents_md",
    "user_rules",
    "workspace_facts",
    "rag",
]


@dataclass(frozen=True)
class ContextSource:
    """A single source contributing to the system context."""

    key: str
    source_type: ContextSourceType
    content: str
    content_hash: str


@dataclass(frozen=True)
class ContextEpoch:
    """Versioned system-context baseline."""

    epoch_id: str
    baseline_hash: str
    system_messages: list[str]
    sources: list[ContextSource] = field(default_factory=list)


@dataclass
class AgentContext:
    """Snapshot of a session context, projected from domain events."""

    aggregate_id: str
    latest_sequence: int = 0
    messages: list[Message] = field(default_factory=list)
    epoch: ContextEpoch | None = None
    runtime_state: dict[str, Any] = field(default_factory=dict)
    metadata: dict[str, Any] = field(default_factory=dict)

    def add_message(self, message: Message) -> "AgentContext":
        self.messages.append(message)
        return self

    def set_epoch(self, epoch: ContextEpoch) -> "AgentContext":
        self.epoch = epoch
        return self

    def clear_runtime_state(self) -> "AgentContext":
        self.runtime_state.clear()
        return self

    def set_latest_sequence(self, sequence: int) -> "AgentContext":
        self.latest_sequence = sequence
        return self

    def to_snapshot(self) -> dict[str, Any]:
        """Serialize the snapshot to a transport-friendly dictionary."""
        return {
            "aggregate_id": self.aggregate_id,
            "latest_sequence": self.latest_sequence,
            "messages": [
                {"role": m.role, "content": m.content}
                for m in self.messages
            ],
            "epoch": self._epoch_to_dict() if self.epoch else None,
            "runtime_state": self.runtime_state,
            "metadata": self.metadata,
        }

    @classmethod
    def empty(cls, aggregate_id: str) -> "AgentContext":
        return cls(aggregate_id=aggregate_id)

    @classmethod
    def from_snapshot(cls, snapshot: dict[str, Any]) -> "AgentContext":
        ctx = cls(
            aggregate_id=snapshot["aggregate_id"],
            latest_sequence=snapshot.get("latest_sequence", 0),
            runtime_state=snapshot.get("runtime_state", {}),
            metadata=snapshot.get("metadata", {}),
        )
        for raw in snapshot.get("messages", []):
            role = raw.get("role", "human")
            if role not in ("system", "human", "ai", "tool"):
                role = "human"
            ctx.messages.append(TextMessage(role=role, content=raw.get("content", "")))
        epoch_raw = snapshot.get("epoch")
        if epoch_raw:
            ctx.epoch = ContextEpoch(
                epoch_id=epoch_raw["epoch_id"],
                baseline_hash=epoch_raw["baseline_hash"],
                system_messages=epoch_raw["system_messages"],
                sources=[
                    ContextSource(
                        key=s["key"],
                        source_type=s["source_type"],
                        content=s["content"],
                        content_hash=s["content_hash"],
                    )
                    for s in epoch_raw.get("sources", [])
                ],
            )
        return ctx

    def _epoch_to_dict(self) -> dict[str, Any]:
        if self.epoch is None:
            return {}
        epoch = self.epoch
        return {
            "epoch_id": epoch.epoch_id,
            "baseline_hash": epoch.baseline_hash,
            "system_messages": epoch.system_messages,
            "sources": [
                {
                    "key": s.key,
                    "source_type": s.source_type,
                    "content": s.content,
                    "content_hash": s.content_hash,
                }
                for s in epoch.sources
            ],
        }


class ContextProvider(ABC):
    """Abstract provider that loads an `AgentContext` snapshot."""

    @abstractmethod
    async def load(self, aggregate_id: str, after_sequence: int = 0) -> AgentContext:
        """Load the projected context for the aggregate."""
        ...
