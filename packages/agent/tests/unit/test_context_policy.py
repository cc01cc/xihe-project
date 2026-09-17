"""PLAN-0341 T1.6: context-policy resolution."""

from xihe_agent.context_policy import (
    DEFAULT_MAX_INPUT_TOKENS,
    DEFAULT_PRUNE_WINDOW_CHARS,
    resolve_context_policy,
)


def test_resolves_model_overrides_defaults() -> None:
    entries = {
        "defaults": '{"maxInputTokens": 100000, "pruneWindowChars": 40000}',
        "models": '{"gpt-4o": {"maxInputTokens": 128000, "pruneWindowChars": 90000}}',
    }
    policy = resolve_context_policy("gpt-4o", entries)
    assert policy.max_input_tokens == 128000
    assert policy.prune_window_chars == 90000
    assert policy.source == "config"


def test_falls_back_to_defaults_then_code() -> None:
    policy = resolve_context_policy("unknown-model", {})
    assert policy.max_input_tokens is None
    assert policy.prune_window_chars == DEFAULT_PRUNE_WINDOW_CHARS
    assert policy.source == "default"

    policy2 = resolve_context_policy(
        "m", {"defaults": '{"maxInputTokens": 200000}'}
    )
    assert policy2.max_input_tokens == 200000
    assert policy2.source == "config"


def test_rejects_untrusted_tokenizer_ref() -> None:
    entries = {
        "models": '{"m": {"tokenizerRef": "https://evil.example/tok"}}',
    }
    policy = resolve_context_policy("m", entries)
    assert policy.tokenizer_ref is None

    entries_ok = {"models": '{"m": {"tokenizerRef": "tiktoken:o200k_base"}}'}
    assert resolve_context_policy("m", entries_ok).tokenizer_ref == "tiktoken:o200k_base"


def test_ignores_malformed_json() -> None:
    policy = resolve_context_policy("m", {"defaults": "{not json"})
    assert policy.max_input_tokens is None
    assert policy.prune_window_chars == DEFAULT_PRUNE_WINDOW_CHARS


def test_default_max_is_conservative() -> None:
    assert DEFAULT_MAX_INPUT_TOKENS == 128_000
