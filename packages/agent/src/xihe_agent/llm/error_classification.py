"""Provider-failure classification: the single source of truth (task-27 / Q-45).

Both transports converge here:

* ``ApiSender.stream`` (raw httpx, the main chat path) calls
  :func:`classify_rejected_body` with the provider's own error bytes;
* ``app_state._classify_llm_exception`` (the litellm bypass: judge / worker /
  summarize) calls :func:`classify_provider_exception` with the exception's
  status, type name and message.

The classification is a **data table**, not scattered ``if`` statements: every
marker below is sourced from ``internal/A03-xihe/docs/q45-option-a-and-b.md``
§B2/§B3, whose machine-readable twin is
``internal/A03-xihe/evidence/2026-11-19-q45-overflow-classification/matcher-cases.json``
(12 cases + 8 counterexamples). The package test run cannot read ``internal/``,
so ``tests/unit/test_error_classification.py`` inlines the same 20 rows with
their ids, and asserts the counts.

Two boundaries the card fixes, encoded here:

* ``CONTEXT_OVERFLOW`` is **produced only by this module**. ``langgraph_runner``
  keeps its single event emission (the litellm ``ContextWindowExceededError``
  branch); the ``ApiRequestError`` branch only forwards ``terminal_code``, so the
  literal still appears exactly once in the runner.
* A 200 response is **never** an overflow. ``finish_reason=length`` with an empty
  body is the provider's silent truncation (task-113) and gets its own code,
  ``LLM_OUTPUT_TRUNCATED``, which is informational only: it must not trigger the
  CP compaction retry, because ``length`` can also be a normal ``max_tokens`` cut.

Known non-goals (recorded in ``spec/agent/execution.md``): stream-internal
truncation and truncated tool-call arguments keep their existing codes
(``LLM_PROVIDER_STREAM_TRUNCATED`` / ``LLM_TOOL_ARGUMENTS_TRUNCATED``).
"""

from __future__ import annotations

import json
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any

CONTEXT_OVERFLOW = "CONTEXT_OVERFLOW"
LLM_OUTPUT_TRUNCATED = "LLM_OUTPUT_TRUNCATED"
LLM_REQUEST_REJECTED = "LLM_REQUEST_REJECTED"
LLM_PROVIDER_UNREACHABLE = "LLM_PROVIDER_UNREACHABLE"
LLM_CREDENTIALS_INVALID = "LLM_CREDENTIALS_INVALID"
LLM_NOT_CONFIGURED = "LLM_NOT_CONFIGURED"
LLM_TOOL_ROUTE_UNSUPPORTED = "LLM_TOOL_ROUTE_UNSUPPORTED"
LLM_BASE_URL_MISSING = "LLM_BASE_URL_MISSING"
AGENT_STREAM_FAILED = "AGENT_STREAM_FAILED"

# B1 constraint 4: the error body is bounded before it is parsed. An oversized
# error page must not become an unbounded read on the failure path.
MAX_ERROR_BODY_BYTES = 64 * 1024

# B1 constraint 1: status precedence is unchanged (401/403, then >=500), and only
# 400/413 may take part in the whitelist. 422 is semantic validation, 429 is a
# rate limit; neither is ever a context window.
CREDENTIAL_STATUSES: frozenset[int] = frozenset({401, 403})
OVERFLOW_STATUSES: frozenset[int] = frozenset({400, 413})

# T1 -- exact error-code field value (OpenAI-compatible providers; the repo's own
# e2e fake provider emits this literal, fake-llm-server.mjs:597-604).
OVERFLOW_CODE_VALUES: frozenset[str] = frozenset({"context_length_exceeded"})

# T2 -- named phrases, matched case-insensitively inside JSON string values only
# (B1 constraint 3: never against an HTML/text outer shell). Each phrase is a
# literal from litellm's own mapping table (litellm_core_utils/
# exception_mapping_utils.py; line numbers in the doc's §B2 table).
OVERFLOW_PHRASES: tuple[str, ...] = (
    "this model's maximum context length is",
    "model's maximum context limit",
    "is longer than the model's context length",
    "input tokens exceed the configured limit",
    "exceed context limit",
    "exceeds the available context size",
    "exceeds the maximum number of tokens allowed",
    "prompt is too long",
    "prompt: length",
    "input is too long",
    "too many input tokens",
    "too many tokens",
    "expected maxlength:",
)

# Two-phrase patterns: every phrase in the group must be present. These are the
# places litellm itself ANDs two fragments (Cerebras, generic max-input-length).
OVERFLOW_PHRASE_GROUPS: tuple[tuple[str, ...], ...] = (
    ("current length is", "while limit is"),
    ("maximum input length is", "tokens"),
)

# B2 exclusions run BEFORE T1/T2: a field-length validation error is never a
# window, and it is the exact shape a naive "saw a length word" matcher misreads.
EXCLUSION_PHRASES: tuple[str, ...] = ("string_above_max_length",)
EXCLUSION_PHRASE_GROUPS: tuple[tuple[str, ...], ...] = (("invalid 'user'", "string too long"),)

# B2 param rule: a present ``param`` that is not one of the payload fields means
# some *argument* was rejected, so it cannot be a window even if a phrase matches.
SAFE_OVERFLOW_PARAMS: frozenset[str] = frozenset({"messages", "input", "prompt"})

# finish/stop reasons that mean "the provider stopped on the token budget".
# ``length`` is OpenAI-compatible, ``max_tokens`` is Anthropic.
TRUNCATION_FINISH_REASONS: frozenset[str] = frozenset({"length", "max_tokens"})

DETAIL_REJECTED = "模型提供方拒绝了该请求（消息格式或参数不被接受）"
DETAIL_CREDENTIALS = "Provider credentials were rejected"
DETAIL_UNREACHABLE = "Provider is unreachable"
DETAIL_TIMEOUT = "Provider request timed out"
DETAIL_NOT_CONFIGURED = "Provider credentials are not configured"
DETAIL_TOOL_ROUTE = "当前模型路由不支持工具调用：请改用 OpenAI 兼容连接，或更换支持工具的模型"
DETAIL_TRUNCATED = "provider returned an empty body with finish_reason=length"
DETAIL_STREAM_FAILED = "Agent stream failed"
DETAIL_CONTEXT_OVERFLOW = "Context window exceeded"


@dataclass(frozen=True)
class ClassifiedFailure:
    """The one shape both transports consume: code, safe detail, retryable."""

    code: str
    detail: str | None
    retryable: bool


_CONTEXT_OVERFLOW = ClassifiedFailure(CONTEXT_OVERFLOW, DETAIL_CONTEXT_OVERFLOW, True)
_REQUEST_REJECTED = ClassifiedFailure(LLM_REQUEST_REJECTED, DETAIL_REJECTED, False)
_CREDENTIALS_INVALID = ClassifiedFailure(LLM_CREDENTIALS_INVALID, DETAIL_CREDENTIALS, False)
_PROVIDER_UNREACHABLE = ClassifiedFailure(LLM_PROVIDER_UNREACHABLE, DETAIL_UNREACHABLE, True)
_STREAM_FAILED = ClassifiedFailure(AGENT_STREAM_FAILED, DETAIL_STREAM_FAILED, True)


def _matches_overflow_phrases(flat: str) -> bool:
    """Apply exclusions, then T1's code value is checked separately, then T2."""
    if any(phrase in flat for phrase in EXCLUSION_PHRASES):
        return False
    if any(all(phrase in flat for phrase in group) for group in EXCLUSION_PHRASE_GROUPS):
        return False
    if any(phrase in flat for phrase in OVERFLOW_PHRASES):
        return True
    return any(all(phrase in flat for phrase in group) for group in OVERFLOW_PHRASE_GROUPS)


def _decode_error_body(body: bytes) -> dict[str, Any] | None:
    """Parse the bounded error body; anything that is not a JSON object is unknown."""
    if not body:
        return None
    try:
        text = body[:MAX_ERROR_BODY_BYTES].decode("utf-8")
    except UnicodeError:
        return None
    try:
        document = json.loads(text)
    except ValueError:
        return None
    return document if isinstance(document, dict) else None


def _error_fields(document: dict[str, Any]) -> tuple[list[str], set[str], set[str]]:
    """Collect every JSON string value, plus the ``param`` and ``code`` fields."""
    strings: list[str] = []
    params: set[str] = set()
    codes: set[str] = set()
    stack: list[Any] = [document]
    while stack:
        node = stack.pop()
        if isinstance(node, dict):
            for key, value in node.items():
                if isinstance(value, str):
                    strings.append(value)
                    if key == "param":
                        params.add(value)
                    elif key == "code":
                        codes.add(value)
                elif isinstance(value, dict | list):
                    stack.append(value)
        elif isinstance(node, list):
            stack.extend(node)
    return strings, params, codes


def classify_rejected_body(status: int, body: bytes) -> ClassifiedFailure:
    """Classify a non-2xx provider response (the raw-httpx transport).

    Order is fixed by the card: status precedence -> exclusions -> T1 -> T2 ->
    fail closed. An unrecognised body is never an overflow; one false positive
    costs a real compaction plus a re-run (q45 doc §B6 R1).
    """
    if status in CREDENTIAL_STATUSES:
        return _CREDENTIALS_INVALID
    if status >= 500:
        return _PROVIDER_UNREACHABLE
    if status not in OVERFLOW_STATUSES:
        return _REQUEST_REJECTED
    document = _decode_error_body(body)
    if document is None:
        return _REQUEST_REJECTED
    strings, params, codes = _error_fields(document)
    if params and not params <= SAFE_OVERFLOW_PARAMS:
        return _REQUEST_REJECTED
    flat = "\n".join(strings).lower()
    if any(phrase in flat for phrase in EXCLUSION_PHRASES):
        return _REQUEST_REJECTED
    if any(all(phrase in flat for phrase in group) for group in EXCLUSION_PHRASE_GROUPS):
        return _REQUEST_REJECTED
    if codes & OVERFLOW_CODE_VALUES:
        return _CONTEXT_OVERFLOW
    return _CONTEXT_OVERFLOW if _matches_overflow_phrases(flat) else _REQUEST_REJECTED


@dataclass(frozen=True)
class ExceptionRule:
    """One ordered row of the exception table.

    A row matches when ANY declared criterion matches (the litellm classes and
    the textual markers are alternatives, exactly as the previous hand-written
    chain behaved). ``body_overflow`` then lets the row consult the same body
    matcher, so an overflow-shaped 400 cannot be flattened into REJECTED.
    """

    code: str
    detail: str | None
    retryable: bool
    error_types: frozenset[str] = frozenset()
    statuses: frozenset[int] = frozenset()
    markers: tuple[str, ...] = ()
    body_overflow: bool = False


# Ordering is behaviour: RouteConfig, then the tool-route rejection, then the
# provider's own 400 (the only row that may become CONTEXT_OVERFLOW), then the
# credential/timeout/connection markers, then the generic stream failure.
EXCEPTION_RULES: tuple[ExceptionRule, ...] = (
    ExceptionRule(LLM_BASE_URL_MISSING, None, False, error_types=frozenset({"LLMRouteConfigError"})),
    ExceptionRule(
        LLM_TOOL_ROUTE_UNSUPPORTED,
        DETAIL_TOOL_ROUTE,
        False,
        error_types=frozenset({"UnsupportedParamsError"}),
        markers=("unsupportedparams", "does not support parameters"),
    ),
    ExceptionRule(
        LLM_REQUEST_REJECTED,
        DETAIL_REJECTED,
        False,
        error_types=frozenset({"BadRequestError"}),
        statuses=frozenset({400}),
        body_overflow=True,
    ),
    ExceptionRule(
        LLM_NOT_CONFIGURED,
        DETAIL_NOT_CONFIGURED,
        True,
        markers=("missing credentials", "api key", "apikey"),
    ),
    ExceptionRule(
        LLM_CREDENTIALS_INVALID,
        DETAIL_CREDENTIALS,
        False,
        markers=("authentication", "unauthorized", "401", "403"),
    ),
    ExceptionRule(
        LLM_PROVIDER_UNREACHABLE,
        DETAIL_TIMEOUT,
        True,
        markers=("timeout", "timed out"),
    ),
    ExceptionRule(
        LLM_PROVIDER_UNREACHABLE,
        DETAIL_UNREACHABLE,
        True,
        markers=("connection", "connect", "dns", "unreachable"),
    ),
)


def classify_provider_exception(
    *, status_code: int | None, message: str, error_type: str = ""
) -> ClassifiedFailure:
    """Classify a provider exception (the litellm bypass transport).

    The caller passes the attributes instead of the exception object so this
    module stays dependency-free and unit-testable without litellm.
    """
    text = message.lower()
    for rule in EXCEPTION_RULES:
        matched = (
            (bool(rule.error_types) and error_type in rule.error_types)
            or (bool(rule.statuses) and status_code in rule.statuses)
            or (bool(rule.markers) and any(marker in text for marker in rule.markers))
        )
        if not matched:
            continue
        if rule.body_overflow and _matches_overflow_phrases(text):
            return _CONTEXT_OVERFLOW
        return ClassifiedFailure(rule.code, rule.detail, rule.retryable)
    return _STREAM_FAILED


def classify_output_truncation(
    *, finish_reason: str | None, text: str, calls: Sequence[object]
) -> ClassifiedFailure | None:
    """The 200 + silent-truncation shape (task-113); ``None`` means "not truncated".

    Only an EMPTY body counts. A non-empty body that stopped on ``length`` is
    indistinguishable from a normal ``max_tokens`` cut, and reporting it would
    invite a compaction retry that cannot help.
    """
    reason = (finish_reason or "").strip().lower()
    if reason not in TRUNCATION_FINISH_REASONS:
        return None
    if text or calls:
        return None
    return ClassifiedFailure(LLM_OUTPUT_TRUNCATED, DETAIL_TRUNCATED, False)
