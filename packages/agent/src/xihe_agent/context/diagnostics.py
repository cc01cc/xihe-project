"""PLAN-0342 M1: L0 diagnostic extraction, dedup ledger and budget helpers.

The Agent is the single place where raw command output turns into structured
diagnostics (decision #13: language knowledge never moves into the Runtime).
This module stays pure:

- :func:`extract_command_result` tolerantly reads the Runtime ``CommandResult``
  JSON text (top level or nested under ``result`` / ``data`` / ``tool_result``).
- :func:`extract_diagnostics` applies the frozen L0 rule
  ``path:line[:col]: message`` plus the conservative ``severity`` / ``kind``
  mapping. A miss degrades to an empty list (L2): the raw output is never
  rewritten or guessed at.
- :class:`DiagnosticsLedger` is the session-scoped continuous-duplicate
  suppression ledger (decisions #3/#5); identity = position key
  ``(file, line, column)``.
- budget helpers: Top-N 20, single message 1k, head/tail 48k middle truncation.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import Any, Literal

from loguru import logger

Severity = Literal["error", "warning", "note"]
DiagnosticKind = Literal["compile", "test", "lint", "runtime"]
Confidence = Literal["high", "low"]

# Plan-level budget package (PLAN-0342 decision #6).
TOP_N = 20
MESSAGE_LIMIT = 1000
OUTPUT_LIMIT = 48_000

# Bounded ledger growth (round-15 P2-4): oldest session evicted beyond the cap.
_MAX_SESSIONS = 512

# L0 shape (T0.4 freeze): anchored ``path:line[:col]: message``. The path
# segment excludes ``:`` and whitespace so timestamps / URLs / prefixed log
# lines cannot masquerade as a location.
_L0_PATTERN = re.compile(
    r"^(?P<path>[^:\s]+):(?P<line>[1-9]\d{0,8})(?::(?P<col>[1-9]\d{0,8}))?:\s?(?P<message>.*)$"
)
_EXTENSION_PATTERN = re.compile(r"\.[A-Za-z0-9]{1,8}$")
_SEVERITY_PATTERN = re.compile(r"^(error|warning|warn|note)\b", re.IGNORECASE)
_KIND_PATTERNS: tuple[tuple[DiagnosticKind, re.Pattern[str]], ...] = (
    ("test", re.compile(r"\b(?:test|pytest|vitest|jest)\b", re.IGNORECASE)),
    ("compile", re.compile(r"\b(?:build|compile|cargo|tsc|javac|mvn|gradle)\b", re.IGNORECASE)),
    ("lint", re.compile(r"\b(?:lint|ruff|clippy|eslint|oxlint)\b", re.IGNORECASE)),
)

_SEVERITY_ORDER: dict[str, int] = {"error": 0, "warning": 1, "note": 2}

# Tolerant CommandResult envelopes seen in practice (PLAN-0308 M1 smoke:
# ``{"ok": true, "result": {...}}``; CPEventStore relays may add ``data``).
_NESTED_RESULT_KEYS = ("result", "data", "tool_result")
_MAX_NESTING_DEPTH = 4


@dataclass(frozen=True)
class Diagnostic:
    """One structured diagnostic item (spec §1)."""

    file: str | None
    line: int | None
    column: int | None
    severity: Severity
    kind: DiagnosticKind | None
    message: str
    confidence: Confidence

    def to_payload(self) -> dict[str, Any]:
        return {
            "file": self.file,
            "line": self.line,
            "column": self.column,
            "severity": self.severity,
            "kind": self.kind,
            "message": self.message,
            "confidence": self.confidence,
        }


def identity_key(item: Diagnostic) -> tuple[str, str, str]:
    """Position identity ``(file, line, column)`` with ``-`` for missing parts."""
    file_key = item.file if item.file else "-"
    line_key = str(item.line) if item.line is not None else "-"
    column_key = str(item.column) if item.column is not None else "-"
    return file_key, line_key, column_key


def _coerce_int(value: Any) -> int | None:
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value) if value.is_integer() else None
    if isinstance(value, str):
        try:
            return int(value.strip())
        except ValueError:
            return None
    return None


def _locate_command_payload(payload: Any, depth: int = 0) -> dict[str, Any] | None:
    if not isinstance(payload, dict) or depth > _MAX_NESTING_DEPTH:
        return None
    raw_exit = payload.get("exit_code", payload.get("exitCode"))
    if _coerce_int(raw_exit) is not None:
        return payload
    for key in _NESTED_RESULT_KEYS:
        found = _locate_command_payload(payload.get(key), depth + 1)
        if found is not None:
            return found
    return None


def _as_text(value: Any) -> str:
    if isinstance(value, str):
        return value
    if value is None:
        return ""
    return str(value)


def extract_command_result(content: str) -> tuple[str, str, int] | None:
    """Read ``(stdout, stderr, exit_code)`` from Runtime ``CommandResult`` text.

    Content that is not JSON (plain tool text) or carries no usable exit code
    returns ``None`` — not every tool result is a command result.
    """
    if not content or not content.strip():
        return None
    try:
        payload = json.loads(content)
    except Exception as e:
        logger.debug("diagnostics: tool content is not JSON command result: {}", e)
        return None
    located = _locate_command_payload(payload)
    if located is None:
        return None
    raw_exit = located.get("exit_code", located.get("exitCode"))
    exit_code = _coerce_int(raw_exit)
    if exit_code is None:
        logger.warning("diagnostics: unusable exit_code in command result: {!r}", raw_exit)
        return None
    return _as_text(located.get("stdout")), _as_text(located.get("stderr")), exit_code


def _is_path_like(path: str) -> bool:
    """T0.4 freeze: contains ``/`` (after ``\\`` normalization) or ``name.ext``."""
    if not path:
        return False
    if "/" in path:
        return True
    return _EXTENSION_PATTERN.search(path) is not None


def _severity_of(message: str) -> Severity:
    match = _SEVERITY_PATTERN.match(message)
    if match is None:
        return "error"
    word = match.group(1).lower()
    if word == "note":
        return "note"
    if word in ("warning", "warn"):
        return "warning"
    return "error"


def _infer_kind(command: str | None) -> DiagnosticKind | None:
    if command is None or not command.strip():
        return None
    for kind, pattern in _KIND_PATTERNS:
        if pattern.search(command):
            return kind
    return "runtime"


def _parse_line(line: str, kind: DiagnosticKind | None) -> Diagnostic | None:
    match = _L0_PATTERN.match(line)
    if match is None:
        return None
    path = match.group("path").strip().replace("\\", "/")
    if not _is_path_like(path):
        return None
    message = match.group("message").strip()
    if not message:
        return None
    column_raw = match.group("col")
    return Diagnostic(
        file=path,
        line=int(match.group("line")),
        column=int(column_raw) if column_raw is not None else None,
        severity=_severity_of(message),
        kind=kind,
        message=truncate_message(message),
        confidence="high",
    )


def sort_diagnostics(items: list[Diagnostic]) -> list[Diagnostic]:
    """Order by severity (error < warning < note) → file → line → column."""
    return sorted(
        items,
        key=lambda item: (
            _SEVERITY_ORDER.get(item.severity, len(_SEVERITY_ORDER)),
            item.file or "",
            item.line if item.line is not None else 0,
            item.column if item.column is not None else 0,
        ),
    )


def extract_diagnostics(
    stdout: str,
    stderr: str,
    exit_code: int,
    command: str | None = None,
) -> list[Diagnostic]:
    """L0 extraction for a failed command; ``[]`` (L2) when nothing matches.

    Only non-zero exits trigger parsing (PLAN-0342 spec §2); the callers keep
    the original output untouched either way.
    """
    if exit_code == 0:
        return []
    kind = _infer_kind(command)
    items: list[Diagnostic] = []
    for stream in (stdout, stderr):
        if not stream:
            continue
        for raw_line in stream.splitlines():
            item = _parse_line(raw_line, kind)
            if item is not None:
                items.append(item)
    return sort_diagnostics(items)


class DiagnosticsLedger:
    """Session-scoped continuous-duplicate suppression (decisions #3/#5).

    ``new_items`` compares against the diagnostics observed in the most recent
    feedback pass and records the current pass in full, so a diagnostic that
    disappeared (fixed) and later reappears counts as new again while a
    continuously repeated one is only fed back once.

    The ledger is a process-level hint, never authoritative: it is bounded to
    ``_MAX_SESSIONS`` entries and evicts the oldest session first (round-15
    P2-4). A restart or an eviction only loses dedup state (extra noise), never
    correctness.
    """

    def __init__(self) -> None:
        self._sessions: dict[str, set[tuple[str, str, str]]] = {}

    def new_items(self, session_id: str, items: list[Diagnostic]) -> list[Diagnostic]:
        key = session_id or "-"
        observed = {identity_key(item) for item in items}
        previous = self._sessions.get(key, set())
        if key not in self._sessions and len(self._sessions) >= _MAX_SESSIONS:
            self._sessions.pop(next(iter(self._sessions)), None)
        self._sessions[key] = observed
        return [item for item in items if identity_key(item) not in previous]

    def reset(self, session_id: str | None = None) -> None:
        if session_id is None:
            self._sessions.clear()
        else:
            self._sessions.pop(session_id or "-", None)


_DEFAULT_LEDGER: DiagnosticsLedger | None = None


def get_diagnostics_ledger() -> DiagnosticsLedger:
    """Process-level session ledger (same shape as ``cancel_registry``)."""
    global _DEFAULT_LEDGER
    if _DEFAULT_LEDGER is None:
        _DEFAULT_LEDGER = DiagnosticsLedger()
    return _DEFAULT_LEDGER


def make_bundle(
    items: list[Diagnostic],
    total: int,
    confidence: Confidence,
) -> dict[str, Any]:
    """Bundle JSON: items (≤ Top-N), total (pre-truncation count), confidence."""
    return {
        "items": [item.to_payload() for item in items[:TOP_N]],
        "total": int(total),
        "confidence": confidence,
    }


def _format_position(item: Diagnostic) -> str:
    file_part = item.file if item.file else "-"
    if item.line is None:
        return file_part
    position = f"{file_part}:{item.line}"
    if item.column is not None:
        position = f"{position}:{item.column}"
    return position


def _as_diagnostic(item: Diagnostic | dict[str, Any]) -> Diagnostic:
    """Accept either a dataclass or its payload dict (bundle channel shape)."""
    if isinstance(item, Diagnostic):
        return item
    return Diagnostic(
        file=item.get("file"),
        line=item.get("line"),
        column=item.get("column"),
        severity=item.get("severity", "error"),
        kind=item.get("kind"),
        message=item.get("message", ""),
        confidence=item.get("confidence", "low"),
    )


def format_diagnostics_block(top_items: list[Diagnostic | dict[str, Any]], total: int) -> str:
    """Model-visible block; the caller places it inside the untrusted envelope."""
    shown = [_as_diagnostic(item) for item in top_items[:TOP_N]]
    lines = ["<diagnostics>"]
    for item in shown:
        lines.append(f"- {_format_position(item)} [{item.severity}] {item.message}")
    hidden = max(0, total - len(shown))
    if hidden:
        lines.append(f"(另有 {hidden} 条)")
    lines.append("</diagnostics>")
    return "\n".join(lines)


def truncate_middle(text: str, limit: int = OUTPUT_LIMIT) -> str:
    """Keep head/tail and replace the middle with a recovery marker."""
    if limit <= 0 or len(text) <= limit:
        return text
    head_len = limit // 2
    tail_len = limit - head_len
    dropped = len(text) - limit
    marker = f"\n…[中段已截断 {dropped} 字符]…\n"
    if tail_len <= 0:
        return f"{text[:head_len]}{marker}"
    return f"{text[:head_len]}{marker}{text[-tail_len:]}"


def truncate_message(text: str, limit: int = MESSAGE_LIMIT) -> str:
    """Truncate an over-long single diagnostic message with an explicit note."""
    if limit <= 0 or len(text) <= limit:
        return text
    dropped = len(text) - limit
    return f"{text[:limit]} …[已截断 {dropped} 字符]"
