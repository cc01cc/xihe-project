"""Tests for xihe_agent.llm.base — LLMConfig, create_llm, and provider routing."""


import pytest
from langchain_core.messages import HumanMessage

from xihe_agent.config_client import ConfigClient
from xihe_agent.interfaces.llm import LLMProvider, LLMRequest
from xihe_agent.llm.base import (
    ENV_PROVIDER_KEY_MAP,
    LLMConfig,
    MockChatModel,
    XiheLiteLLM,
    create_llm,
    default_api_base,
    env_api_key,
    fallback_provider_configs,
    resolve_provider_base_url,
)


class TestLLMConfig:
    """LLMConfig construction and environment variable parsing."""

    def test_default_config(self):
        """When no env vars are set, default to deepseek."""
        cfg = LLMConfig()
        assert cfg.provider == "deepseek"
        assert cfg.model == ""
        assert cfg.api_key == ""
        assert cfg.api_base == ""
        assert cfg.timeout == 60.0
        assert cfg.max_tokens == 4096
        assert cfg.temperature == 0.7

    def test_from_env_with_provider(self, monkeypatch: pytest.MonkeyPatch):
        """XIHE_LLM_PROVIDER sets the provider."""
        monkeypatch.setenv("XIHE_LLM_PROVIDER", "openai")
        monkeypatch.setenv("XIHE_OPENAI_API_KEY", "sk-test")
        monkeypatch.setenv("XIHE_MODEL", "gpt-4o")

        cfg = LLMConfig.from_env()
        assert cfg.provider == "openai"
        assert cfg.model == "gpt-4o"
        assert cfg.api_key == "sk-test"

    def test_from_env_with_model_auto_detect(self, monkeypatch: pytest.MonkeyPatch):
        """When XIHE_MODEL matches a known pattern, provider is auto-detected."""
        monkeypatch.setenv("XIHE_MODEL", "deepseek-chat")
        monkeypatch.setenv("XIHE_DEEPSEEK_API_KEY", "sk-ds")

        cfg = LLMConfig.from_env()
        assert cfg.provider == "deepseek"
        assert cfg.model == "deepseek-chat"
        assert cfg.api_key == "sk-ds"

    def test_from_env_falls_back_to_mock(self, monkeypatch: pytest.MonkeyPatch):
        """Without any provider or model config, fall back to mock."""
        monkeypatch.delenv("XIHE_LLM_PROVIDER", raising=False)
        monkeypatch.delenv("XIHE_MODEL", raising=False)

        cfg = LLMConfig.from_env()
        assert cfg.provider == "mock"

    def test_api_base_from_env(self, monkeypatch: pytest.MonkeyPatch):
        """XIHE_API_BASE overrides provider default."""
        monkeypatch.setenv("XIHE_LLM_PROVIDER", "openai")
        monkeypatch.setenv("XIHE_API_BASE", "https://custom-proxy.example.com/v1")

        cfg = LLMConfig.from_env()
        assert cfg.api_base == "https://custom-proxy.example.com/v1"

    def test_api_base_trailing_slash_stripped(self, monkeypatch: pytest.MonkeyPatch):
        """Trailing slash on api_base is stripped."""
        monkeypatch.setenv("XIHE_LLM_PROVIDER", "deepseek")
        monkeypatch.setenv("XIHE_API_BASE", "https://api.deepseek.com/v1/")

        cfg = LLMConfig.from_env()
        assert cfg.api_base == "https://api.deepseek.com/v1"

    def test_numeric_env_vars(self, monkeypatch: pytest.MonkeyPatch):
        """Timeout, max_tokens, temperature parse from env."""
        monkeypatch.setenv("XIHE_LLM_TIMEOUT", "120")
        monkeypatch.setenv("XIHE_MAX_TOKENS", "8192")
        monkeypatch.setenv("XIHE_TEMPERATURE", "0.3")

        cfg = LLMConfig.from_env()
        assert cfg.timeout == 120.0
        assert cfg.max_tokens == 8192
        assert cfg.temperature == 0.3

    def test_model_defaults_from_provider(self, monkeypatch: pytest.MonkeyPatch):
        """When provider is set but model is not, use provider default model."""
        monkeypatch.setenv("XIHE_LLM_PROVIDER", "deepseek")
        monkeypatch.delenv("XIHE_MODEL", raising=False)

        cfg = LLMConfig.from_env()
        assert cfg.model == "deepseek-chat"
        assert cfg.api_base == "https://api.deepseek.com/v1"

    def test_xiaomi_in_provider_defaults(self, monkeypatch: pytest.MonkeyPatch):
        """Xiaomi has defaults in PROVIDER_DEFAULTS."""
        monkeypatch.setenv("XIHE_LLM_PROVIDER", "xiaomi")
        monkeypatch.delenv("XIHE_MODEL", raising=False)

        cfg = LLMConfig.from_env()
        assert cfg.provider == "xiaomi"
        assert cfg.model == "mimo-v2.5"
        assert cfg.api_base == "https://api.xiaomimimo.com/v1"

    def test_from_config_client_uses_xiaomi_specific_values(
        self, monkeypatch: pytest.MonkeyPatch
    ):
        monkeypatch.setenv("XIHE_XIAOMI_API_KEY", "sk-mimo-env")
        client = ConfigClient("http://test-cp", "test-token")
        client._effective_cache["llm-provider"] = {
            "defaultProvider": "xiaomi",
            "xiaomiApiBase": "https://api.xiaomimimo.com/v1",
            "xiaomiModel": "mimo-v2.5",
            "defaultModel": "deepseek-chat",
        }
        cfg = LLMConfig.from_config_client(client)

        assert cfg.provider == "xiaomi"
        assert cfg.api_key == "sk-mimo-env"
        assert cfg.api_base == "https://api.xiaomimimo.com/v1"
        assert cfg.model == "mimo-v2.5"

    def test_from_config_client_ignores_config_api_keys(
        self, monkeypatch: pytest.MonkeyPatch
    ):
        """PLAN-0307 T2.13: config `*ApiKey` entries are never consumed."""
        monkeypatch.setenv("XIHE_XIAOMI_API_KEY", "sk-mimo-env")
        client = ConfigClient("http://test-cp", "test-token")
        client._effective_cache["llm-provider"] = {
            "defaultProvider": "xiaomi",
            "xiaomiApiKey": "sk-from-config-must-be-ignored",
            "xiaomiApiBase": "https://api.xiaomimimo.com/v1",
            "xiaomiModel": "mimo-v2.5",
        }
        cfg = LLMConfig.from_config_client(client)

        assert cfg.api_key == "sk-mimo-env"

    def test_from_config_client_keeps_explicit_provider_with_different_user_model(
        self, monkeypatch: pytest.MonkeyPatch
    ):
        for env_name in ENV_PROVIDER_KEY_MAP.values():
            monkeypatch.delenv(env_name, raising=False)
        client = ConfigClient("http://test-cp", "test-token")
        client._effective_cache["llm-provider"] = {
            "defaultProvider": "deepseek",
            "defaultModel": "mimo-v2.5",
        }

        cfg = LLMConfig.from_config_client(client)

        assert cfg.provider == "deepseek"
        assert cfg.api_key == ""
        assert cfg.model == "mimo-v2.5"


class TestFallbackProviderConfigs:
    """PLAN-0307 T2.13: env-keyed offline provider registry (decision #21)."""

    def test_returns_env_keyed_providers_with_config_base(
        self, monkeypatch: pytest.MonkeyPatch
    ):
        for env_name in ENV_PROVIDER_KEY_MAP.values():
            monkeypatch.delenv(env_name, raising=False)
        monkeypatch.setenv("XIHE_XIAOMI_API_KEY", "sk-mimo")

        registry = fallback_provider_configs({
            "xiaomiApiBase": "https://api.xiaomimimo.com/v1",
            "xiaomiModel": "mimo-v2.5",
        })

        assert registry == {
            "xiaomi": {
                "provider": "xiaomi",
                "apiKey": "sk-mimo",
                "baseUrl": "https://api.xiaomimimo.com/v1",
                "model": "mimo-v2.5",
            }
        }

    def test_base_url_falls_back_to_provider_default(
        self, monkeypatch: pytest.MonkeyPatch
    ):
        for env_name in ENV_PROVIDER_KEY_MAP.values():
            monkeypatch.delenv(env_name, raising=False)
        monkeypatch.setenv("XIHE_DEEPSEEK_API_KEY", "sk-ds")

        registry = fallback_provider_configs({})

        assert registry["deepseek"]["baseUrl"] == "https://api.deepseek.com/v1"

    def test_provider_without_env_key_is_absent(self, monkeypatch: pytest.MonkeyPatch):
        for env_name in ENV_PROVIDER_KEY_MAP.values():
            monkeypatch.delenv(env_name, raising=False)

        registry = fallback_provider_configs({"baseUrl": "https://ignored.example/v1"})

        assert registry == {}

    def test_dashscope_default_base_comes_from_single_source(
        self, monkeypatch: pytest.MonkeyPatch
    ):
        for env_name in ENV_PROVIDER_KEY_MAP.values():
            monkeypatch.delenv(env_name, raising=False)
        monkeypatch.setenv("XIHE_DASHSCOPE_API_KEY", "sk-ds")

        registry = fallback_provider_configs({})

        assert registry["dashscope"]["baseUrl"] == default_api_base("dashscope")
        assert registry["dashscope"]["baseUrl"] == (
            "https://dashscope.aliyuncs.com/compatible-mode/v1"
        )

    def test_env_api_key_unknown_provider_is_empty(self):
        assert env_api_key("nonexistent") == ""


class TestResolveProviderBaseUrl:
    """Shared precedence used by the fallback registry and embedding config."""

    def test_provider_specific_beats_shared_and_fallback(self):
        assert resolve_provider_base_url(
            {
                "xiaomiApiBase": "https://specific.test/v1",
                "baseUrl": "https://shared.test/v1",
            },
            "xiaomi",
            "https://fallback.test/v1",
        ) == "https://specific.test/v1"

    def test_shared_base_url_beats_fallback(self):
        assert resolve_provider_base_url(
            {"baseUrl": "https://shared.test/v1"},
            "xiaomi",
            "https://fallback.test/v1",
        ) == "https://shared.test/v1"

    def test_falls_back_when_unset(self):
        assert resolve_provider_base_url(
            {}, "xiaomi", "https://fallback.test/v1"
        ) == "https://fallback.test/v1"


class TestCreateLLM:
    """Factory function create_llm()."""

    def test_create_with_config(self):
        """create_llm respects a passed config."""
        cfg = LLMConfig(provider="mock")
        model = create_llm(cfg)
        assert isinstance(model, MockChatModel)

    def test_create_without_config(self, monkeypatch: pytest.MonkeyPatch):
        """create_llm without config reads from environment."""
        monkeypatch.delenv("XIHE_LLM_PROVIDER", raising=False)
        monkeypatch.delenv("XIHE_MODEL", raising=False)

        model = create_llm()
        assert isinstance(model, MockChatModel)

    def test_create_returns_mock_for_mock_provider(self):
        """mock provider always returns MockChatModel."""
        cfg = LLMConfig(provider="mock")
        model = create_llm(cfg)
        assert isinstance(model, MockChatModel)

    def test_create_non_mock_returns_chat_model(self, monkeypatch: pytest.MonkeyPatch):
        """Non-mock providers return XiheChatModel (or ChatLiteLLM after migration)."""
        monkeypatch.setenv("XIHE_LLM_PROVIDER", "openai")
        monkeypatch.setenv("XIHE_OPENAI_API_KEY", "sk-test-key")

        cfg = LLMConfig.from_env()
        model = create_llm(cfg)
        from langchain_core.language_models.chat_models import BaseChatModel

        assert isinstance(model, BaseChatModel)

    def test_xiaomi_uses_native_litellm_adapter(self):
        model = create_llm(LLMConfig(
            provider="xiaomi",
            api_key="sk-test-key",
            api_base="https://api.xiaomimimo.com/v1",
            model="mimo-v2.5",
        ))

        assert getattr(model, "model") == "xiaomi_mimo/mimo-v2.5"
        assert getattr(model, "request_timeout") == 60.0
        assert getattr(model, "streaming") is True
        assert model._client_params["stream"] is True

    @pytest.mark.asyncio
    async def test_streaming_passes_stream_true_to_litellm(self, monkeypatch: pytest.MonkeyPatch):
        model = XiheLiteLLM(LLMConfig(
            provider="openai",
            api_key="test-key",
            api_base="https://api.example.test/v1",
            model="test-model",
        ))
        observed: dict[str, object] = {}

        async def fake_acompletion(**kwargs: object):
            observed.update(kwargs)

            async def chunks():
                yield {"choices": [{"delta": {"content": "first"}}]}
                yield {"choices": [{"delta": {"content": " second"}}]}

            return chunks()

        monkeypatch.setattr(model.client, "acompletion", fake_acompletion)
        chunks = [chunk async for chunk in model.astream([HumanMessage(content="hello")])]

        assert observed["stream"] is True
        assert [chunk.content for chunk in chunks if chunk.content] == ["first", " second"]

    def test_xiaomi_uses_openai_compat_route_when_tools_are_bound(self):
        model = create_llm(LLMConfig(
            provider="xiaomi",
            api_key="sk-test-key",
            api_base="https://api.xiaomimimo.com/v1",
            model="mimo-v2.5",
        ))
        tool = {
            "type": "function",
            "function": {
                "name": "noop",
                "description": "No-op test tool",
                "parameters": {"type": "object", "properties": {}},
            },
        }

        bound = model.bind_tools([tool])

        assert getattr(model, "model") == "xiaomi_mimo/mimo-v2.5"
        assert getattr(bound.bound, "model") == "openai/mimo-v2.5"


class TestMockChatModel:
    """MockChatModel for testing."""

    def test_mock_responds(self):
        model = MockChatModel()
        from langchain_core.messages import HumanMessage

        result = model.invoke([HumanMessage(content="Hello")])
        assert result.content is not None
        assert "Hello" in result.content

    def test_mock_streams(self):
        model = MockChatModel()
        from langchain_core.messages import HumanMessage

        chunks = list(model.stream([HumanMessage(content="Test stream")]))
        assert len(chunks) > 0
        combined = "".join(c.content for c in chunks if c.content)
        assert "Test stream" in combined

    def test_mock_supports_bind_tools(self):
        model = MockChatModel()
        from langchain_core.tools import BaseTool
        from pydantic import BaseModel, Field

        class FakeSchema(BaseModel):
            q: str = Field()

        class FakeTool(BaseTool):
            name: str = "test"
            description: str = "test tool"
            args_schema: type[BaseModel] = FakeSchema

            def _run(self, q: str) -> str:
                return f"result: {q}"

        bound = model.bind_tools([FakeTool()])
        assert bound is not None


class TestLLMProvider:
    """XiheLiteLLM and MockChatModel implement the LLMProvider abstraction."""

    def test_create_llm_returns_llm_provider(self):
        cfg = LLMConfig(provider="mock")
        model = create_llm(cfg)
        assert isinstance(model, LLMProvider)
        assert isinstance(model, MockChatModel)

    @pytest.mark.asyncio
    async def test_mock_complete(self):
        model = MockChatModel()
        result = await model.complete(LLMRequest(
            model="mock",
            messages=[{"role": "human", "content": "Hello"}],
        ))
        assert "Hello" in result

    @pytest.mark.asyncio
    async def test_mock_stream_complete(self):
        model = MockChatModel()
        tokens = []
        async for token in model.stream_complete(LLMRequest(
            model="mock",
            messages=[{"role": "human", "content": "Test stream"}],
        )):
            tokens.append(token.content)
        combined = "".join(tokens)
        assert "Test stream" in combined

    def test_mock_with_model(self):
        model = MockChatModel()
        switched = model.with_model("gpt-5")
        assert isinstance(switched, LLMProvider)
        assert isinstance(switched, MockChatModel)
