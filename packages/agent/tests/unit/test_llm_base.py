"""Tests for xihe_agent.llm.base — LLMConfig, create_llm, and provider routing."""

import pytest
from langchain_core.messages import HumanMessage

from xihe_agent.config_client import ConfigClient
from xihe_agent.interfaces.llm import LLMProvider, LLMRequest
from xihe_agent.llm.base import (
    ENV_PROVIDER_KEY_MAP,
    LLMConfig,
    LLMRouteConfigError,
    MockChatModel,
    XiheLiteLLM,
    create_llm,
    default_api_base,
    env_api_key,
    fallback_provider_configs,
    parse_model_params,
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

    def test_from_config_client_reads_profile_unit(self, monkeypatch: pytest.MonkeyPatch):
        """PLAN-0504: the whole profile unit is the only identity source."""
        monkeypatch.setenv("XIHE_XIAOMI_API_KEY", "sk-mimo-env")
        monkeypatch.delenv("XIHE_API_BASE", raising=False)
        client = ConfigClient("http://test-cp", "test-token")
        client._effective_cache["llm-provider"] = {
            "profile": '{"providerId":"xiaomi","connectionKey":"default","model":"mimo-v2.5"}',
        }
        cfg = LLMConfig.from_config_client(client)

        assert cfg.provider == "xiaomi"
        assert cfg.api_key == "sk-mimo-env"
        assert cfg.api_base == "https://api.xiaomimimo.com/v1"
        assert cfg.model == "mimo-v2.5"

    def test_from_config_client_ignores_config_api_keys(self, monkeypatch: pytest.MonkeyPatch):
        """PLAN-0307 T2.13: config `*ApiKey` entries are never consumed."""
        monkeypatch.setenv("XIHE_XIAOMI_API_KEY", "sk-mimo-env")
        client = ConfigClient("http://test-cp", "test-token")
        client._effective_cache["llm-provider"] = {
            "profile": '{"providerId":"xiaomi","connectionKey":"default","model":"mimo-v2.5"}',
            "xiaomiApiKey": "sk-from-config-must-be-ignored",
        }
        cfg = LLMConfig.from_config_client(client)

        assert cfg.api_key == "sk-mimo-env"

    def test_from_config_client_ignores_legacy_keys(self, monkeypatch: pytest.MonkeyPatch):
        """PLAN-0504 decision #2: legacy identity/base keys have no compat reads."""
        for env_name in ENV_PROVIDER_KEY_MAP.values():
            monkeypatch.delenv(env_name, raising=False)
        client = ConfigClient("http://test-cp", "test-token")
        client._effective_cache["llm-provider"] = {
            "defaultProvider": "xiaomi",
            "defaultModel": "mimo-v2.5",
            "xiaomiModel": "mimo-v2.5",
            "xiaomiApiBase": "https://api.xiaomimimo.com/v1",
            "baseUrl": "https://shared.example/v1",
        }

        cfg = LLMConfig.from_config_client(client)

        assert cfg.provider == ""
        assert cfg.model == ""
        assert cfg.api_base == ""

    def test_from_config_client_without_profile_has_no_implicit_default(self, monkeypatch: pytest.MonkeyPatch):
        """PLAN-0504 decision #10: no profile → no implicit mock/provider default."""
        for env_name in ENV_PROVIDER_KEY_MAP.values():
            monkeypatch.delenv(env_name, raising=False)
        client = ConfigClient("http://test-cp", "test-token")

        cfg = LLMConfig.from_config_client(client)

        assert cfg.provider == ""
        assert cfg.model == ""
        assert cfg.api_key == ""


class TestFallbackProviderConfigs:
    """PLAN-0504 decision #9: env-only offline registry (config reads retired)."""

    def test_returns_env_keyed_providers_with_default_base(self, monkeypatch: pytest.MonkeyPatch):
        for env_name in ENV_PROVIDER_KEY_MAP.values():
            monkeypatch.delenv(env_name, raising=False)
        monkeypatch.delenv("XIHE_API_BASE", raising=False)
        monkeypatch.setenv("XIHE_XIAOMI_API_KEY", "sk-mimo")

        registry = fallback_provider_configs()

        assert registry == {
            "xiaomi": {
                "provider": "xiaomi",
                "apiKey": "sk-mimo",
                "baseUrl": "https://api.xiaomimimo.com/v1",
                "model": "",
            }
        }

    def test_xihe_api_base_beats_provider_default_and_model_stays_empty(
        self, monkeypatch: pytest.MonkeyPatch
    ):
        for env_name in ENV_PROVIDER_KEY_MAP.values():
            monkeypatch.delenv(env_name, raising=False)
        monkeypatch.setenv("XIHE_DEEPSEEK_API_KEY", "sk-ds")
        monkeypatch.setenv("XIHE_API_BASE", "https://proxy.example.test/v1")

        registry = fallback_provider_configs()

        assert registry["deepseek"]["baseUrl"] == "https://proxy.example.test/v1"
        assert registry["deepseek"]["model"] == ""

    def test_provider_without_env_key_is_absent(self, monkeypatch: pytest.MonkeyPatch):
        for env_name in ENV_PROVIDER_KEY_MAP.values():
            monkeypatch.delenv(env_name, raising=False)

        registry = fallback_provider_configs()

        assert registry == {}

    def test_dashscope_default_base_comes_from_single_source(self, monkeypatch: pytest.MonkeyPatch):
        for env_name in ENV_PROVIDER_KEY_MAP.values():
            monkeypatch.delenv(env_name, raising=False)
        monkeypatch.delenv("XIHE_API_BASE", raising=False)
        monkeypatch.setenv("XIHE_DASHSCOPE_API_KEY", "sk-ds")

        registry = fallback_provider_configs()

        assert registry["dashscope"]["baseUrl"] == default_api_base("dashscope")
        assert registry["dashscope"]["baseUrl"] == ("https://dashscope.aliyuncs.com/compatible-mode/v1")

    def test_env_api_key_unknown_provider_is_empty(self):
        assert env_api_key("nonexistent") == ""


class TestResolveProviderBaseUrl:
    """PLAN-0504 decision #9: env-only endpoint precedence (config reads retired)."""

    def test_env_base_url_beats_fallback(self, monkeypatch: pytest.MonkeyPatch):
        monkeypatch.setenv("XIHE_API_BASE", "https://env.test/v1")

        assert resolve_provider_base_url("xiaomi", "https://fallback.test/v1") == "https://env.test/v1"

    def test_falls_back_when_unset(self, monkeypatch: pytest.MonkeyPatch):
        monkeypatch.delenv("XIHE_API_BASE", raising=False)

        assert resolve_provider_base_url("xiaomi", "https://fallback.test/v1") == "https://fallback.test/v1"


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
        model = create_llm(
            LLMConfig(
                provider="xiaomi",
                api_key="sk-test-key",
                api_base="https://api.xiaomimimo.com/v1",
                model="mimo-v2.5",
            )
        )

        assert getattr(model, "model") == "xiaomi_mimo/mimo-v2.5"
        assert getattr(model, "request_timeout") == 60.0
        assert getattr(model, "streaming") is True
        assert model._client_params["stream"] is True

    @pytest.mark.asyncio
    async def test_streaming_passes_stream_true_to_litellm(self, monkeypatch: pytest.MonkeyPatch):
        model = XiheLiteLLM(
            LLMConfig(
                provider="openai",
                api_key="test-key",
                api_base="https://api.example.test/v1",
                model="test-model",
            )
        )
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

    def test_xiaomi_keeps_native_route_when_tools_are_bound(self):
        """PLAN-0364 M3: no silent switch to `openai/...` — route follows config."""
        model = create_llm(
            LLMConfig(
                provider="xiaomi",
                api_key="sk-test-key",
                api_base="https://api.xiaomimimo.com/v1",
                model="mimo-v2.5",
            )
        )
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
        assert getattr(bound.bound, "model") == "xiaomi_mimo/mimo-v2.5"

    def test_openai_wire_route_requires_explicit_base_url(self):
        """PLAN-0364 M3: empty baseUrl must fail fast instead of using OpenAI defaults."""
        with pytest.raises(LLMRouteConfigError):
            create_llm(
                LLMConfig(
                    provider="custom-openai-compatible",
                    route_provider="openai",
                    api_key="sk-test-key",
                    api_base="",
                    model="mimo-v2.5",
                )
            )

    def test_openai_wire_route_rejects_blank_base_url(self):
        with pytest.raises(LLMRouteConfigError):
            create_llm(
                LLMConfig(
                    provider="custom-openai-compatible",
                    route_provider="openai",
                    api_key="sk-test-key",
                    api_base="   ",
                    model="mimo-v2.5",
                )
            )

    def test_outbound_normalization_collapses_pure_string_content_lists(self):
        # PLAN-0364 hotfix: MiMo rejects content=[""] (HTTP 400); canonical shape is str.
        from langchain_core.messages import AIMessage

        from xihe_agent.llm.base import _normalize_outbound_messages

        normalized = _normalize_outbound_messages(
            [
                AIMessage(content=[""]),
                AIMessage(content=["a", "b"]),
            ]
        )
        assert normalized[0].content == ""
        assert normalized[1].content == "ab"

    def test_outbound_normalization_keeps_structured_multimodal_blocks(self):
        from langchain_core.messages import HumanMessage

        from xihe_agent.llm.base import _normalize_outbound_messages

        block = {"type": "image_url", "image_url": {"url": "data:image/png;base64,AAAA"}}
        normalized = _normalize_outbound_messages([HumanMessage(content=[block])])
        assert normalized[0].content == [block]

    def test_wire_dict_normalization_collapses_pure_string_lists(self):
        # Boundary guard for call paths that reach litellm without ChatLiteLLM.
        from xihe_agent.llm.base import _normalize_message_dict

        assert _normalize_message_dict({"role": "assistant", "content": [""]})["content"] == ""
        assert _normalize_message_dict({"role": "assistant", "content": ["a", "b"]})["content"] == "ab"
        block = {"type": "image_url", "image_url": {"url": "data:image/png;base64,AAAA"}}
        assert _normalize_message_dict({"role": "user", "content": [block]})["content"] == [block]


class TestReasoningReplayPolicy:
    """PLAN-0371 / BL-19: outbound reasoning_content is stripped unless the route is Anthropic."""

    @staticmethod
    def _assistant_with_reasoning():
        from langchain_core.messages import AIMessage

        return AIMessage(
            content="",
            additional_kwargs={
                "reasoning_content": "hidden chain of thought",
                "tools_available": ["write_file"],
            },
        )

    @staticmethod
    def _outbound(model: XiheLiteLLM, messages: list) -> list[dict]:
        dicts, _ = model._create_message_dicts(messages, None)
        return dicts

    def test_non_anthropic_routes_strip_replayed_reasoning(self):
        model = create_llm(
            LLMConfig(
                provider="xiaomi",
                api_key="sk-test-key",
                api_base="https://api.xiaomimimo.com/v1",
                model="mimo-v2.5",
            )
        )

        dicts = self._outbound(model, [self._assistant_with_reasoning()])

        assert "reasoning_content" not in dicts[0]
        assert dicts[0]["content"] == ""

    def test_deepseek_route_also_strips(self):
        model = create_llm(LLMConfig(provider="deepseek", api_key="sk-test-key", model="deepseek-chat"))

        dicts = self._outbound(model, [self._assistant_with_reasoning()])

        assert "reasoning_content" not in dicts[0]

    def test_anthropic_routes_keep_replayed_reasoning(self):
        model = create_llm(
            LLMConfig(
                provider="anthropic",
                api_key="sk-test-key",
                model="claude-sonnet-4-20250514",
            )
        )

        dicts = self._outbound(model, [self._assistant_with_reasoning()])

        assert dicts[0]["reasoning_content"] == "hidden chain of thought"

    def test_anthropic_detection_uses_explicit_route_provider(self):
        model = create_llm(
            LLMConfig(
                provider="custom-anthropic",
                route_provider="anthropic",
                api_key="sk-test-key",
                api_base="https://anthropic-proxy.example.test/v1",
                model="claude-sonnet-4-20250514",
            )
        )

        assert getattr(model, "model") == "anthropic/claude-sonnet-4-20250514"
        dicts = self._outbound(model, [self._assistant_with_reasoning()])

        assert dicts[0]["reasoning_content"] == "hidden chain of thought"

    def test_strip_removes_only_reasoning_and_keeps_other_kwargs(self):
        from xihe_agent.llm.base import _strip_reasoning_content

        message = self._assistant_with_reasoning()
        stripped = _strip_reasoning_content([message])

        assert "reasoning_content" not in stripped[0].additional_kwargs
        assert stripped[0].additional_kwargs["tools_available"] == ["write_file"]
        # Copy-on-write: the caller's message object stays untouched.
        assert message.additional_kwargs["reasoning_content"] == "hidden chain of thought"

    def test_messages_without_reasoning_pass_through_unchanged(self):
        from langchain_core.messages import AIMessage, HumanMessage, ToolMessage

        model = create_llm(
            LLMConfig(
                provider="xiaomi",
                api_key="sk-test-key",
                api_base="https://api.xiaomimimo.com/v1",
                model="mimo-v2.5",
            )
        )
        messages = [
            HumanMessage(content="hello"),
            AIMessage(
                content="",
                tool_calls=[{"name": "write_file", "args": {"path": "a.txt"}, "id": "call-1"}],
            ),
            ToolMessage(content="ok", tool_call_id="call-1"),
        ]

        dicts = self._outbound(model, messages)

        assert [entry["role"] for entry in dicts] == ["user", "assistant", "tool"]
        assert dicts[1]["tool_calls"][0]["function"]["name"] == "write_file"
        assert "reasoning_content" not in dicts[1]


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
        result = await model.complete(
            LLMRequest(
                model="mock",
                messages=[{"role": "human", "content": "Hello"}],
            )
        )
        assert "Hello" in result

    @pytest.mark.asyncio
    async def test_mock_stream_complete(self):
        model = MockChatModel()
        tokens = []
        async for token in model.stream_complete(
            LLMRequest(
                model="mock",
                messages=[{"role": "human", "content": "Test stream"}],
            )
        ):
            tokens.append(token.content)
        combined = "".join(tokens)
        assert "Test stream" in combined

    def test_mock_with_model(self):
        model = MockChatModel()
        switched = model.with_model("gpt-5")
        assert isinstance(switched, LLMProvider)
        assert isinstance(switched, MockChatModel)


class TestParseModelParams:
    """PLAN-0523 decisions #9/#12/#14: layer modelParams map lookup by model name."""

    def test_absent_key_returns_none(self):
        assert parse_model_params({}, "gpt-4o") is None
        assert parse_model_params({"modelParams": "  "}, "gpt-4o") is None

    def test_malformed_json_degrades_to_none(self):
        assert parse_model_params({"modelParams": "not-json"}, "gpt-4o") is None

    def test_non_object_map_degrades_to_none(self):
        assert parse_model_params({"modelParams": "[1]"}, "gpt-4o") is None

    def test_model_entry_with_all_valid_keys(self):
        entries = {
            "modelParams": '{"gpt-4o": {"maxTokens": 2048, "temperature": 0.2, "timeout": 120}}',
        }
        assert parse_model_params(entries, "gpt-4o") == {
            "maxTokens": 2048,
            "temperature": 0.2,
            "timeout": 120.0,
        }

    def test_partial_entry_keeps_only_configured_keys(self):
        entries = {"modelParams": '{"gpt-4o": {"temperature": 0.9}}'}
        assert parse_model_params(entries, "gpt-4o") == {"temperature": 0.9}

    def test_model_without_entry_returns_none(self):
        entries = {"modelParams": '{"other-model": {"temperature": 0.9}}'}
        assert parse_model_params(entries, "gpt-4o") is None

    def test_entry_not_an_object_is_ignored(self):
        entries = {"modelParams": '{"gpt-4o": "fast"}'}
        assert parse_model_params(entries, "gpt-4o") is None

    def test_invalid_keys_are_filtered_out(self):
        entries = {
            "modelParams": ('{"gpt-4o": {"maxTokens": 0, "temperature": "hot", "timeout": -1}}'),
        }
        assert parse_model_params(entries, "gpt-4o") is None

    def test_non_finite_temperature_is_filtered(self):
        entries = {"modelParams": '{"gpt-4o": {"temperature": NaN}}'}
        assert parse_model_params(entries, "gpt-4o") is None

    def test_bool_values_are_filtered(self):
        entries = {"modelParams": '{"gpt-4o": {"maxTokens": true, "timeout": false}}'}
        assert parse_model_params(entries, "gpt-4o") is None

    def test_provider_prefixed_model_falls_back_to_bare_name(self):
        entries = {"modelParams": '{"gpt-4o": {"temperature": 0.3}}'}
        assert parse_model_params(entries, "openai/gpt-4o") == {"temperature": 0.3}

    def test_exact_match_beats_bare_name_fallback(self):
        entries = {
            "modelParams": ('{"openai/gpt-4o": {"temperature": 0.1}, "gpt-4o": {"temperature": 0.9}}'),
        }
        assert parse_model_params(entries, "openai/gpt-4o") == {"temperature": 0.1}
