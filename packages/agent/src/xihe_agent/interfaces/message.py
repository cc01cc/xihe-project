"""Message abstraction for the agent module.

Replaces direct usage of LangChain `BaseMessage` subtypes in the agent core.
Implementations may be dataclasses or Pydantic models; the protocol only requires
`role` and `content` so that it can be used by `AgentRunner.stream()`.

PLAN-0381 T1.1: history messages may additionally carry provider-neutral
tool-call metadata (assistant tool-call declarations + tool-result pairing
fields). Plain-text messages keep the exact two-key snapshot shape.
"""

from dataclasses import dataclass, field
from typing import Any, Literal, Protocol

MessageRole = Literal["system", "human", "ai", "tool"]


class Message(Protocol):
    """Minimal message abstraction used by AgentRunner."""

    role: MessageRole
    content: str


@dataclass(frozen=True)
class TextMessage:
    """Concrete immutable message implementation.

    Tool-history fields are optional; defaults keep legacy plain-text
    messages byte-compatible with the pre-0381 snapshot shape
    (``{"role", "content"}`` only when serialized by ``to_snapshot``).
    """

    role: MessageRole
    content: str
    # PLAN-0381 T1.1 — tool-result side (role == "tool")
    tool_call_id: str = ""
    tool_name: str = ""
    status: str = ""
    truncated: bool = False
    artifact_ref: str = ""
    size_bytes: int | None = None
    error_code: str = ""
    # PLAN-0381 T1.1 — pairing/degradation markers (both sides)
    degraded: bool = False
    legacy_normalized: bool = False
    # PLAN-0381 T1.1 — assistant tool-call side (role == "ai")
    tool_calls: tuple["ToolCallRef", ...] = ()


@dataclass(frozen=True)
class ToolCallRef:
    """Provider-neutral assistant tool-call declaration (snapshot entry)."""

    call_id: str
    tool_name: str
    arguments: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class ToolMessage:
    """Message emitted from a tool result."""

    role: MessageRole = "tool"
    content: str = ""
    tool_call_id: str = ""
