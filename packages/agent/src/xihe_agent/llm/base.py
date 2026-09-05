import os
from collections.abc import AsyncIterator, Sequence
from typing import TYPE_CHECKING, Any, Literal, cast

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

ProviderName = Literal["deepseek", "openai", "anthropic", "ollama", "mock", "xiaomi"]

PROVIDER_DEFAULTS: dict[ProviderName, dict[str, Any]] = {
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
    "ollama": {
        "api_base": "http://localhost:11434/v1",
        "model": "llama3",
    },
    "mock": {},
}


def _provider_for_model(model_id: str) -> ProviderName:
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
    provider: ProviderName = "deepseek"
    api_key: str = ""
    api_base: str = ""
    model: str = ""
    timeout: float = 60.0
    max_tokens: int = 4096
    temperature: float = 0.7

    def with_model(self, model: str) -> "LLMConfig":
        return LLMConfig(
            provider=self.provider,
            api_key=self.api_key,
            api_base=self.api_base,
            model=model or self.model,
            timeout=self.timeout,
            max_tokens=self.max_tokens,
            temperature=self.temperature,
        )

    @classmethod
    def from_env(cls) -> "LLMConfig":
        provider_str = os.getenv("XIHE_LLM_PROVIDER", "")
        model = os.getenv("XIHE_MODEL", "")
        if not provider_str and model:
            provider_str = _provider_for_model(model)

        provider: ProviderName = cast(
            ProviderName,
            provider_str or "mock",
        )

        env_key_map: dict[ProviderName, str] = {
            "deepseek": "XIHE_DEEPSEEK_API_KEY",
            "openai": "XIHE_OPENAI_API_KEY",
            "anthropic": "XIHE_ANTHROPIC_API_KEY",
            "xiaomi": "XIHE_XIAOMI_API_KEY",
        }
        api_key = os.getenv(env_key_map.get(provider, ""), "")

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
        provider_str = cc.get("llm-provider", "defaultProvider")
        model = cc.get("user-preference", "defaultModel")
        if not provider_str:
            provider_str = _provider_for_model(model) if model else "mock"

        provider: ProviderName = cast(ProviderName, provider_str)

        env_key_map: dict[ProviderName, str] = {
            "deepseek": "deepseekApiKey",
            "openai": "openaiApiKey",
            "anthropic": "anthropicApiKey",
            "xiaomi": "xiaomiApiKey",
        }
        api_key = cc.get("llm-provider", env_key_map.get(provider, "")) or ""

        defaults = PROVIDER_DEFAULTS.get(provider, {})
        api_base = (
            cc.get("llm-provider", f"{provider}ApiBase")
            or cc.get("llm-provider", "baseUrl")
            or defaults.get("api_base", "")
        )
        provider_model = cc.get("llm-provider", f"{provider}Model")
        model = provider_model or model or defaults.get("model", "")

        timeout_str = cc.get("llm-provider", "timeout") or "60"
        max_tokens_str = cc.get("llm-provider", "maxTokens") or "4096"
        temp_str = cc.get("llm-provider", "temperature") or "0.7"

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
            litellm_provider = (
                "openai"
                if cfg.provider == "xiaomi" and use_openai_compat_for_tools
                else "xiaomi_mimo"
                if cfg.provider == "xiaomi"
                else cfg.provider
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
