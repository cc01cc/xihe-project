"""Refreshable context source abstraction.

In PLAN-035 the actual source observation and change detection runs in CP.
This module contains lightweight client-side wrappers and the `Refreshable`
primitive for local use (e.g. tests or future client-side observers).
"""

from abc import ABC, abstractmethod
from dataclasses import dataclass


@dataclass(frozen=True)
class SourceValue:
    """Current value of a context source with a stable content hash."""

    key: str
    content: str
    content_hash: str


class RefreshableContextSource(ABC):
    """Source that can be refreshed and falls back to the previous value."""

    @abstractmethod
    async def get(self) -> SourceValue:
        """Return the current source value."""
        ...

    @abstractmethod
    async def invalidate(self) -> None:
        """Force a refresh on the next `get()`."""
        ...

    @property
    @abstractmethod
    def key(self) -> str:
        """Stable source key."""
        ...
