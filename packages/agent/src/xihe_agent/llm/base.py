import os
from collections.abc import AsyncIterator, Mapping, Sequence
from typing import TYPE_CHECKING, Any, cast

from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessage, AIMessageChunk, BaseMessage
from langchain_core.outputs import ChatGeneration, ChatGenerationChunk, ChatResult
from langchain_core.runnables import Runnable
from langchain_core.tools import BaseTool
from langchain_litellm import ChatLiteLLM
from pydantic import BaseModel, PrivateAttr

if TYPE_CHECKING:
    from xihe_agent.config_client import ConfigClient

from xihe_agent.interfaces.llm import LLMProvider, LLMRequest, LLMToken

ProviderName = str

# PLAN-0307 decisions #21/#39: the config table holds no provider credentials.
# These env keys are the offline fallback (dev / CP unavailable); the normal
# credential path is the per-run provider connection lease issued by CP.
ENV_PROVIDER_KEY_MAP: dict[str, str] = {
    "deepseek": "XIHE_DEEPSEEK_API_KEY",
    "openai": "XIHE_OPENAI_API_KEY",
    "anthropic": "XIHE_ANTHROPIC_API_KEY",
    "xiaomi": "XIHE_XIAOMI_API_KEY",
    "dashscope": "XIHE_DASHSCOPE_API_KEY",
}


def env_api_key(provider: str) -> str:
    """Offline fallback credential lookup (PLAN-0307 decision #21)."""
    return os.getenv(ENV_PROVIDER_KEY_MAP.get(provider, ""), "") or ""


def resolve_provider_base_url(
    llm_entries: Mapping[str, str],
    provider: str,
    fallback: str = "",
) -> str:
    """Shared precedence for a provider endpoint: `{provider}ApiBase` > `baseUrl` > caller fallback."""
    return (
        llm_entries.get(f"{provider}ApiBase")
        or llm_entries.get("baseUrl")
        or fallback
    )


def fallback_provider_configs(llm_entries: Mapping[str, str]) -> dict[str, dict[str, Any]]:
    """Offline provider registry: env keys + non-secret `llm-provider` entries.

    Providers without an env fallback key are absent — under BYOK (decision
    #37) per-run credentials arrive through the provider connection lease.
    """
    registry: dict[str, dict[str, Any]] = {}
    for provider, env_name in ENV_PROVIDER_KEY_MAP.items():
        api_key = os.getenv(env_name, "")
        if not api_key:
            continue
        base_url = resolve_provider_base_url(
            llm_entries, provider, default_api_base(provider)
        )
        registry[provider] = {
            "provider": provider,
            "apiKey": api_key,
            "baseUrl": base_url,
            "model": llm_entries.get(f"{provider}Model", ""),
        }
    return registry


PROVIDER_DEFAULTS: dict[str, dict[str, Any]] = {
    "deepseek": {
        "api_base": "https://api.deepseek.com/v1",
        "model": "deepseek-chat",
    },
    "openai": {
        "api_base": "https://api.openai.com/v1",
        "model": "gpt-4o",
    },
    "anthropic": {
        "api_base": "https://api.anthropic.com/v1",
        "model": "claude-sonnet-4-20250514",
    },
    "xiaomi": {
        "api_base": "https://api.xiaomimimo.com/v1",
        "model": "mimo-v2.5",
    },
    "dashscope": {
        "api_base": "https://dashscope.aliyuncs.com/compatible-mode/v1",
        "model": "",
    },
    "ollama": {
        "api_base": "http://localhost:11434/v1",
        "model": "llama3",
    },
    "mock": {},
}


def default_api_base(provider: str) -> str:
    """Single source of truth for code-default provider endpoints."""
    return str(PROVIDER_DEFAULTS.get(provider, {}).get("api_base", ""))


def _provider_for_model(model_id: str) -> str:
    model_lower = model_id.lower()
    if "mimo" in model_lower or "xiaomi" in model_lower:
        return "xiaomi"
    if model_lower.startswith("deepseek"):
        return "deepseek"
    if any(kw in model_lower for kw in ("gpt", "o1", "o3")):
        return "openai"
    if any(kw in model_lower for kw in ("claude", "anthropic")):
        return "anthropic"
    if any(kw in model_lower for kw in ("llama", "mistral", "qwen", "gemma")):
        return "ollama"
    return cast(ProviderName, os.getenv("XIHE_LLM_PROVIDER", "deepseek") or "deepseek")


class LLMConfig(BaseModel):
    provider: str = "deepseek"
    route_provider: str = ""
    api_key: str = ""
    api_base: str = ""
    model: str = ""
    timeout: float = 60.0
    max_tokens: int = 4096
    temperature: float = 0.7

    def with_model(self, model: str) -> "LLMConfig":
        return LLMConfig(
            provider=self.provider,
            route_provider=self.route_provider,
            api_key=self.api_key,
            api_base=self.api_base,
            model=model or self.model,
            timeout=self.timeout,
            max_tokens=self.max_tokens,
            temperature=self.temperature,
        )

    @classmethod
    def from_env(cls) -> "LLMConfig":
        """Offline fallback only (PLAN-0307 T1.3).

        The primary path is :meth:`from_config_client` (CP effective config).
        This constructor is used **only** when CP config is unavailable/not
        provided (`config or LLMConfig.from_env()`), and its env keys are
        deliberately *not* part of the SSOT config registry — see the
        env↔config key mapping table in
        `internal/A03-xihe/docs/config-architecture-2026-09.md` §2.5.
        """
        provider_str = os.getenv("XIHE_LLM_PROVIDER", "")
        model = os.getenv("XIHE_MODEL", "")
        if not provider_str and model:
            provider_str = _provider_for_model(model)

        provider = provider_str or "mock"

        api_key = env_api_key(provider)

        defaults = PROVIDER_DEFAULTS.get(provider, {})
        api_base = os.getenv("XIHE_API_BASE", "") or defaults.get("api_base", "")
        if not model:
            model = os.getenv("XIHE_MODEL", "") or defaults.get("model", "")

        return cls(
            provider=provider,
            api_key=api_key,
            api_base=api_base.rstrip("/"),
            model=model,
            timeout=float(os.getenv("XIHE_LLM_TIMEOUT", "60")),
            max_tokens=int(os.getenv("XIHE_MAX_TOKENS", "4096")),
            temperature=float(os.getenv("XIHE_TEMPERATURE", "0.7")),
        )

    @classmethod
    def from_config_client(cls, cc: "ConfigClient") -> "LLMConfig":
        """Build from the process-level pulled `llm-provider` effective entries."""
        return cls.from_entries(cc.get_domain("llm-provider"))

    @classmethod
    def from_entries(cls, entries: Mapping[str, str]) -> "LLMConfig":
        """Build from `llm-provider` entries (pulled effective or run-merged).

        PLAN-0307 T2.7: per-run overrides are merged into a run-local entry map
        by the caller; this method stays pure and never writes back.
        """
        provider_str = entries.get("defaultProvider")
        model = entries.get("defaultModel")
        if not provider_str:
            provider_str = _provider_for_model(model) if model else "mock"

        provider = provider_str

        # PLAN-0307 decision #21: config holds no `*ApiKey`; the env fallback
        # (offline/dev) is the only instance-level credential source here. The
        # normal per-run credential path is the provider connection lease.
        api_key = env_api_key(provider)

        defaults = PROVIDER_DEFAULTS.get(provider, {})
        api_base = (
            entries.get(f"{provider}ApiBase")
            or entries.get("baseUrl")
            or defaults.get("api_base", "")
        )
        provider_model = entries.get(f"{provider}Model")
        model = provider_model or model or defaults.get("model", "")

        timeout_str = entries.get("timeout") or "60"
        max_tokens_str = entries.get("maxTokens") or "4096"
        temp_str = entries.get("temperature") or "0.7"

        return cls(
            provider=provider,
            api_key=api_key,
            api_base=api_base.rstrip("/"),
            model=model,
            timeout=float(timeout_str),
            max_tokens=int(max_tokens_str),
            temperature=float(temp_str),
        )


def _to_langchain_messages(messages: list[dict[str, Any]]) -> list[BaseMessage]:
    """Convert normalized LLMRequest messages into LangChain message objects."""
    from langchain_core.messages import HumanMessage, SystemMessage, ToolMessage

    result: list[BaseMessage] = []
    for msg in messages:
        role = msg.get("role", "")
        content = msg.get("content", "")
        if role == "human":
            result.append(HumanMessage(content=content))
        elif role == "ai":
            result.append(AIMessage(content=content))
        elif role == "system":
            result.append(SystemMessage(content=content))
        elif role == "tool":
            result.append(ToolMessage(content=content, tool_call_id=msg.get("tool_call_id", "")))
    return result


class XiheLiteLLM(ChatLiteLLM, LLMProvider):
    _config: LLMConfig = PrivateAttr()
    _use_openai_compat_for_tools: bool = PrivateAttr(default=False)

    def __init__(
        self,
        config: LLMConfig | None = None,
        *,
        use_openai_compat_for_tools: bool = False,
        **kwargs: Any,
    ):
        cfg = config or LLMConfig.from_env()
        model = cfg.model
        if "/" not in model and cfg.provider and cfg.provider != "mock":
            # LiteLLM has a native openai-compatible Xiaomi provider. Keep the
            # provider prefix so LiteLLM selects the correct adapter instead of
            # treating MiMo as an arbitrary OpenAI-compatible endpoint.
            route_provider = cfg.route_provider or (
                "xiaomi_mimo" if cfg.provider == "xiaomi" else cfg.provider
            )
            litellm_provider = (
                "openai"
                if cfg.provider == "xiaomi" and use_openai_compat_for_tools
                else route_provider
            )
            model = f"{litellm_provider}/{model}"
        llm_kwargs: dict[str, Any] = {
            "model": model,
            "streaming": True,
            "temperature": cfg.temperature,
            "max_tokens": cfg.max_tokens,
            "request_timeout": cfg.timeout,
            "api_key": cfg.api_key or None,
            "api_base": cfg.api_base or None,
            "max_retries": 0,
            # PLAN-294 decision #14: without this, most OpenAI-compatible
            # providers omit the usage chunk in streaming mode and the real
            # prompt/completion token counts never reach RunUsage.
            "stream_options": {"include_usage": True},
        }
        llm_kwargs = {k: v for k, v in llm_kwargs.items() if v is not None}
        super().__init__(**llm_kwargs)
        self._config = cfg
        self._use_openai_compat_for_tools = use_openai_compat_for_tools

    def bind_tools(self, tools: Sequence[BaseTool | dict[str, Any] | type | Any], **kwargs: Any) -> Runnable:
        if self._config.provider == "xiaomi" and tools and not self._use_openai_compat_for_tools:
            compatible = XiheLiteLLM(
                config=self._config,
                use_openai_compat_for_tools=True,
            )
            return compatible.bind_tools(tools, **kwargs)
        return super().bind_tools(tools, **kwargs)

    async def complete(self, request: LLMRequest) -> str:
        messages = _to_langchain_messages(request.messages)
        result = await self.ainvoke(messages)
        return str(result.content)

    async def stream_complete(self, request: LLMRequest) -> AsyncIterator[LLMToken]:
        messages = _to_langchain_messages(request.messages)
        async for chunk in self.astream(messages):
            if chunk.content:
                yield LLMToken(content=chunk.content)

    def with_model(self, model: str) -> LLMProvider:
        return XiheLiteLLM(
            config=self._config.with_model(model),
            use_openai_compat_for_tools=self._use_openai_compat_for_tools,
        )


class MockChatModel(BaseChatModel, LLMProvider):
    _bound_tools: list[BaseTool] = []

    def bind_tools(
        self,
        tools: Sequence[BaseTool | dict[str, Any] | type | Any],
        *,
        tool_choice: str | None = None,
        **kwargs: Any,
    ) -> Runnable:
        valid_tools: list[BaseTool] = []
        for t in tools:
            if isinstance(t, BaseTool):
                valid_tools.append(t)
        new = MockChatModel()
        new._bound_tools = valid_tools
        return new

    async def complete(self, request: LLMRequest) -> str:
        messages = _to_langchain_messages(request.messages)
        result = await self.ainvoke(messages)
        return str(result.content)

    async def stream_complete(self, request: LLMRequest) -> AsyncIterator[LLMToken]:
        messages = _to_langchain_messages(request.messages)
        async for chunk in self.astream(messages):
            if chunk.content:
                yield LLMToken(content=chunk.content)

    def with_model(self, model: str) -> LLMProvider:
        return MockChatModel()

    def _generate(
        self,
        messages: list[BaseMessage],
        stop: list[str] | None = None,
        run_manager: Any | None = None,
        **kwargs: Any,
    ) -> ChatResult:
        content = f"Mock response to: {messages[-1].content[:50] if messages else 'no messages'}"
        msg = AIMessage(content=content)
        if self._bound_tools:
            tool_names = [t.name for t in self._bound_tools]
            msg.additional_kwargs["tools_available"] = tool_names
        return ChatResult(generations=[ChatGeneration(message=msg)])

    async def _agenerate(
        self,
        messages: list[BaseMessage],
        stop: list[str] | None = None,
        run_manager: Any | None = None,
        **kwargs: Any,
    ) -> ChatResult:
        return self._generate(messages, stop, run_manager, **kwargs)

    async def _astream(
        self,
        messages: list[BaseMessage],
        stop: list[str] | None = None,
        run_manager: Any | None = None,
        **kwargs: Any,
    ) -> AsyncIterator[ChatGenerationChunk]:
        content = f"Mock response to: {messages[-1].content[:50] if messages else 'no messages'}"
        for char in content:
            yield ChatGenerationChunk(message=AIMessageChunk(content=char))

    @property
    def _llm_type(self) -> str:
        return "xihe-mock"


def create_llm(config: LLMConfig | None = None) -> LLMProvider:
    cfg = config or LLMConfig.from_env()
    if cfg.provider == "mock":
        return MockChatModel()
    return XiheLiteLLM(config=cfg)
