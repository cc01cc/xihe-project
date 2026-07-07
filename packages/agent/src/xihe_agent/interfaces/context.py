"""Context projection abstraction.

`AgentContext` is the read-only snapshot that the Agent consumes. It is produced
by CP's `ContextProjectionService` from the Event Store and returned via the
`/snapshot` endpoint.
"""

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any, Literal

from xihe_agent.interfaces.event import Event
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

    def apply_event(self, event: Event) -> "AgentContext":
        """Apply a domain event to reconstruct this context snapshot."""
        self.set_latest_sequence(event.sequence)
        payload = event.payload
        event_type = event.type

        if event_type == "session.created":
            self.metadata.setdefault("workspace_id", payload.get("workspace_id"))
            self.metadata.setdefault("user_id", payload.get("user_id"))
            if payload.get("epoch_id"):
                self.epoch = ContextEpoch(
                    epoch_id=payload["epoch_id"],
                    baseline_hash=payload.get("baseline_hash", ""),
                    system_messages=payload.get("system_messages", []),
                )
        elif event_type == "prompt.admitted":
            self._add_message_from_payload(payload, "human")
        elif event_type == "llm.token":
            self._add_message_from_payload(payload, "ai")
        elif event_type == "tool.result":
            self._add_message_from_payload(payload, "tool")
        elif event_type == "tool.called":
            self.runtime_state.setdefault("tool_calls", []).append({
                "call_id": payload.get("call_id"),
                "tool_name": payload.get("tool_name"),
                "tool_input": payload.get("tool_input", {}),
            })
        elif event_type == "context.source_changed":
            self._add_message_from_payload(payload, "system")
        elif event_type in ("epoch.started", "epoch.replaced"):
            self.epoch = ContextEpoch(
                epoch_id=payload.get("epoch_id", ""),
                baseline_hash=payload.get("baseline_hash", ""),
                system_messages=payload.get("system_messages", []),
                sources=[
                    ContextSource(
                        key=s["key"],
                        source_type=s["source_type"],
                        content=s["content"],
                        content_hash=s["content_hash"],
                    )
                    for s in payload.get("sources", [])
                ],
            )
        elif event_type == "runtime.state_cleared":
            self.clear_runtime_state()
        elif event_type == "session.forked":
            self.metadata["forked_from"] = {
                "source_session_id": payload.get("source_session_id"),
                "at_sequence": payload.get("at_sequence"),
            }
        elif event_type == "compaction.applied":
            self.messages.clear()
            self.messages.append(TextMessage(role="system", content=payload.get("summary", "")))
        return self

    def _add_message_from_payload(self, payload: dict[str, Any], role: str) -> None:
        content = ""
        if isinstance(payload.get("message"), dict):
            content = payload["message"].get("content", "")
            role = payload["message"].get("role", role)
        elif payload.get("content"):
            content = payload["content"]
        elif payload.get("result"):
            result = payload["result"]
            content = result.get("content", str(result)) if isinstance(result, dict) else str(result)
        elif payload.get("token"):
            content = payload["token"]
        if content:
            self.messages.append(TextMessage(role=role, content=content))

    @classmethod
    def from_events(cls, aggregate_id: str, events: list[Event]) -> "AgentContext":
        """Reconstruct an AgentContext by replaying a list of events."""
        context = cls.empty(aggregate_id)
        for event in events:
            context.apply_event(event)
        return context

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
