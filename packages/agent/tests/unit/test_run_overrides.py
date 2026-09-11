"""PLAN-0307 T2.7: per-run config overrides (merge, validation, no side effects)."""

import pytest

from xihe_agent import main
from xihe_agent.llm.base import ENV_PROVIDER_KEY_MAP, LLMConfig


class TestRunOverrideValidation:
    def test_missing_overrides_are_valid(self):
        assert main._validate_run_overrides(None, "userOverrides") is None

    def test_non_object_is_rejected(self):
        assert main._validate_run_overrides(["x"], "userOverrides") == (
            "userOverrides must be an object"
        )

    def test_non_object_domain_is_rejected(self):
        assert main._validate_run_overrides(
            {"llm-provider": ["x"]}, "userOverrides"
        ) == "userOverrides.llm-provider must be an object"

    def test_non_string_value_is_rejected(self):
        assert main._validate_run_overrides(
            {"llm-provider": {"timeout": 60}}, "userOverrides"
        ) == "userOverrides.llm-provider.timeout must be a string"

    def test_valid_shape_passes(self):
        assert main._validate_run_overrides(
            {"llm-provider": {"defaultModel": "mimo-v2.5"}}, "userOverrides"
        ) is None


class TestRunOverrideNormalize:
    def test_invalid_shapes_become_empty(self):
        assert main._normalize_run_overrides(None) == {}
        assert main._normalize_run_overrides("nope") == {}
        assert main._normalize_run_overrides({"llm-provider": "nope"}) == {}

    def test_valid_shape_passes_through(self):
        assert main._normalize_run_overrides(
            {"llm-provider": {"defaultModel": "mimo-v2.5"}}
        ) == {"llm-provider": {"defaultModel": "mimo-v2.5"}}


class TestMergeRunDomain:
    def test_workspace_beats_user_beats_pulled_effective(self, monkeypatch: pytest.MonkeyPatch):
        monkeypatch.setattr(
            main.config_client,
            "get_domain",
            lambda domain: (
                {"defaultProvider": "deepseek", "timeout": "30"}
                if domain == "llm-provider"
                else {}
            ),
        )

        merged = main._merge_run_domain(
            "llm-provider",
            {"llm-provider": {"defaultProvider": "xiaomi", "temperature": "0.2"}},
            {"llm-provider": {"defaultProvider": "openai"}},
        )

        assert merged["defaultProvider"] == "openai"
        assert merged["temperature"] == "0.2"
        assert merged["timeout"] == "30"

    def test_has_no_side_effects_on_process_snapshot(self, monkeypatch: pytest.MonkeyPatch):
        snapshot = {"defaultProvider": "deepseek"}
        monkeypatch.setattr(main.config_client, "get_domain", lambda domain: snapshot)
        before = main.llm_config

        merged = main._merge_run_domain(
            "llm-provider", {"llm-provider": {"defaultProvider": "xiaomi"}}, {}
        )
        merged["defaultProvider"] = "mutated"

        assert snapshot == {"defaultProvider": "deepseek"}
        assert main.llm_config is before

    def test_unknown_domain_returns_pulled_entries(self, monkeypatch: pytest.MonkeyPatch):
        monkeypatch.setattr(main.config_client, "get_domain", lambda domain: {"a": "b"})
        assert main._merge_run_domain("unknown", {}, {}) == {"a": "b"}


class TestLLMConfigFromEntries:
    def test_parses_run_merged_entries(self, monkeypatch: pytest.MonkeyPatch):
        for env_name in ENV_PROVIDER_KEY_MAP.values():
            monkeypatch.delenv(env_name, raising=False)

        cfg = LLMConfig.from_entries({
            "defaultProvider": "openai",
            "defaultModel": "gpt-4o-mini",
            "timeout": "120",
            "maxTokens": "2048",
            "temperature": "0.1",
        })

        assert cfg.provider == "openai"
        assert cfg.model == "gpt-4o-mini"
        assert cfg.timeout == 120.0
        assert cfg.max_tokens == 2048
        assert cfg.temperature == 0.1

    def test_user_override_switches_provider_and_uses_env_fallback_key(
        self, monkeypatch: pytest.MonkeyPatch
    ):
        for env_name in ENV_PROVIDER_KEY_MAP.values():
            monkeypatch.delenv(env_name, raising=False)
        monkeypatch.setenv("XIHE_XIAOMI_API_KEY", "sk-mimo")

        base = {"defaultProvider": "deepseek", "deepseekModel": "deepseek-v4-flash"}
        merged = {
            **base,
            "defaultProvider": "xiaomi",
            "xiaomiModel": "mimo-v2.5",
        }

        cfg = LLMConfig.from_entries(merged)

        assert cfg.provider == "xiaomi"
        assert cfg.model == "mimo-v2.5"
        assert cfg.api_key == "sk-mimo"
