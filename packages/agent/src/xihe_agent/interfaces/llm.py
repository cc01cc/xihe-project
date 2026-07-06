"""LLM provider abstraction.

Isolates the rest of the agent module from `BaseChatModel` and provider-specific
implementations such as `ChatLiteLLM`.
"""

from abc import ABC, abstractmethod
from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class LLMRequest:
    """Normalized request to an LLM backend."""

    model: str
    messages: list[dict[str, Any]]
    tools: list[dict[str, Any]] | None = None
    temperature: float | None = None
    max_tokens: int | None = None


@dataclass(frozen=True)
class LLMToken:
    """Single streaming token from an LLM."""

    content: str


class LLMProvider(ABC):
    """Abstract LLM backend."""

    @abstractmethod
    async def generate(self, request: LLMRequest) -> str:
        """Generate a complete non-streaming response."""
        ...

    @abstractmethod
    async def stream_generate(self, request: LLMRequest) -> AsyncIterator[LLMToken]:
        """Generate a streaming response, yielding tokens."""
        ...

    @abstractmethod
    def with_model(self, model: str) -> "LLMProvider":
        """Return a provider configured for a different model."""
        ...
