"""Inbound size governance for ``agentContext.messages`` (PLAN-0670 T2c.1 / T2c.4).

Why this module exists
----------------------
CP sends the session history as ``agentContext.messages``; the Python side used to materialise the
whole list first and only then let ``context/builder._take_newest`` trim it by token budget — i.e. the
process could be pushed into OOM *before* the diet started. This module is the second line of defence
(the first one is CP sending a window at all, PLAN-0651; the third one stays the token budget in
``_take_newest``). The three lines deliberately do different jobs and none of them duplicates another.

Contract (frozen with the Lead, PLAN-0670 M2c):
- defaults: **2000 messages** and **8 MiB** of serialised JSON, both overridable by env;
- overflow is never silent: a :class:`Truncation` marker is returned *and* logged by the caller, and the
  marker travels back with the run result so CP can see it;
- the newest messages survive (same preference as ``_take_newest``), the oldest are dropped.

Pre-parse hard stop (413) lives in the HTTP layer (``api/chat.py``): ``Content-Length`` is rejected
before pydantic and a stream read stops at ``max_bytes + 1``. This module only handles what is already
decoded, which is why the two are complementary rather than redundant.
"""

from __future__ import annotations

import json
import os
from collections.abc import Iterable
from dataclasses import dataclass
from typing import Any

DEFAULT_MAX_MESSAGES = 2000
DEFAULT_MAX_BYTES = 8 * 1024 * 1024

ENV_MAX_MESSAGES = "XIHE_AGENT_CONTEXT_MAX_MESSAGES"
ENV_MAX_BYTES = "XIHE_AGENT_CONTEXT_MAX_BYTES"

#: Payload keys that carry base64 blobs rather than plain text (T2c.4 audit surface).
BASE64_KEYS = ("data", "b64", "base64", "image", "payloadBase64")


@dataclass(frozen=True)
class Truncation:
    """What the second line of defence dropped. Serialised straight into the run result."""

    dropped_messages: int
    dropped_bytes: int
    kept_messages: int
    kept_bytes: int
    limit_messages: int
    limit_bytes: int
    strategy: str = "newestKeep"

    def to_wire(self) -> dict[str, Any]:
        return {
            "droppedMessages": self.dropped_messages,
            "droppedBytes": self.dropped_bytes,
            "keptMessages": self.kept_messages,
            "keptBytes": self.kept_bytes,
            "limitMessages": self.limit_messages,
            "limitBytes": self.limit_bytes,
            "strategy": self.strategy,
        }


def limits_from_env() -> tuple[int, int]:
    """Read the two caps, falling back to the frozen defaults on missing/invalid values."""
    return _positive_int(os.environ.get(ENV_MAX_MESSAGES), DEFAULT_MAX_MESSAGES), _positive_int(
        os.environ.get(ENV_MAX_BYTES), DEFAULT_MAX_BYTES
    )


def _positive_int(raw: str | None, fallback: int) -> int:
    if raw is None or not raw.strip():
        return fallback
    try:
        value = int(raw)
    except ValueError:
        return fallback
    return value if value > 0 else fallback


def serialised_bytes(message: Any) -> int:
    """Byte size of one message as it would travel on the wire (UTF-8, compact JSON)."""
    if isinstance(message, (bytes, bytearray)):
        return len(message)
    try:
        payload = json.dumps(message, separators=(",", ":"), ensure_ascii=False, default=str)
    except (TypeError, ValueError):
        payload = str(message)
    return len(payload.encode("utf-8"))


def apply_inbound_limits(messages: Iterable[Any], *, max_messages: int | None = None,
                         max_bytes: int | None = None) -> tuple[list[Any], Truncation | None]:
    """Keep the newest messages within both caps.

    Returns the kept list (a new list — the caller must drop the original reference so the full history
    can be collected) and a :class:`Truncation`, or ``None`` when nothing had to be dropped.
    """
    limit_messages = max_messages or DEFAULT_MAX_MESSAGES
    limit_bytes = max_bytes or DEFAULT_MAX_BYTES
    materialised = list(messages)
    total_bytes = sum(serialised_bytes(message) for message in materialised)

    if len(materialised) <= limit_messages and total_bytes <= limit_bytes:
        return materialised, None

    kept: list[Any] = []
    kept_bytes = 0
    for message in reversed(materialised):
        size = serialised_bytes(message)
        if len(kept) + 1 > limit_messages or kept_bytes + size > limit_bytes:
            break
        kept.append(message)
        kept_bytes += size
    kept.reverse()

    dropped_messages = len(materialised) - len(kept)
    return kept, Truncation(
        dropped_messages=dropped_messages,
        dropped_bytes=max(total_bytes - kept_bytes, 0),
        kept_messages=len(kept),
        kept_bytes=kept_bytes,
        limit_messages=limit_messages,
        limit_bytes=limit_bytes,
    )


def base64_stats(value: Any) -> dict[str, int]:
    """T2c.4 audit: how many bytes of a tool result are base64 blobs versus everything else.

    Pure measurement — nothing is rewritten here. The batch that removes the inline path comes later
    (it needs the Runtime artifact channel), so this exists to produce the number that decides it.
    """
    total = serialised_bytes(value)
    base64_bytes = _sum_base64(value)
    return {
        "totalBytes": total,
        "base64Bytes": base64_bytes,
        "plainBytes": max(total - base64_bytes, 0),
    }


def _sum_base64(value: Any) -> int:
    if isinstance(value, dict):
        return sum(_sum_base64(item) for key, item in value.items() if _length(key, item))
    if isinstance(value, (list, tuple)):
        return sum(_sum_base64(item) for item in value)
    if isinstance(value, str):
        return len(value.encode("utf-8"))
    return 0


def _length(key: Any, value: Any) -> bool:
    """True when this key/value pair is a base64 blob worth counting."""
    if not isinstance(key, str) or not isinstance(value, str):
        return False
    if key in BASE64_KEYS:
        return True
    return key.endswith("Base64")

class InboundTooLargeError(Exception):
    """Raised before any JSON parsing when the inbound body exceeds the frozen byte cap."""

    def __init__(self, limit_bytes: int, observed_bytes: int | None = None) -> None:
        super().__init__(f"agent context body exceeds {limit_bytes} bytes")
        self.limit_bytes = limit_bytes
        self.observed_bytes = observed_bytes


async def read_body_with_limit(request: Any, max_bytes: int | None = None) -> bytes:
    """Read the request body under the byte cap, before any JSON parsing (T2c.1, step 1).

    Two checks, because a header can be missing or lie:
    1. `Content-Length` is refused when it already exceeds the cap (cheap, no read);
    2. the stream is read chunk by chunk and stops at `cap + 1` — a chunked upload without a
       `Content-Length` cannot smuggle an unbounded body past us.

    The caller parses the returned bytes itself (`json.loads`), so this really happens before
    pydantic/model validation; that ordering is the whole point.
    """
    limit = max_bytes or limits_from_env()[1]
    declared = request.headers.get("content-length")
    if declared is not None:
        try:
            declared_int = int(declared)
        except ValueError:
            declared_int = None
        if declared_int is not None and declared_int > limit:
            raise InboundTooLargeError(limit, declared_int)

    chunks: list[bytes] = []
    total = 0
    async for chunk in request.stream():
        total += len(chunk)
        if total > limit:
            raise InboundTooLargeError(limit, total)
        chunks.append(chunk)
    return b"".join(chunks)
