"""task-103: verbatim provider audit capture (request/response/error bodies).

Verbatim means verbatim: the bytes that go out on the wire and the bytes the provider
returns are captured unchanged - no redaction, no rewriting, no truncation, no hit
counting. Each body travels base64 encoded next to its sha256 and byte length so the CP
can prove byte identity after decoding (sha256(stored) == sha256(received) and the stored
byte count equals the captured one).

Tiers (providerAudit):
full     - bodies stored verbatim (default)
metadata - only sha256 / byte length / counts; bodies stay NULL
off      - no body-shaped capture at all; the CP stores NULL, never 0 and never ""
"""

from __future__ import annotations

import base64
import hashlib
import json
from collections.abc import Mapping
from typing import Any

AUDIT_TIER_FULL = "full"
AUDIT_TIER_METADATA = "metadata"
AUDIT_TIER_OFF = "off"
AUDIT_TIERS: tuple[str, ...] = (AUDIT_TIER_FULL, AUDIT_TIER_METADATA, AUDIT_TIER_OFF)
DEFAULT_AUDIT_TIER = AUDIT_TIER_FULL

# Original request values recorded next to the body (verbatim, never re-derived).
PARAM_KEYS: tuple[str, ...] = ("model", "stream", "max_tokens", "temperature", "top_p", "stop", "tool_choice")

_FINISH_KEYS: tuple[str, ...] = ("stop_reason", "finish_reason", "finishReason")


def normalize_tier(value: Any) -> str:
    """Resolve the configured tier; anything unrecognised stays on the default (fail-open)."""
    if isinstance(value, str):
        candidate = value.strip().lower()
        if candidate in AUDIT_TIERS:
            return candidate
    return DEFAULT_AUDIT_TIER


def body_block(payload: bytes | None, tier: str) -> dict[str, Any] | None:
    """sha256 + byte length always; the verbatim bytes only when the tier keeps bodies."""
    if payload is None or tier == AUDIT_TIER_OFF:
        return None
    # The key is always present: bodyB64 null is "tier withheld the body", distinct from the
    # whole block being null ("nothing was captured").
    return {
        "sha256": hashlib.sha256(payload).hexdigest(),
        "bytes": len(payload),
        "bodyB64": base64.b64encode(payload).decode("ascii") if tier == AUDIT_TIER_FULL else None,
    }


def request_params(body: Mapping[str, Any]) -> dict[str, Any]:
    """The caller's original parameter values - copied as they are, never normalised."""
    return {key: body[key] for key in PARAM_KEYS if key in body}


def tool_surface(body: Mapping[str, Any]) -> dict[str, Any] | None:
    """Hash + count of the rendered tool schema (schema text never leaves as text)."""
    tools = body.get("tools")
    if not isinstance(tools, list) or not tools:
        return None
    encoded = json.dumps(tools, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode("utf-8")
    return {"sha256": hashlib.sha256(encoded).hexdigest(), "count": len(tools)}


def _finish_from_object(candidate: Any) -> str | None:
    if not isinstance(candidate, dict):
        return None
    for key in _FINISH_KEYS:
        value = candidate.get(key)
        if isinstance(value, str) and value:
            return value
    choices = candidate.get("choices")
    if isinstance(choices, list) and choices and isinstance(choices[0], dict):
        value = choices[0].get("finish_reason")
        if isinstance(value, str) and value:
            return value
    delta = candidate.get("delta")
    if isinstance(delta, dict):
        value = delta.get("stop_reason")
        if isinstance(value, str) and value:
            return value
    details = candidate.get("incomplete_details")
    if isinstance(details, dict):
        value = details.get("reason")
        if isinstance(value, str) and value:
            return value
    return None


def finish_reason_from_payload(payload: bytes | None, *, streamed: bool) -> str | None:
    """Read the provider's own finish/stop reason out of the captured bytes.

    None means the provider did not report one - it is never synthesised.
    """
    if not payload:
        return None
    if not streamed:
        try:
            return _finish_from_object(json.loads(payload.decode("utf-8")))
        except (ValueError, UnicodeError):
            return None
    reason: str | None = None
    for raw_line in payload.split(b"\n"):
        line = raw_line.strip()
        if not line.startswith(b"data:"):
            continue
        try:
            event = json.loads(line[len(b"data:") :].strip().decode("utf-8"))
        except (ValueError, UnicodeError):
            continue
        found = _finish_from_object(event)
        if found is not None:
            reason = found
    return reason


def audit_block(
    *,
    provider_step: int,
    dispatch_attempt: int,
    api_type_id: str,
    api_type_version: int | None,
    model: str,
    tier: str,
    http_status: int | None,
    streamed: bool,
    ttft_ms: int | None,
    total_ms: int | None,
    request_bytes: bytes | None,
    response_bytes: bytes | None,
    error_bytes: bytes | None,
    cache_read: int | None,
    cache_write: int | None,
    params: Mapping[str, Any] | None,
    tool_snapshot: Mapping[str, Any] | None,
) -> dict[str, Any]:
    """The audit block carried by the per-step event (one attempt, one provider step)."""
    keep_meta = tier != AUDIT_TIER_OFF
    return {
        "providerStep": provider_step,
        "dispatchAttempt": dispatch_attempt,
        "apiTypeId": api_type_id,
        "apiTypeVersion": api_type_version,
        "model": model,
        "tier": tier,
        "httpStatus": http_status,
        "streamed": streamed,
        "finishReason": finish_reason_from_payload(response_bytes, streamed=streamed),
        "ttftMs": ttft_ms,
        "totalMs": total_ms,
        "request": body_block(request_bytes, tier),
        "response": body_block(response_bytes, tier),
        "errorBody": body_block(error_bytes, tier),
        "cacheRead": cache_read,
        "cacheWrite": cache_write,
        "requestParams": dict(params) if keep_meta and params else None,
        "toolSurface": dict(tool_snapshot) if keep_meta and tool_snapshot else None,
    }
