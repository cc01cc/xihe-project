"""Log redaction at the loguru serialization boundary (PLAN-196 M1)."""

import re
from typing import Any

REDACTED = "***redacted***"

_VALUE_PATTERNS = [
    re.compile(r"Bearer\s+[A-Za-z0-9._~+/=-]+", re.IGNORECASE),
    re.compile(r"eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+"),
    re.compile(
        r"-----BEGIN [A-Z ]*PRIVATE KEY-----.*?-----END [A-Z ]*PRIVATE KEY-----",
        re.DOTALL,
    ),
]

_SENSITIVE_KEY = re.compile(
    r"^(token|key|secret|password|passwd|authorization|auth|cookie|"
    r"access_?token|refresh_?token|api_?key|service_?token|client_?secret|"
    r"pkce|verifier)$",
    re.IGNORECASE,
)


def redact_text(text: str) -> str:
    for pattern in _VALUE_PATTERNS:
        text = pattern.sub(REDACTED, text)
    return text


def redact_value(value: Any, depth: int = 0) -> Any:
    if depth > 6:
        return value
    if isinstance(value, str):
        return redact_text(value)
    if isinstance(value, dict):
        return {
            k: REDACTED if _SENSITIVE_KEY.match(str(k)) else redact_value(v, depth + 1)
            for k, v in value.items()
        }
    if isinstance(value, list):
        return [redact_value(v, depth + 1) for v in value]
    if isinstance(value, tuple):
        return tuple(redact_value(v, depth + 1) for v in value)
    return value


def patch_record(record: Any) -> None:
    record["message"] = redact_text(str(record["message"]))
    extra = record.get("extra")
    if extra:
        record["extra"] = redact_value(extra)
