"""PLAN-0679 T1.1: canonical JSON serialization + sha256 for provider request fingerprints.

Design D3 (PLAN-0679): sha256 over explicit canonical JSON, reusing the PLAN-0666 D6 rules
(CP side: ``ContextFingerprintCalculator``). This module is the Python equivalent; byte-level
identity with the Java implementation is explicitly NOT required (different outbound objects,
no cross-comparison). What IS required — and what the tests pin — is determinism inside the
agent process: the same logical value must produce the same bytes in any process, in any dict
insertion order the caller happened to build.

Rules (mirroring 0666 D6):
- object keys sorted by their UTF-8 bytes (unsigned), not by code point heuristics;
- array order is preserved — semantic order is the caller's responsibility;
- numbers are normalized: ``1``, ``1.0`` and ``1.00`` hash identically; ``-0.0`` becomes ``0``;
  NaN/Infinity are rejected (no silent instability);
- strings use a fixed escape rule: short escapes for ``"`` ``\\`` and C0 controls, ``\\u00xx``
  for remaining C0 controls, everything else verbatim (output is UTF-8, not ASCII-escaped);
- a missing key and an explicit ``null`` are different inputs and different hashes.

Volatile-field exclusion (D3) is deliberately NOT hardcoded here: 0666 keeps exclusions in the
caller-built layer payloads, and the agent-side denylist needs real-body evidence (T0.3 dump)
before any key is named. ``strip_volatile`` provides the mechanism; T1.2 decides the list.
"""

from __future__ import annotations

import hashlib
import json
import math
from collections.abc import Mapping, Sequence
from decimal import Decimal
from typing import Any, Final

__all__ = [
    "CanonicalValueError",
    "FINGERPRINT_ALGO",
    "FINGERPRINT_MAX_PAYLOAD_BYTES",
    "FINGERPRINT_TOO_LARGE_REASON",
    "PROVIDER_FINGERPRINT_EVENT",
    "build_fingerprint_document",
    "canonical_bytes",
    "canonical_json",
    "fingerprint_event_payload",
    "role_histogram",
    "sha256_hex",
    "strip_volatile",
]

#: Event type published through the transport sink (PLAN-0679 D4).
PROVIDER_FINGERPRINT_EVENT = "provider_request_fingerprint"
FINGERPRINT_ALGO = "sha256"
#: PLAN-0679 design 4.3: an oversized document is replaced by a fail-open error
#: document instead of growing the event payload without bound.
FINGERPRINT_MAX_PAYLOAD_BYTES = 8192
FINGERPRINT_TOO_LARGE_REASON = "FINGERPRINT_TOO_LARGE"

_SHORT_ESCAPES: Final[dict[str, str]] = {
    '"': '\\"',
    "\\": "\\\\",
    "\b": "\\b",
    "\f": "\\f",
    "\n": "\\n",
    "\r": "\\r",
    "\t": "\\t",
}


class CanonicalValueError(ValueError):
    """The input cannot be canonicalized deterministically.

    Raised for unsupported types, non-string object keys, NaN/Infinity floats and strings
    containing lone surrogates (which have no UTF-8 form). Fail loud — a fingerprint built on
    an unstable input is worse than no fingerprint.
    """


def canonical_json(value: Any) -> str:
    """Serialize ``value`` to canonical JSON text (compact, key-sorted, numbers normalized)."""
    out: list[str] = []
    _write(value, out)
    return "".join(out)


def canonical_bytes(value: Any) -> bytes:
    """UTF-8 bytes of :func:`canonical_json`; rejects strings without a UTF-8 form."""
    text = canonical_json(value)
    try:
        return text.encode("utf-8")
    except UnicodeEncodeError as error:
        raise CanonicalValueError(f"string without UTF-8 form (lone surrogate?): {error}") from error


def sha256_hex(value: Any) -> str:
    """sha256 hex digest over the canonical UTF-8 bytes of ``value``."""
    return hashlib.sha256(canonical_bytes(value)).hexdigest()


def build_fingerprint_document(
    body: Mapping[str, Any],
    *,
    input_field: str,
    history_count: int,
    sampling_overrides: Mapping[str, Any] | None,
    image_part_count: int,
    provider_step: int,
    dispatch_attempt: int = 1,
) -> dict[str, Any]:
    """PLAN-0679 design 4.2: split the first dispatched native body into six layers.

    Only hashes/counts/bytes and configuration key names leave this function — never prompt
    content (D5). ``history_count`` is the caller's count of rendered historical native
    records (``len(values["conversation_history"])``); the template renders history records
    before the current-turn ones, which T0.3 verifies on a real stack (risk R1). If the
    count does not fit the rendered array the split clamps instead of failing: the
    ``outbound`` calibration layer still captures the complete body either way.
    """
    records = body.get(input_field)
    rendered = list(records) if isinstance(records, list) else []
    history_length = max(0, min(history_count, len(rendered)))
    history = rendered[:history_length]
    user_input = rendered[history_length:]

    # Static template remains after removing the rendered message array contents and the
    # tool schema contents; both are fingerprinted by their own layers.
    system_template = {key: value for key, value in body.items() if key not in (input_field, "tools")}
    tools = body.get("tools")
    tool_layer: dict[str, Any] = {"count": len(tools) if isinstance(tools, list) else 0}
    if tool_layer["count"]:
        tool_layer.update(_layer_summary(tools))

    overrides = dict(sampling_overrides or {})
    return {
        "algo": FINGERPRINT_ALGO,
        "dispatchAttempt": dispatch_attempt,
        "providerStep": provider_step,
        "layers": {
            "systemTemplate": _layer_summary(system_template),
            "history": {**_layer_summary(history), "count": len(history)},
            "userInput": _layer_summary(user_input),
            "toolSchema": tool_layer,
            "config": {
                **_layer_summary(overrides),
                "samplingKeys": sorted(str(key) for key in overrides),
                "imageParts": image_part_count,
            },
        },
        "outbound": _layer_summary(body),
    }


def fingerprint_event_payload(
    document: dict[str, Any],
    *,
    api_type_id: str = "",
    api_type_version: int | None = None,
    model: str = "",
    message_count: int = 0,
    tool_count: int = 0,
    bytes_total: int = 0,
    role_histogram: Mapping[str, int] | None = None,
) -> dict[str, Any]:
    """Bound the emitted payload (PLAN-0679 design 4.3): oversized documents fail open.

    Wire envelope: ``{"document": <six layers>, "request": <run metadata>}``. The ``request`` block
    carries the facts only the Agent holds about the final rendered body (api type, resolved model,
    message/tool counts, role histogram) so the CP can persist them verbatim instead of deriving
    them from something else (design D5: hash/count/byte/source metadata only, never prompt
    content).
    """
    request: dict[str, Any] = {
        "apiTypeId": api_type_id,
        "apiTypeVersion": api_type_version,
        "model": model,
        "messageCount": message_count,
        "toolCount": tool_count,
        "bytesTotal": bytes_total or document.get("outbound", {}).get("bytes", 0),
        "roleHistogram": dict(role_histogram or {}),
    }
    payload: dict[str, Any] = {"document": document, "request": request}
    encoded = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    if len(encoded) > FINGERPRINT_MAX_PAYLOAD_BYTES:
        # Fail open but keep the fact observable: the document slot becomes the error marker
        # (design 4.3), so the read side can name FINGERPRINT_TOO_LARGE instead of reporting the
        # run as merely not_captured (which means "no event arrived at all").
        return {
            "document": {"status": "error", "reasonCode": FINGERPRINT_TOO_LARGE_REASON},
            "request": request,
        }
    return payload


def role_histogram(records: Sequence[Any]) -> dict[str, int]:
    """Count textual ``role`` values of the rendered native records (metadata only, D5).

    Native records without a textual role field are skipped rather than bucketed under an invented
    role name, so an unsupported api type yields ``{}`` instead of a misleading count.
    """
    counts: dict[str, int] = {}
    for record in records:
        role = record.get("role") if isinstance(record, Mapping) else None
        if isinstance(role, str) and role:
            counts[role] = counts.get(role, 0) + 1
    return counts


def _layer_summary(value: Any) -> dict[str, Any]:
    encoded = canonical_bytes(value)
    return {"hash": hashlib.sha256(encoded).hexdigest(), "bytes": len(encoded)}


def strip_volatile(value: Any, keys: frozenset[str]) -> Any:
    """Return a copy of ``value`` with every dict entry whose key is in ``keys`` removed, recursively.

    Arrays keep order and position (removed keys do not collapse array entries). Used by the
    dispatch layer (T1.2) to drop known-volatile fields before hashing; the denylist itself is
    an evidence-backed decision, not baked in here.
    """
    if isinstance(value, dict):
        return {k: strip_volatile(v, keys) for k, v in value.items() if k not in keys}
    if isinstance(value, list):
        return [strip_volatile(item, keys) for item in value]
    return value


def _write(value: Any, out: list[str]) -> None:
    if value is None:
        out.append("null")
    elif value is True:
        out.append("true")
    elif value is False:
        out.append("false")
    elif isinstance(value, str):
        _write_string(value, out)
    elif isinstance(value, int):
        out.append(str(value))
    elif isinstance(value, float):
        out.append(_normalize_float(value))
    elif isinstance(value, dict):
        _write_object(value, out)
    elif isinstance(value, (list, tuple)):
        out.append("[")
        for index, item in enumerate(value):
            if index:
                out.append(",")
            _write(item, out)
        out.append("]")
    else:
        raise CanonicalValueError(f"unsupported type for canonical JSON: {type(value).__name__}")


def _write_object(value: dict[str, Any], out: list[str]) -> None:
    keys = list(value.keys())
    for key in keys:
        if not isinstance(key, str):
            raise CanonicalValueError(f"object keys must be strings, got {type(key).__name__}")
    out.append("{")
    for index, key in enumerate(sorted(keys, key=lambda k: k.encode("utf-8"))):
        if index:
            out.append(",")
        _write_string(key, out)
        out.append(":")
        _write(value[key], out)
    out.append("}")


def _write_string(value: str, out: list[str]) -> None:
    out.append('"')
    for char in value:
        escape = _SHORT_ESCAPES.get(char)
        if escape is not None:
            out.append(escape)
        elif ord(char) < 0x20:
            out.append(f"\\u{ord(char):04x}")
        else:
            out.append(char)
    out.append('"')


def _normalize_float(value: float) -> str:
    if math.isnan(value) or math.isinf(value):
        raise CanonicalValueError("NaN/Infinity cannot be canonicalized deterministically")
    if value == 0.0:
        return "0"  # merges 0.0, -0.0 and 0 into one token (0666 D6)
    # repr(float) is the shortest round-trip form; Decimal normalizes trailing zeros and
    # format(..., "f") keeps plain (non-exponent) notation so 1e23 stays fully spelled out.
    decimal = Decimal(repr(value)).normalize()
    if decimal == decimal.to_integral_value():
        return str(decimal.quantize(Decimal(1)))
    return format(decimal, "f")
