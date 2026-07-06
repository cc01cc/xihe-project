"""Message abstraction for the agent module.

Replaces direct usage of LangChain `BaseMessage` subtypes in the agent core.
Implementations may be dataclasses or Pydantic models; the protocol only requires
`role` and `content` so that it can be used by `AgentRunner.stream()`.
"""

from dataclasses import dataclass
from typing import Literal, Protocol

MessageRole = Literal["system", "human", "ai", "tool"]


class Message(Protocol):
    """Minimal message abstraction used by AgentRunner."""

    role: MessageRole
    content: str


@dataclass(frozen=True)
class TextMessage:
    """Concrete immutable message implementation."""

    role: MessageRole
    content: str


@dataclass(frozen=True)
class ToolMessage:
    """Message emitted from a tool result."""

    role: MessageRole = "tool"
    content: str = ""
    tool_call_id: str = ""
