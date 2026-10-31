"""PLAN-0307 T2.7: per-run config overrides (merge, validation, no side effects)."""

import pytest

import xihe_agent.app_state as main
from xihe_agent.config_snapshot import process_config_snapshot
from xihe_agent.llm.base import ENV_PROVIDER_KEY_MAP, LLMConfig


def _snapshot():
    return process_config_snapshot(main.config_client)


class TestRunOverrideValidation:
    def test_missing_overrides_are_valid(self):
        assert main._validate_run_overrides(None, "userOverrides") is None

    def test_non_object_is_rejected(self):
        assert main._validate_run_overrides(["x"], "userOverrides") == ("userOverrides must be an object")

    def test_non_object_domain_is_rejected(self):
        assert (
            main._validate_run_overrides({"llm-provider": ["x"]}, "userOverrides")
            == "userOverrides.llm-provider must be an object"
        )

    def test_non_string_value_is_rejected(self):
        assert (
            main._validate_run_overrides({"llm-provider": {"timeout": 60}}, "userOverrides")
            == "userOverrides.llm-provider.timeout must be a string"
        )

    def test_valid_shape_passes(self):
        assert main._validate_run_overrides({"llm-provider": {"timeout": "60"}}, "userOverrides") is None


class TestRunOverrideNormalize:
    def test_invalid_shapes_become_empty(self):
        assert main._normalize_run_overrides(None) == {}
        assert main._normalize_run_overrides("nope") == {}
        assert main._normalize_run_overrides({"llm-provider": "nope"}) == {}

    def test_valid_shape_passes_through(self):
        assert main._normalize_run_overrides({"llm-provider": {"timeout": "60"}}) == {
            "llm-provider": {"timeout": "60"}
        }


class TestMergeRunDomain:
    def test_workspace_beats_user_beats_pulled_effective(self, monkeypatch: pytest.MonkeyPatch):
        monkeypatch.setattr(
            main.config_client,
            "_effective_cache",
            {"llm-provider": {"temperature": "0.9", "timeout": "30"}},
        )

        merged = main._merge_run_domain(
            _snapshot(),
            "llm-provider",
            {"llm-provider": {"temperature": "0.2", "maxTokens": "2048"}},
            {"llm-provider": {"temperature": "0.1"}},
        )

        assert merged["temperature"] == "0.1"
        assert merged["maxTokens"] == "2048"
        assert merged["timeout"] == "30"

    def test_has_no_side_effects_on_process_snapshot(self, monkeypatch: pytest.MonkeyPatch):
        snapshot = {"temperature": "0.9"}
        monkeypatch.setattr(main.config_client, "_effective_cache", {"llm-provider": snapshot})
        before = main.llm_config

        merged = main._merge_run_domain(
            _snapshot(), "llm-provider", {"llm-provider": {"temperature": "0.2"}}, {}
        )
        merged["temperature"] = "mutated"

        assert snapshot == {"temperature": "0.9"}
        assert main.llm_config is before

    def test_unknown_domain_returns_pulled_entries(self, monkeypatch: pytest.MonkeyPatch):
        monkeypatch.setattr(main.config_client, "_effective_cache", {"context-policy": {"a": "b"}})
        assert main._merge_run_domain(_snapshot(), "context-policy", {}, {}) == {"a": "b"}
        assert main._merge_run_domain(_snapshot(), "unknown", {}, {}) == {}


class TestLLMConfigFromEntries:
    def test_reads_profile_unit(self, monkeypatch: pytest.MonkeyPatch):
        for env_name in ENV_PROVIDER_KEY_MAP.values():
            monkeypatch.delenv(env_name, raising=False)

        cfg = LLMConfig.from_entries(
            {
                "profile": '{"providerId":"openai","connectionKey":"default","model":"gpt-4o-mini"}',
                # PLAN-0523 T3.6: layer-global sampling keys are retired — they
                # must be ignored (defaults win), never read.
                "timeout": "120",
                "maxTokens": "2048",
                "temperature": "0.1",
            }
        )

        assert cfg.provider == "openai"
        assert cfg.model == "gpt-4o-mini"
        assert cfg.timeout == 60.0
        assert cfg.max_tokens == 4096
        assert cfg.temperature == 0.7

    def test_profile_uses_env_fallback_key_and_ignores_legacy_keys(self, monkeypatch: pytest.MonkeyPatch):
        for env_name in ENV_PROVIDER_KEY_MAP.values():
            monkeypatch.delenv(env_name, raising=False)
        monkeypatch.delenv("XIHE_API_BASE", raising=False)
        monkeypatch.setenv("XIHE_XIAOMI_API_KEY", "sk-mimo")

        cfg = LLMConfig.from_entries(
            {
                "profile": '{"providerId":"xiaomi","connectionKey":"default","model":"mimo-v2.5"}',
                "defaultProvider": "deepseek",
                "xiaomiModel": "legacy-model-must-be-ignored",
                "xiaomiApiBase": "https://legacy.example/v1",
                "baseUrl": "https://legacy-shared.example/v1",
            }
        )

        assert cfg.provider == "xiaomi"
        assert cfg.model == "mimo-v2.5"
        assert cfg.api_key == "sk-mimo"
        assert cfg.api_base == "https://api.xiaomimimo.com/v1"

    def test_env_base_url_beats_provider_default(self, monkeypatch: pytest.MonkeyPatch):
        monkeypatch.setenv("XIHE_API_BASE", "https://proxy.example.test/v1")

        cfg = LLMConfig.from_entries(
            {"profile": '{"providerId":"deepseek","connectionKey":"default","model":"deepseek-chat"}'}
        )

        assert cfg.api_base == "https://proxy.example.test/v1"

    def test_no_profile_has_no_implicit_default(self, monkeypatch: pytest.MonkeyPatch):
        """PLAN-0504 decision #10: empty identity, readiness fails closed."""
        for env_name in ENV_PROVIDER_KEY_MAP.values():
            monkeypatch.delenv(env_name, raising=False)

        cfg = LLMConfig.from_entries({})

        assert cfg.provider == ""
        assert cfg.model == ""
        assert cfg.api_key == ""

    def test_malformed_profile_degrades_to_no_identity(self):
        cfg = LLMConfig.from_entries({"profile": "not-json"})

        assert cfg.provider == ""
        assert cfg.model == ""

    def test_partial_profile_degrades_to_no_identity(self):
        cfg = LLMConfig.from_entries({"profile": '{"providerId":"openai","model":"gpt-4o"}'})

        assert cfg.provider == ""
        assert cfg.model == ""
