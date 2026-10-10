"""Agent process-wide singletons, env constants, and shared helpers.

PLAN-0473 M1 (spec/agent-module-boundaries.md): `main.py` narrows to the app
composition root; the module-level runtime objects (clients, tools, cancel
registry, RAG components, readiness/config state) and the pure helpers shared
by route modules live here. Ownership and refresh semantics are moved verbatim;
`reload_runtime_config` in `main.py` keeps swapping these module globals
atomically (design §行为不变量).
"""

import asyncio
import os
from typing import Any
from uuid import uuid4

import litellm
from langchain_core.messages import AnyMessage
from loguru import logger

from xihe_agent.adapters.approval_tool import ApprovalAgentTool, ApprovalTool
from xihe_agent.adapters.mcp_client import MCPClientManager
from xihe_agent.cancel_registry import RunCancelRegistry
from xihe_agent.config_client import ConfigClient, SyncReport
from xihe_agent.context import (
    CPContextServiceClient,
    CPEventStoreClient,
    CrashRecovery,
    EventSourcedContextProvider,
)
from xihe_agent.interfaces.message import Message
from xihe_agent.llm.base import (
    LLMConfig,
    LLMRouteConfigError,
    create_llm,
    env_api_key,
    resolve_provider_base_url,
)
from xihe_agent.llm.models import _models_router
from xihe_agent.llm.token_counter import TokenCounter
from xihe_agent.rag import EmbeddingService, LiteLLMEmbeddings, VectorStore
from xihe_agent.registry.registry import WorkerRegistry
from xihe_agent.tools import GenerateImageAgentTool, GenerateImageTool, ProviderManager

# Re-exported so the route modules (and tests that patched `main.create_llm`
# pre-split) keep the late-bound provider-construction semantics.
__all__ = [
    "create_llm",
    "CP_API_TOKEN",
    "CP_URL",
    "MCP_RETRY_INTERVAL",
    "MCP_URL",
    "PG_DSN",
    "AGENT_HOST",
    "AGENT_PORT",
    "AGENT_INSTRUCTIONS",
    "AGENT_USER_NAME",
    "USE_REGISTRY",
    "USE_SUPERVISOR",
    "SyncReport",
    "approval_tool",
    "legacy_approval_tool",
    "mcp_manager",
    "config_client",
    "llm_config",
    "image_provider_manager",
    "generate_image_tool",
    "legacy_generate_image_tool",
    "cp_context_service_client",
    "cp_event_store_client",
    "context_provider",
    "crash_recovery",
    "run_cancel_registry",
    "worker_registry",
    "_watcher_observer",
    "_watcher_event_handler",
    "_agent_status",
    "_llm_ready",
    "_llm_verified_at",
    "_runtime_config_revision",
    "_model_catalog",
    "_runtime_refresh_lock",
    "_instance_id",
    "embedding_model",
    "_embedding_api_key",
    "_embedding_api_base",
    "embedding_enabled",
    "embedding_service",
    "embedding_adapter",
    "vector_store",
    "_token_counter",
    "get_env",
    "get_int_env",
    "_parse_recover_session_ids",
    "_log_token_usage",
    "_derive_llm_ready",
    "_llm_readiness_error_code",
    "_has_instance_fallback_credentials",
    "_validate_run_overrides",
    "_normalize_run_overrides",
    "_normalize_tool_timeouts",
    "_merge_run_domain",
    "_classify_llm_exception",
    "_enrich_with_rag_context",
    "_get_mcp_tools",
    "_get_tools_for_mode",
    "get_llm_initialization_status",
    "_refresh_embedding_config",
    "_resolve_policy_for_model",
    "_model_window_tokens",
    "_estimate_input_tokens",
    "_content_length",
    "_deserialize_messages",
    "_to_langchain_messages",
    "_token_counter",
]


def get_env(name: str) -> str | None:
    value = os.getenv(name)
    if value is None or value == "":
        return None
    return value


def get_int_env(name: str, default: int) -> int:
    value = os.getenv(name)
    if value is None or value == "":
        return default
    try:
        return int(value)
    except ValueError as exc:
        raise RuntimeError(f"{name} must be an integer, got: {value}") from exc


CP_URL = get_env("XIHE_CP_URL") or f"http://localhost:{get_int_env('XIHE_CP_PORT', 12631)}"
MCP_URL = f"{CP_URL}/api/v1/mcp"
AGENT_HOST = get_env("XIHE_AGENT_HOST") or "0.0.0.0"
AGENT_PORT = get_int_env("XIHE_AGENT_PORT", 12632)
MCP_RETRY_INTERVAL = 2.0
CP_API_TOKEN = get_env("XIHE_CP_API_TOKEN") or "dev-token-not-secure"


def _parse_recover_session_ids() -> list[str]:
    raw = get_env("XIHE_RECOVER_SESSION_IDS") or ""
    return [s.strip() for s in raw.split(",") if s.strip()]


approval_tool = ApprovalAgentTool()
mcp_manager = MCPClientManager(
    cp_url=MCP_URL,
    server_name="cp",
    workspace_id=get_env("XIHE_WORKSPACE_ID"),
    api_token=CP_API_TOKEN,
    approval_tool=approval_tool,
    retry_interval=MCP_RETRY_INTERVAL,
)
legacy_approval_tool = ApprovalTool()
config_client = ConfigClient(
    cp_url=CP_URL,
    api_token=CP_API_TOKEN,
    workspace_id=get_env("XIHE_WORKSPACE_ID"),
)
_models_router.bind(config_client)

llm_config = LLMConfig.from_config_client(config_client)
image_provider_manager = ProviderManager.from_env(config_client.get("llm-provider", "imageProvider"))
generate_image_tool = GenerateImageAgentTool(provider_manager=image_provider_manager)
legacy_generate_image_tool = GenerateImageTool(provider_manager=image_provider_manager)

cp_context_service_client = CPContextServiceClient(base_url=CP_URL, api_token=CP_API_TOKEN)
cp_event_store_client = CPEventStoreClient(base_url=CP_URL, api_token=CP_API_TOKEN)
context_provider = EventSourcedContextProvider(cp_context_service_client)
crash_recovery = CrashRecovery(cp_event_store_client)

# PLAN-290 M0.3: active-run cancel registry shared by /chat stream and
# POST /internal/v1/agent/runs/{runId}/cancel (CP forwards from chat cancel).
run_cancel_registry = RunCancelRegistry()

# RAG
PG_DSN = get_env("XIHE_PG_DSN") or "postgresql+psycopg://xihe:@localhost:12634/xihe"
embedding_model: str | None = None
_embedding_api_key: str | None = None
_embedding_api_base: str | None = None
embedding_enabled = False
# Created and swapped inside _refresh_embedding_config (module `global`
# assignments). The bare annotations declare their types for readers without
# changing the current "NameError until first refresh" runtime behaviour.
embedding_service: EmbeddingService
embedding_adapter: LiteLLMEmbeddings
vector_store: VectorStore


def _refresh_embedding_config() -> None:
    global embedding_model, _embedding_api_key, _embedding_api_base
    global embedding_enabled, embedding_service, embedding_adapter, vector_store

    embedding_model = config_client.get("embedding", "model")
    _embedding_api_key = None
    _embedding_api_base = None

    if embedding_model:
        from litellm import get_llm_provider

        try:
            _, provider, _, resolved_api_base = get_llm_provider(embedding_model)
            # PLAN-0307 decision #21: config holds no credentials; the env
            # fallback is the only instance-level source for embedding keys.
            _embedding_api_key = env_api_key(provider) or None
            _embedding_api_base = resolve_provider_base_url(
                config_client.get_domain("llm-provider"),
                provider,
                resolved_api_base,
            )
        except Exception as e:
            logger.warning("Failed to resolve embedding provider: {}", e)

    # The default OpenAI embedding model must not create a request without credentials.
    embedding_enabled = bool(embedding_model and _embedding_api_key)
    if embedding_model and not embedding_enabled:
        logger.warning(
            "[LIFECYCLE] service=agent event=rag_embedding_disabled model={} reason=missing_api_key",
            embedding_model,
        )

    embedding_service = EmbeddingService(
        model=embedding_model or "mock",
        api_key=_embedding_api_key,
        api_base=_embedding_api_base,
    )
    embedding_adapter = LiteLLMEmbeddings(service=embedding_service)
    dimensions = config_client.get("embedding", "dimensions")
    vector_store = VectorStore(
        dsn=PG_DSN,
        embedding_service=embedding_adapter,
        vector_size=int(dimensions) if dimensions else None,
    )


_refresh_embedding_config()

_token_counter = TokenCounter()

AGENT_INSTRUCTIONS = (
    config_client.get("agent-runtime", "instructions")
    or "You are xihe Agent. Answer in Chinese by default. "
    "Use the provided tools whenever the user asks about workspace files, directories, "
    "or commands, then answer with the tool results."
)
AGENT_USER_NAME = config_client.get("agent-profile", "userName") or "User"
USE_SUPERVISOR = config_client.get_bool("agent-runtime", "useSupervisor")
USE_REGISTRY = config_client.get_bool("agent-runtime", "useRegistry")

worker_registry: WorkerRegistry | None = None
_watcher_observer: Any = None
_watcher_event_handler: Any = None
_agent_status: str = "starting"  # starting | ok | degraded
_llm_ready: str = "unknown"
_llm_verified_at: str | None = None
_runtime_config_revision: str = ""
_model_catalog: dict[str, Any] = {"models": {}, "providers": {}, "configRevision": ""}
_runtime_refresh_lock = asyncio.Lock()
_instance_id: str = str(uuid4())


def _log_token_usage(result: Any) -> None:
    """Log token usage from LLM response for monitoring."""
    try:
        if hasattr(result, "usage_metadata") and result.usage_metadata:
            meta = result.usage_metadata
            logger.info(
                "Token usage: input={} output={} total={}",
                meta.get("input_tokens", "?"),
                meta.get("output_tokens", "?"),
                meta.get("total_tokens", "?"),
            )
    except Exception:
        logger.debug("Token usage metadata not available")


def _derive_llm_ready(
    report: SyncReport,
    catalog: dict[str, Any],
    config: LLMConfig,
) -> tuple[str, str | None]:
    llm_domain = report["domains"].get("llm-provider")
    required_status: str = llm_domain["status"] if llm_domain else "unknown"
    if required_status in {"unreachable", "unauthorized", "invalid_response"}:
        return "unknown", None
    if config.provider == "mock":
        return "ready", None

    provider_info = catalog.get("providers", {}).get(config.provider)
    if not isinstance(provider_info, dict):
        # PLAN-0307 T2.13: no instance-level fallback credential for this
        # provider (BYOK, decision #37). Credential readiness is per-run via the
        # provider connection lease and is enforced at /internal/v1/agent/chat;
        # service readiness itself must not depend on instance keys.
        return "ready", None

    provider_status = provider_info.get("status")
    if provider_status == "missing_credentials":
        # Defensive contract mapping (review 2026-09-12): current catalog
        # sources only emit keyed providers, so this status is not produced by
        # the present call chain. It stays because `missing_credentials` is part
        # of the documented llmReady contract (AGENTS.md) and keeps cross-version
        # / remote catalog sources compatible.
        return "missing_credentials", None
    if provider_status == "invalid_credentials":
        return "invalid_credentials", None
    if provider_status == "unreachable":
        return "unreachable", None
    if provider_status == "invalid_response":
        return "model_unavailable", None
    if provider_status != "ready":
        return "unknown", None

    model_entries = provider_info.get("models", [])
    model_names = {
        item.get("name") for item in model_entries if isinstance(item, dict) and isinstance(item.get("name"), str)
    }
    chat_models = {
        item.get("name")
        for item in model_entries
        if isinstance(item, dict) and item.get("capabilities", {}).get("chat") is True
    }
    if config.model and config.model not in model_names:
        return "model_unavailable", provider_info.get("verifiedAt")
    if config.model and config.model not in chat_models:
        return "model_unavailable", provider_info.get("verifiedAt")
    return "ready", provider_info.get("verifiedAt")


def _llm_readiness_error_code(readiness: str) -> str:
    # `missing_credentials` is retained as a defensive/contract mapping (see
    # `_derive_llm_ready`); the live per-run gap is reported by the
    # LLM_NOT_CONFIGURED response inside `/chat`.
    return {
        "missing_credentials": "LLM_NOT_CONFIGURED",
        "invalid_credentials": "LLM_CREDENTIALS_INVALID",
        "unreachable": "LLM_PROVIDER_UNREACHABLE",
        "model_unavailable": "LLM_MODEL_UNAVAILABLE",
    }.get(readiness, "AGENT_UNAVAILABLE")


def _has_instance_fallback_credentials(config: LLMConfig) -> bool:
    """True when a keyless run can still call the provider (mock or env key)."""
    return config.provider == "mock" or bool(config.api_key)


def _validate_run_overrides(raw: Any, field: str) -> str | None:
    """PLAN-0307 T2.7: payload override shape is {domain: {key: string}}."""
    if raw is None:
        return None
    if not isinstance(raw, dict):
        return f"{field} must be an object"
    for domain, entries in raw.items():
        if not isinstance(entries, dict):
            return f"{field}.{domain} must be an object"
        for key, value in entries.items():
            if not isinstance(value, str):
                return f"{field}.{domain}.{key} must be a string"
    return None


def _normalize_run_overrides(raw: Any) -> dict[str, dict[str, str]]:
    if not isinstance(raw, dict):
        return {}
    return {
        str(domain): {str(key): str(value) for key, value in entries.items()}
        for domain, entries in raw.items()
        if isinstance(entries, dict)
    }


def _normalize_tool_timeouts(raw: Any) -> dict[str, int]:
    """PLAN-0308 T1.9（决策 #27/#28）：per-call 原始值（CP 已校验并回传）。

    本模块不改写、不计算；非正整数（CP 不会产生）的条目忽略并告警。
    """
    values: dict[str, int] = {}
    if isinstance(raw, dict):
        for tool_name, seconds in raw.items():
            if (
                isinstance(seconds, (int, float))
                and not isinstance(seconds, bool)
                and float(seconds) > 0
                and float(seconds).is_integer()
            ):
                values[str(tool_name)] = int(seconds)
            else:
                logger.warning("Ignoring invalid toolTimeouts entry {}={!r}", tool_name, seconds)
    return values


def _merge_run_domain(
    domain: str,
    user_overrides: dict[str, dict[str, str]],
    workspace_overrides: dict[str, dict[str, str]],
) -> dict[str, str]:
    """Run-local merge: pulled effective -> user -> workspace (PLAN-0307 T2.7).

    Pure function (decision #24/G6): never writes back to the process snapshot.
    """
    merged = dict(config_client.get_domain(domain))
    merged.update(user_overrides.get(domain, {}))
    merged.update(workspace_overrides.get(domain, {}))
    return merged


def _classify_llm_exception(error: Exception) -> tuple[str, str, bool]:
    """Map provider failures to safe, stable client-facing error semantics."""
    if isinstance(error, LLMRouteConfigError):
        return "LLM_BASE_URL_MISSING", str(error), False
    text = str(error).lower()
    if (
        isinstance(error, litellm.exceptions.UnsupportedParamsError)
        or "unsupportedparams" in text
        or "does not support parameters" in text
    ):
        # PLAN-0364 M3: the resolved route rejects tool parameters (e.g. the native
        # Xiaomi slug has no tool metadata). Never drop tools silently — the user
        # must switch to an OpenAI-compatible connection or another model.
        return (
            "LLM_TOOL_ROUTE_UNSUPPORTED",
            "当前模型路由不支持工具调用：请改用 OpenAI 兼容连接，或更换支持工具的模型",
            False,
        )
    provider_status = getattr(error, "status_code", None)
    if provider_status is None:
        provider_status = getattr(getattr(error, "response", None), "status_code", None)
    if isinstance(error, litellm.exceptions.BadRequestError) or provider_status == 400:
        # The provider rejected the payload (message shape / params / tool schema).
        # Non-retryable: the same request cannot succeed; log the raw text for triage.
        logger.error("[LLM] provider rejected the request: {}", str(error)[:500])
        return (
            "LLM_REQUEST_REJECTED",
            "模型提供方拒绝了该请求（消息格式或参数不被接受）",
            False,
        )
    if any(marker in text for marker in ("missing credentials", "api key", "apikey")):
        return "LLM_NOT_CONFIGURED", "Provider credentials are not configured", True
    if any(marker in text for marker in ("authentication", "unauthorized", "401", "403")):
        return "LLM_CREDENTIALS_INVALID", "Provider credentials were rejected", False
    if any(marker in text for marker in ("timeout", "timed out")):
        return "LLM_PROVIDER_UNREACHABLE", "Provider request timed out", True
    if any(marker in text for marker in ("connection", "connect", "dns", "unreachable")):
        return "LLM_PROVIDER_UNREACHABLE", "Provider is unreachable", True
    return "AGENT_STREAM_FAILED", "Agent stream failed", True


async def _enrich_with_rag_context(content: str, instructions: str) -> str:
    """Search RAG knowledge base and append relevant context to instructions."""
    if not embedding_enabled:
        return instructions

    try:
        query_emb = await embedding_service.embed(content)
        results = await vector_store.search(query_emb, top_k=3, min_score=0.3)
        if results:
            context_parts = []
            for r in results:
                context_parts.append(f"[Knowledge: {r['text']}]")
            rag_context = "\n".join(context_parts)
            return f"{instructions}\n\n## RAG Context\n{rag_context}"
    except Exception:
        logger.warning("RAG enrichment failed", exc_info=True)
    return instructions


async def _get_mcp_tools(workspace_id: str | None) -> list[Any]:
    """Load MCP tools only for a workspace-bound request."""
    if not workspace_id:
        return []
    if mcp_manager.initialized and mcp_manager.workspace_id != workspace_id:
        # This process owns one MCP workspace in the minimal boundary. Never
        # reuse tools discovered for a different workspace.
        raise RuntimeError("MCP workspace context cannot be reused across workspaces")

    try:
        await mcp_manager.initialize(workspace_id=workspace_id)
    except Exception as e:
        logger.warning(
            "[LIFECYCLE] service=agent event=mcp_request_init_failed workspaceId={} error={}",
            workspace_id,
            e,
        )
        raise RuntimeError("MCP workspace initialization failed") from e
    return mcp_manager.tools


async def _get_tools_for_mode(tool_mode: str, workspace_id: str | None) -> list[Any]:
    """Keep the pure chat path free of MCP discovery and tool construction."""
    if tool_mode == "none":
        return []
    if tool_mode == "workspace" and not workspace_id:
        raise RuntimeError("workspaceId is required for workspace tool mode")
    return await _get_mcp_tools(workspace_id)


def get_llm_initialization_status() -> dict[str, Any]:
    return {
        "provider": llm_config.provider,
        "model": llm_config.model,
        # Readiness-derived (PLAN-0307 T2.13): credentials are per-run leases
        # under BYOK, so status must not inspect the instance API key.
        "configured": _llm_ready == "ready",
        "readiness": _llm_ready,
        "configRevision": _runtime_config_revision,
        "verifiedAt": _llm_verified_at,
    }


def _resolve_policy_for_model(
    model: str | None,
    user_overrides: dict[str, dict[str, str]] | None = None,
    workspace_overrides: dict[str, dict[str, str]] | None = None,
):
    """PLAN-0341 T1.6: effective context-policy for this run."""
    from xihe_agent.context_policy import resolve_context_policy

    entries = dict(config_client.get_domain("context-policy"))
    if user_overrides:
        entries.update(user_overrides.get("context-policy", {}))
    if workspace_overrides:
        entries.update(workspace_overrides.get("context-policy", {}))
    policy = resolve_context_policy(model, entries)
    logger.info(
        "[LIFECYCLE] service=agent event=context_policy_resolved model={} source={} maxInputTokens={} pruneWindowChars={} recoveryBand={}",
        model,
        policy.source,
        policy.max_input_tokens,
        policy.prune_window_chars,
        policy.recovery_band,
    )
    return policy


def _model_window_tokens(
    model: str | None,
    user_overrides: dict[str, dict[str, str]] | None = None,
    workspace_overrides: dict[str, dict[str, str]] | None = None,
) -> int:
    """PLAN-0341 T1.6: config maxInputTokens overrides litellm static table."""
    policy = _resolve_policy_for_model(model, user_overrides, workspace_overrides)
    if policy.max_input_tokens:
        return policy.max_input_tokens
    if not model:
        return 0
    try:
        info = litellm.model_cost.get(model) or {}
        return int(info.get("max_input_tokens") or 0)
    except Exception:
        return 0


def _estimate_input_tokens(messages: list[Any]) -> int:
    """PLAN-294 decision #12: local estimation of the assembled input.

    Role: pre-call compaction signal. Provider usage remains the truth source
    that calibrates these estimates via llm_usage events.
    """
    payload = []
    for m in messages:
        role = getattr(m, "role", "human")
        content = getattr(m, "content", "")
        payload.append({"role": role, "content": content})
    return _token_counter.estimate_messages(payload)


def _content_length(content: Any) -> int:
    if isinstance(content, str):
        return len(content)
    if isinstance(content, list):
        return sum(_content_length(item) for item in content)
    if isinstance(content, dict):
        return _content_length(content.get("text") or content.get("content") or "")
    return 0


def _deserialize_messages(raw: list[dict[str, Any]]) -> list[Message]:
    # PLAN-0381 T1.1: tool-history fields (pairing ids/flags) survive the
    # request-history round-trip; same reader rules as the snapshot loader.
    from xihe_agent.interfaces.context import message_from_dict

    return [message_from_dict(item) for item in raw]


def _to_langchain_messages(messages: list[Message]) -> list[AnyMessage]:
    # PLAN-0381 T1.4: one shared provider mapping (contract §7) — the runner
    # and this supervisor path must not diverge on pairing/degradation rules.
    from xihe_agent.agent_runner.langgraph_runner import to_langchain_messages

    return to_langchain_messages(messages)
