"""Tests for xihe_agent.llm.base — LLMConfig, create_llm, and provider routing."""


import pytest

from xihe_agent.config_client import ConfigClient
from xihe_agent.interfaces.llm import LLMProvider, LLMRequest
from xihe_agent.llm.base import LLMConfig, MockChatModel, create_llm


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
        assert cfg.model == "mimo-v2-omni"
        assert cfg.api_base == "https://api.xiaomimimo.com/v1"

    def test_from_config_client_uses_xiaomi_specific_values(self):
        client = ConfigClient("http://test-cp", "test-token")
        client._admin_cache["llm-provider"] = {
            "defaultProvider": "xiaomi",
            "xiaomiApiKey": "sk-mimo-test",
            "xiaomiApiBase": "https://api.xiaomimimo.com/v1",
            "xiaomiModel": "mimo-v2.5",
        }
        client._admin_cache["user-preference"] = {
            "defaultModel": "deepseek-chat",
        }
        cfg = LLMConfig.from_config_client(client)

        assert cfg.provider == "xiaomi"
        assert cfg.api_key == "sk-mimo-test"
        assert cfg.api_base == "https://api.xiaomimimo.com/v1"
        assert cfg.model == "mimo-v2.5"


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
