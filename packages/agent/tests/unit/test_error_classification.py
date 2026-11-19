"""task-27 / Q-45: the single provider-failure classification (table parity).

The 20 rows below are the card's acceptance matrix, a literal copy of
``internal/A03-xihe/evidence/2026-11-19-q45-overflow-classification/matcher-cases.json``
(12 provider cases + 8 counterexamples). They are inlined because a package test
run cannot read the ``internal/`` tree; the comment beside each row is the case id.
"""

from __future__ import annotations

import json

import pytest

from xihe_agent.llm.error_classification import (
    AGENT_STREAM_FAILED,
    CONTEXT_OVERFLOW,
    LLM_BASE_URL_MISSING,
    LLM_CREDENTIALS_INVALID,
    LLM_NOT_CONFIGURED,
    LLM_OUTPUT_TRUNCATED,
    LLM_PROVIDER_UNREACHABLE,
    LLM_REQUEST_REJECTED,
    LLM_TOOL_ROUTE_UNSUPPORTED,
    MAX_ERROR_BODY_BYTES,
    classify_output_truncation,
    classify_provider_exception,
    classify_rejected_body,
)

# (case id, status, body, expected code) -- the 12 provider cases from matcher-cases.json.
PROVIDER_CASES = [
    (
        "openai-context-length-exceeded",
        400,
        {
            "error": {
                "message": "This model's maximum context length is 8192 tokens, however your messages resulted in 2400 tokens.",
                "type": "invalid_request_error",
                "param": "messages",
                "code": "context_length_exceeded",
            }
        },
        CONTEXT_OVERFLOW,
    ),
    (
        "openai-string-above-max-length-param-error",
        400,
        {
            "error": {
                "message": "Invalid value: string is too long, string_above_max_length",
                "param": "user",
                "code": "string_above_max_length",
            }
        },
        LLM_REQUEST_REJECTED,
    ),
    (
        "openai-invalid-user-string-too-long",
        400,
        {
            "error": {
                "message": "Invalid 'user': string too long. Expected a string with maximum length 64.",
                "param": "user",
                "code": None,
            }
        },
        LLM_REQUEST_REJECTED,
    ),
    (
        "anthropic-prompt-is-too-long",
        400,
        {
            "type": "error",
            "error": {
                "type": "invalid_request_error",
                "message": "prompt is too long: 210000 tokens > 200000 maximum",
            },
        },
        CONTEXT_OVERFLOW,
    ),
    (
        "anthropic-prompt-length",
        400,
        {"type": "error", "error": {"type": "invalid_request_error", "message": "prompt: length: 1..200000"}},
        CONTEXT_OVERFLOW,
    ),
    ("bedrock-input-is-too-long", 400, {"message": "Input is too long for requested model."}, CONTEXT_OVERFLOW),
    ("bedrock-too-many-input-tokens", 400, {"message": "Too many input tokens"}, CONTEXT_OVERFLOW),
    (
        "gemini-exceeds-maximum-tokens-allowed",
        400,
        {
            "error": {
                "code": 400,
                "message": "The input token count (1200000) exceeds the maximum number of tokens allowed (1048576).",
                "status": "INVALID_ARGUMENT",
            }
        },
        CONTEXT_OVERFLOW,
    ),
    (
        "llamacpp-exceeds-available-context-size",
        400,
        {"error": {"message": "the prompt exceeds the available context size"}},
        CONTEXT_OVERFLOW,
    ),
    (
        "cerebras-current-length-while-limit",
        400,
        {"error": {"message": "Current length is 9000 while limit is 8192"}},
        CONTEXT_OVERFLOW,
    ),
    (
        "azure-maximum-context-length",
        400,
        {
            "error": {
                "code": "context_length_exceeded",
                "message": "This model's maximum context length is 8192 tokens. However, you requested 2400 tokens.",
            }
        },
        CONTEXT_OVERFLOW,
    ),
    ("plain-text-bad-request", 400, b"bad request", LLM_REQUEST_REJECTED),
]

# (case id, status, body, expected code) -- the 8 counterexamples.
COUNTER_CASES = [
    (
        "n1-temperature-invalid-value",
        400,
        {"error": {"message": "Invalid value for 'temperature': 3", "param": "temperature", "code": "invalid_value"}},
        LLM_REQUEST_REJECTED,
    ),
    (
        "n3-422-field-required",
        422,
        {"detail": [{"loc": ["body", "messages"], "msg": "field required"}]},
        LLM_REQUEST_REJECTED,
    ),
    (
        "n4-413-html-exceed",
        413,
        b"<html><body>Request entity too large: payload may exceed the configured limit</body></html>",
        LLM_REQUEST_REJECTED,
    ),
    ("n5-empty-400-body", 400, b"", LLM_REQUEST_REJECTED),
    (
        "n6-unknown-tool-400",
        400,
        {"error": {"message": "tool 'read_context' is unknown"}},
        LLM_REQUEST_REJECTED,
    ),
    (
        "n7-500-with-overflow-phrase",
        500,
        {"error": {"message": "prompt is too long: upstream said so"}},
        LLM_PROVIDER_UNREACHABLE,
    ),
    (
        "n8-429-rate-limit",
        429,
        {"error": {"message": "rate limit reached, too many tokens per minute"}},
        LLM_REQUEST_REJECTED,
    ),
    (
        "n9-413-with-real-overflow-body",
        413,
        {"error": {"message": "This model's maximum context length is 8192 tokens.", "code": "context_length_exceeded"}},
        CONTEXT_OVERFLOW,
    ),
]

MATRIX = [
    *(("provider", *row) for row in PROVIDER_CASES),
    *(("counterexample", *row) for row in COUNTER_CASES),
]


def _raw(body):
    return body if isinstance(body, bytes) else json.dumps(body).encode()


@pytest.mark.parametrize(("group", "case_id", "status", "body", "expected"), MATRIX, ids=[row[1] for row in MATRIX])
def test_matcher_cases(group, case_id, status, body, expected):
    failure = classify_rejected_body(status, _raw(body))
    assert failure.code == expected, case_id
    # Only a context window (and an unreachable provider) may be retryable; a plain
    # rejection never is, because retrying it just burns the same request again.
    if expected == CONTEXT_OVERFLOW:
        assert failure.retryable is True, case_id
    elif expected == LLM_REQUEST_REJECTED:
        assert failure.retryable is False, case_id


def test_matrix_size_matches_the_recorded_cases():
    assert len(PROVIDER_CASES) == 12
    assert len(COUNTER_CASES) == 8


def test_status_precedence_is_unchanged():
    overflow_body = _raw(PROVIDER_CASES[0][2])
    assert classify_rejected_body(401, overflow_body).code == LLM_CREDENTIALS_INVALID
    assert classify_rejected_body(403, overflow_body).code == LLM_CREDENTIALS_INVALID
    assert classify_rejected_body(502, overflow_body).code == LLM_PROVIDER_UNREACHABLE
    # 429 is a rate limit, not a window, even with an overflow-shaped body.
    assert classify_rejected_body(429, overflow_body).code == LLM_REQUEST_REJECTED


def test_param_rule_beats_a_phrase_match():
    body = {
        "error": {
            "message": "This model's maximum context length is 8192 tokens",
            "param": "temperature",
        }
    }
    assert classify_rejected_body(400, _raw(body)).code == LLM_REQUEST_REJECTED


def test_code_value_is_read_anywhere_in_the_document():
    body = {"error": {"message": "no phrase here at all", "code": "context_length_exceeded"}}
    assert classify_rejected_body(400, _raw(body)).code == CONTEXT_OVERFLOW


def test_oversized_error_body_is_bounded_and_fails_closed():
    """The phrase beyond the read window is never seen, so the answer is REJECTED."""
    filler = "x" * (MAX_ERROR_BODY_BYTES + 16)
    body = json.dumps({"error": {"message": filler, "detail": "prompt is too long: 1 tokens"}}).encode()
    assert len(body) > MAX_ERROR_BODY_BYTES
    assert classify_rejected_body(400, body).code == LLM_REQUEST_REJECTED


@pytest.mark.parametrize(
    ("finish_reason", "text", "calls", "expected"),
    [
        ("length", "", [], LLM_OUTPUT_TRUNCATED),
        ("MAX_TOKENS", "", [], LLM_OUTPUT_TRUNCATED),
        ("length", "partial answer", [], None),
        ("length", "", [{"id": "c1", "name": "read_file", "args": {}, "type": "tool_call"}], None),
        ("stop", "", [], None),
        (None, "", [], None),
    ],
)
def test_output_truncation_needs_an_empty_body(finish_reason, text, calls, expected):
    failure = classify_output_truncation(finish_reason=finish_reason, text=text, calls=calls)
    assert (failure.code if failure else None) == expected


def test_output_truncation_is_never_an_overflow():
    failure = classify_output_truncation(finish_reason="length", text="", calls=[])
    assert failure is not None
    assert failure.code == LLM_OUTPUT_TRUNCATED
    assert failure.retryable is False  # informational: compaction cannot help


def test_exception_table_keeps_the_previous_classes():
    missing = classify_provider_exception(status_code=None, message="route", error_type="LLMRouteConfigError")
    assert (missing.code, missing.retryable) == (LLM_BASE_URL_MISSING, False)
    unsupported = classify_provider_exception(
        status_code=None, message="unsupportedparams: tools", error_type="BadRequestError"
    )
    assert (unsupported.code, unsupported.retryable) == (LLM_TOOL_ROUTE_UNSUPPORTED, False)
    credentials = classify_provider_exception(
        status_code=None, message="Authentication failed", error_type="RuntimeError"
    )
    assert (credentials.code, credentials.retryable) == (LLM_CREDENTIALS_INVALID, False)
    not_configured = classify_provider_exception(
        status_code=None, message="Missing credentials", error_type="RuntimeError"
    )
    assert (not_configured.code, not_configured.retryable) == (LLM_NOT_CONFIGURED, True)
    timeout = classify_provider_exception(status_code=None, message="request timed out", error_type="TimeoutError")
    assert (timeout.code, timeout.retryable) == (LLM_PROVIDER_UNREACHABLE, True)
    generic = classify_provider_exception(status_code=None, message="boom", error_type="RuntimeError")
    assert (generic.code, generic.retryable) == (AGENT_STREAM_FAILED, True)


def test_exception_table_reaches_overflow_for_a_provider_400():
    overflow_message = PROVIDER_CASES[0][2]["error"]["message"]
    failure = classify_provider_exception(
        status_code=400, message=overflow_message, error_type="BadRequestError"
    )
    assert (failure.code, failure.retryable) == (CONTEXT_OVERFLOW, True)
    plain = classify_provider_exception(
        status_code=400, message="Invalid request parameters", error_type="BadRequestError"
    )
    assert (plain.code, plain.retryable) == (LLM_REQUEST_REJECTED, False)
