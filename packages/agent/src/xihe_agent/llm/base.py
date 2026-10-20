import json
import math
import os
from collections.abc import AsyncIterator, Mapping, Sequence
from typing import TYPE_CHECKING, Any, cast

import litellm
from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessage, AIMessageChunk, BaseMessage
from langchain_core.outputs import ChatGeneration, ChatGenerationChunk, ChatResult
from langchain_core.runnables import Runnable
from langchain_core.tools import BaseTool
from langchain_litellm import ChatLiteLLM
from loguru import logger
from pydantic import BaseModel, PrivateAttr

if TYPE_CHECKING:
    from xihe_agent.config_client import ConfigClient

from xihe_agent.interfaces.llm import LLMProvider, LLMRequest, LLMToken

ProviderName = str

# PLAN-0364 M3: OpenAI-wire routes fall back to the real OpenAI endpoint
# (`api_base`/`OPENAI_API_KEY`) when no explicit base URL is supplied. The
# resolved route must therefore carry an explicit base; XH refuses to inherit
# that implicit default.
_WIRE_SLUGS_REQUIRING_EXPLICIT_BASE = frozenset({"openai", "custom_openai", "openai_like"})


class LLMRouteConfigError(RuntimeError):
    """Resolved route would silently fall back to a provider default endpoint (PLAN-0364 M3)."""


def _normalize_outbound_messages(messages: Sequence[BaseMessage]) -> list[BaseMessage]:
    """Canonicalize message content before it reaches the provider wire.

    LangChain can aggregate a reasoning-only assistant turn into a pure-string content
    list (e.g. ``[""]``). Providers such as Xiaomi MiMo reject that shape with HTTP 400
    ("Invalid request parameters"), even though ``content: ""`` is accepted. XH's
    canonical shape is a string (empty when the turn only carried tool calls), so
    collapse pure-string lists here.

    Structured content blocks (images/audio) are left untouched so multimodal requests
    keep working; providers accept those block lists.
    """
    normalized: list[BaseMessage] = []
    for message in messages:
        content = message.content
        if isinstance(content, list):
            text_parts = [item for item in content if isinstance(item, str)]
            if len(text_parts) == len(content):
                normalized.append(message.model_copy(update={"content": "".join(text_parts)}))
                continue
        normalized.append(message)
    return normalized


def _stream_token_text(content: Any) -> str:
    """Flatten a streaming chunk's content into the LLMToken text contract.

    Providers normally stream plain strings; structured content blocks are
    flattened to their text fields so `LLMToken.content` stays a `str`.
    """
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for item in content:
            if isinstance(item, str):
                parts.append(item)
            elif isinstance(item, dict) and isinstance(item.get("text"), str):
                parts.append(item["text"])
        return "".join(parts)
    return str(content) if content else ""


def _normalize_message_dict(message: Mapping[str, Any]) -> Mapping[str, Any]:
    """Collapse a pure-string ``content`` list on an already-serialized wire message."""
    content = message.get("content")
    if isinstance(content, list) and all(isinstance(item, str) for item in content):
        return {**message, "content": "".join(content)}
    return message


# PLAN-0371 (BL-19): only Anthropic needs the replayed thinking chain on tool turns;
# every other wire route gets assistant reasoning stripped before it leaves the process.
_ANTHROPIC_ROUTE_MARKERS = ("anthropic/", "claude/", "claude-")


def _keeps_reasoning(model: str, *route_values: str) -> bool:
    """Whether replayed ``reasoning_content`` must be retained for this route.

    Anthropic requires the same-chain thinking blocks across tool turns; the replay
    is delivered as ``additional_kwargs["reasoning_content"]`` (the only outbound
    channel — ``thinking`` content blocks are already skipped by ``langchain_litellm``).
    """
    for value in route_values:
        if value.strip().lower() in {"anthropic", "claude"}:
            return True
    return model.strip().lower().startswith(_ANTHROPIC_ROUTE_MARKERS)


def _strip_reasoning_content(messages: Sequence[BaseMessage]) -> list[BaseMessage]:
    """Drop replayed reasoning from assistant messages (PLAN-0371 / BL-19).

    Only the ``reasoning_content`` key is removed; every other ``additional_kwargs``
    entry, the message order and the content shape stay untouched.
    """
    stripped: list[BaseMessage] = []
    for message in messages:
        if isinstance(message, AIMessage) and "reasoning_content" in message.additional_kwargs:
            additional_kwargs = {
                key: value for key, value in message.additional_kwargs.items() if key != "reasoning_content"
            }
            stripped.append(message.model_copy(update={"additional_kwargs": additional_kwargs}))
        else:
            stripped.append(message)
    return stripped


def _install_wire_normalizer() -> None:
    """Normalize provider payloads at the litellm boundary (idempotent).

    Some call paths reach ``litellm`` without going through ``ChatLiteLLM``; normalizing the
    ``messages`` argument here covers every caller. Providers such as Xiaomi MiMo reject
    ``content: [""]`` with HTTP 400 while accepting ``content: ""``.
    """
    if getattr(litellm.acompletion, "_xihe_normalized", False):
        return
    original_acompletion = litellm.acompletion
    original_completion = litellm.completion

    async def normalized_acompletion(*args: Any, **kwargs: Any) -> Any:
        messages = kwargs.get("messages")
        if isinstance(messages, list):
            kwargs["messages"] = [_normalize_message_dict(m) for m in messages]
        return await original_acompletion(*args, **kwargs)

    def normalized_completion(*args: Any, **kwargs: Any) -> Any:
        messages = kwargs.get("messages")
        if isinstance(messages, list):
            kwargs["messages"] = [_normalize_message_dict(m) for m in messages]
        return original_completion(*args, **kwargs)

    normalized_acompletion._xihe_normalized = True  # type: ignore[attr-defined]
    normalized_completion._xihe_normalized = True  # type: ignore[attr-defined]
    litellm.acompletion = normalized_acompletion
    litellm.completion = normalized_completion


_install_wire_normalizer()

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


def parse_llm_profile(raw: str | None) -> dict[str, str] | None:
    """Parse the whole `llm-provider` profile unit (PLAN-0504).

    Returns the validated ``{providerId, connectionKey, model}`` unit, or
    ``None`` when absent/blank/malformed. A malformed stored value degrades to
    "no profile" (readiness is fail-closed and the per-run path never depends
    on this identity), with a warning that never includes the raw value.
    """
    if raw is None or not raw.strip():
        return None
    try:
        parsed = json.loads(raw)
    except (TypeError, ValueError):
        logger.warning("llm-provider profile is not valid JSON; treating as absent")
        return None
    if not isinstance(parsed, dict):
        logger.warning("llm-provider profile is not an object; treating as absent")
        return None
    provider_id = parsed.get("providerId")
    connection_key = parsed.get("connectionKey")
    model = parsed.get("model")
    if not (
        isinstance(provider_id, str)
        and provider_id.strip()
        and isinstance(connection_key, str)
        and connection_key.strip()
        and isinstance(model, str)
        and model.strip()
    ):
        logger.warning("llm-provider profile is incomplete; treating as absent")
        return None
    return {"providerId": provider_id, "connectionKey": connection_key, "model": model}


def parse_model_params(entries: Mapping[str, str], model: str) -> dict[str, float | int] | None:
    """Resolve this model's sampling overrides from the `modelParams` layer map (PLAN-0523).

    `modelParams` is a layer-scoped ``Record<模型名, {maxTokens?, temperature?, timeout?}>``
    (decisions #9/#12/#14): whole-domain replacement at the writing layer, looked up
    here per run by bare model name. Returns only schema-valid keys (positive
    ``maxTokens``/``timeout``, finite ``temperature``); returns ``None`` when the map
    is absent, the model has no entry, or no valid key remains — callers then keep
    API/template defaults. Malformed stored values degrade to "no overrides" with a
    warning that never includes the raw value.
    """
    raw = entries.get("modelParams")
    if raw is None or not raw.strip():
        return None
    try:
        parsed = json.loads(raw)
    except (TypeError, ValueError):
        logger.warning("llm-provider modelParams is not valid JSON; ignoring")
        return None
    if not isinstance(parsed, dict):
        logger.warning("llm-provider modelParams is not an object; ignoring")
        return None
    candidates = (model, model.split("/", 1)[1] if "/" in model else None)
    entry: Any = None
    for candidate in candidates:
        if candidate and isinstance(parsed.get(candidate), dict):
            entry = parsed[candidate]
            break
    if entry is None:
        return None
    overrides: dict[str, float | int] = {}
    max_tokens = entry.get("maxTokens")
    if isinstance(max_tokens, int) and not isinstance(max_tokens, bool) and max_tokens > 0:
        overrides["maxTokens"] = max_tokens
    temperature = entry.get("temperature")
    if isinstance(temperature, (int, float)) and not isinstance(temperature, bool) and math.isfinite(temperature):
        overrides["temperature"] = float(temperature)
    timeout = entry.get("timeout")
    if isinstance(timeout, (int, float)) and not isinstance(timeout, bool) and math.isfinite(timeout) and timeout > 0:
        overrides["timeout"] = float(timeout)
    return overrides or None


def resolve_provider_base_url(provider: str, fallback: str | None = "") -> str | None:
    """PLAN-0504 decision #9: env-only endpoint precedence.

    The `llm-provider` config domain no longer carries base URLs, so the
    precedence collapses to ``XIHE_API_BASE`` > caller fallback. Runtime chat
    requests take their endpoint from the connection grant; this helper only
    serves the offline/fallback registry (model-directory probing).
    """
    return os.getenv("XIHE_API_BASE", "") or fallback


def fallback_provider_configs() -> dict[str, dict[str, Any]]:
    """Offline provider registry: env keys + env-only endpoint (decision #9).

    Providers without an env fallback key are absent — under BYOK (decision
    #37) per-run credentials arrive through the provider connection lease.
    The model stays empty (decision #9): this path only probes the model
    directory and never picks a default model.
    """
    registry: dict[str, dict[str, Any]] = {}
    for provider, env_name in ENV_PROVIDER_KEY_MAP.items():
        api_key = os.getenv(env_name, "")
        if not api_key:
            continue
        base_url = resolve_provider_base_url(provider, default_api_base(provider))
        registry[provider] = {
            "provider": provider,
            "apiKey": api_key,
            "baseUrl": base_url,
            "model": "",
        }
    return registry


# PLAN-0531 decision #3: this table is the **single** product-default
# definition. Two fields, two different lifecycles:
#   - ``model`` is a product default and is consumed **exclusively** by
#     :meth:`LLMConfig.from_env` (offline / dev path). :meth:`from_entries`
#     must never read it — the runtime identity comes from the
#     ``llm-provider.profile`` unit (PLAN-0504, decision #10).
#   - ``api_base`` is an env-only fallback consumed by both paths.
# Adding/renaming a provider default must not require editing any other file.
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
        "model": "mimo-v2.6-flash",
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
        """Build from the `llm-provider` effective entries (PLAN-0504).

        PLAN-0307 T2.7: per-run overrides are merged into a run-local entry map
        by the caller; this method stays pure and never writes back.

        The only identity source is the whole `profile` unit; the legacy
        `defaultProvider`/`defaultModel`/`{provider}Model` reads and the
        config-layer base URLs are retired (no compat). With no profile there
        is no implicit default — the provider stays empty so readiness is
        fail-closed (decision #10). The offline env path stays in
        :meth:`from_env`.
        """
        profile = parse_llm_profile(entries.get("profile"))
        provider = profile["providerId"] if profile else ""
        model = profile["model"] if profile else ""

        # PLAN-0307 decision #21 / PLAN-0504 decision #9: config holds no
        # credentials and no base URLs; the env fallback (offline/dev) is the
        # only non-grant source here. The normal per-run path is the provider
        # connection lease (grant carries apiKey/baseUrl/model).
        api_key = env_api_key(provider) if provider else ""
        defaults = PROVIDER_DEFAULTS.get(provider, {})
        api_base = os.getenv("XIHE_API_BASE", "") or defaults.get("api_base", "")

        # PLAN-0523 T3.6 (决策 #13): the layer-global sampling keys
        # (timeout/maxTokens/temperature) are retired with the CP schema keys
        # and the V69 cleanup migration — no compat reads. Sampling overrides
        # come only from the per-model `modelParams` map (parse_model_params).
        return cls(
            provider=provider,
            api_key=api_key,
            api_base=api_base.rstrip("/"),
            model=model,
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

    def __init__(
        self,
        config: LLMConfig | None = None,
        **kwargs: Any,
    ):
        cfg = config or LLMConfig.from_env()
        model = cfg.model
        route_provider = cfg.route_provider or ("xiaomi_mimo" if cfg.provider == "xiaomi" else cfg.provider)
        if route_provider in _WIRE_SLUGS_REQUIRING_EXPLICIT_BASE and not (cfg.api_base or "").strip():
            raise LLMRouteConfigError(
                f"Base URL is required for route '{route_provider}'; refusing the implicit OpenAI default endpoint"
            )
        if "/" not in model and cfg.provider and cfg.provider != "mock":
            # Route slug comes from the CP-issued grant (catalog `litellmProvider`).
            # No tool-driven rewriting: PLAN-0364 M3 removed the silent switch to
            # `openai/...`; a tool/route mismatch is surfaced by litellm instead.
            model = f"{route_provider}/{model}"
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

    # Single choke point for every sync/async path (ChatLiteLLM builds the provider
    # payload here), so normalizing once covers _generate/_stream/_astream/_agenerate.
    def _create_message_dicts(
        self,
        messages: list[BaseMessage],
        stop: list[str] | None,
    ) -> tuple[list[dict[str, Any]], dict[str, Any]]:
        prepared = _normalize_outbound_messages(messages)
        # PLAN-0371 (BL-19): reasoning replay is an Anthropic contract requirement only;
        # non-Anthropic routes shed the token cost (and the cross-provider acceptance risk).
        if not _keeps_reasoning(self.model, self._config.provider, self._config.route_provider):
            prepared = _strip_reasoning_content(prepared)
        return super()._create_message_dicts(prepared, stop)

    async def complete(self, request: LLMRequest) -> str:
        messages = _to_langchain_messages(request.messages)
        result = await self.ainvoke(messages)
        return str(result.content)

    async def stream_complete(self, request: LLMRequest) -> AsyncIterator[LLMToken]:
        messages = _to_langchain_messages(request.messages)
        async for chunk in self.astream(messages):
            token_text = _stream_token_text(chunk.content)
            if token_text:
                yield LLMToken(content=token_text)

    def with_model(self, model: str) -> LLMProvider:
        return XiheLiteLLM(config=self._config.with_model(model))


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
            token_text = _stream_token_text(chunk.content)
            if token_text:
                yield LLMToken(content=token_text)

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


def create_llm(config: LLMConfig | None = None) -> "MockChatModel | XiheLiteLLM":
    """Build the concrete chat model; both variants are BaseChatModel + LLMProvider."""
    cfg = config or LLMConfig.from_env()
    if cfg.provider == "mock":
        return MockChatModel()
    return XiheLiteLLM(config=cfg)
