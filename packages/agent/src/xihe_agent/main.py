"""
xihe-agent: LLM Agent with LangChain integration.
Uses LangGraph create_react_agent for tool-calling loop,
langchain-mcp-adapters for MCP tool discovery,
and SSE streaming for real-time responses.
"""

import asyncio
import logging
import os
import sys
from contextlib import asynccontextmanager, suppress
from typing import Any, cast
from uuid import uuid4

import litellm
from fastapi import Depends, FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, StreamingResponse
from langchain_core.messages import BaseMessage
from litellm import get_llm_provider
from loguru import logger

from xihe_agent.adapters.approval_tool import (
    ApprovalAgentTool,
    ApprovalExecutorUnsupportedError,
    ApprovalTerminalError,
    ApprovalTool,
)
from xihe_agent.adapters.mcp_client import MCPClientManager
from xihe_agent.adapters.sse_adapter import render_sse
from xihe_agent.agent_runner import LangGraphRunner
from xihe_agent.cancel_registry import RunCancelRegistry
from xihe_agent.config_client import ConfigClient
from xihe_agent.context import (
    CPContextServiceClient,
    CPEventStoreClient,
    CrashRecovery,
    EventSourcedContextProvider,
)
from xihe_agent.dotenv_loader import load_project_env
from xihe_agent.interfaces.agent_runner import RunnerConfig
from xihe_agent.interfaces.message import Message, TextMessage
from xihe_agent.llm.base import LLMConfig, ProviderName, create_llm
from xihe_agent.llm.models import _models_router, fetch_model_catalog
from xihe_agent.llm.models import router as models_router
from xihe_agent.llm.token_counter import TokenCounter
from xihe_agent.rag import EmbeddingService, LiteLLMEmbeddings, VectorStore
from xihe_agent.rag import chunk_document as rag_chunk
from xihe_agent.registry.registry import WorkerRegistry
from xihe_agent.tools import GenerateImageAgentTool, GenerateImageTool, ProviderManager

# Suppress litellm verbose debugging that prints Authorization headers and
# full request payloads. The redaction boundary already masks Bearer/JWT, but
# disabling verbose output at the source keeps credentials out of logs.
litellm.suppress_debug_info = True  # type: ignore[attr-defined]
with suppress(Exception):
    litellm.set_verbose = False  # type: ignore[attr-defined]


def get_env(name: str) -> str | None:
    value = os.getenv(name)
    if value is None or value == "":
        return None
    return value


def get_log_level_env(*names: str, default: str) -> str:
    for name in names:
        value = get_env(name)
        if value is not None:
            return value
    return default


def normalize_agent_log_level(level_name: str) -> str:
    normalized = level_name.strip().lower()
    if normalized in {"trace", "debug", "info", "warning", "error", "critical"}:
        return normalized
    if normalized == "warn":
        return "warning"
    return "info"


def resolve_python_log_level(level_name: str) -> int:
    normalized = normalize_agent_log_level(level_name)
    if normalized == "trace":
        return logging.DEBUG
    return getattr(logging, normalized.upper(), logging.INFO)


AGENT_LOG_LEVEL = normalize_agent_log_level(
    get_log_level_env("XIHE_LOG_LEVEL_AGENT", "XIHE_LOG_LEVEL", default="info")
)

_log_dir = get_env("XIHE_LOG_DIR") or "logs"
os.makedirs(_log_dir, exist_ok=True)

# Route stdlib logging from libraries (uvicorn, langchain, etc.) to loguru
class _InterceptHandler(logging.Handler):
    def emit(self, record: logging.LogRecord) -> None:
        logger_opt = logger.opt(depth=6, exception=record.exc_info)
        logger_opt.log(record.levelno, record.getMessage())

logging.basicConfig(handlers=[_InterceptHandler()], level=0, force=True)

with suppress(ValueError):
    logger.remove(0)  # Remove default stderr handler
from xihe_agent.log_redact import patch_record as _redact_patch  # noqa: E402

logger.configure(patcher=_redact_patch)
logger.add(sys.stderr, level=AGENT_LOG_LEVEL.upper())
logger.add(
    os.path.join(_log_dir, "agent.log"),
    rotation="100 MB",
    retention=7,
    level=AGENT_LOG_LEVEL.upper(),
    serialize=True,
)


# Override log level from CP ConfigService
def _configure_log_level(level_name: str) -> None:
    level = normalize_agent_log_level(level_name)
    log_dir = get_env("XIHE_LOG_DIR") or "logs"
    logger.remove()
    logger.add(sys.stderr, level=level.upper())
    logger.add(
        os.path.join(log_dir, "agent.log"),
        rotation="100 MB",
        retention=7,
        level=level.upper(),
        serialize=True,
    )


async def _apply_cp_log_level() -> None:
    try:
        level = config_client.get("logging", "levelAgent")
        if level:
            _configure_log_level(level)
    except Exception:
        logger.warning("CP log level unavailable, keeping current level", exc_info=True)


async def _poll_runtime_config() -> None:
    while True:
        try:
            await reload_runtime_config(reason="periodic")
        except Exception:
            logger.warning(
                "[LIFECYCLE] service=agent event=config_refresh_failed reason=periodic",
                exc_info=True,
            )
        await asyncio.sleep(30)


def get_int_env(name: str, default: int) -> int:
    value = os.getenv(name)
    if value is None or value == "":
        return default
    try:
        return int(value)
    except ValueError as exc:
        raise RuntimeError(f"{name} must be an integer, got: {value}") from exc


CP_URL = (
    get_env("XIHE_CP_URL") or f"http://localhost:{get_int_env('XIHE_CP_PORT', 12631)}"
)
MCP_URL = f"{CP_URL}/api/v1/mcp"
AGENT_HOST = get_env("XIHE_AGENT_HOST") or "0.0.0.0"
AGENT_PORT = get_int_env("XIHE_AGENT_PORT", 12632)
MCP_RETRY_INTERVAL = 2.0
CP_API_TOKEN = get_env("XIHE_CP_API_TOKEN") or "dev-token-not-secure"


def _parse_recover_session_ids() -> list[str]:
    raw = get_env("XIHE_RECOVER_SESSION_IDS") or ""
    return [s.strip() for s in raw.split(",") if s.strip()]


def verify_api_token(request: Request) -> None:
    auth_header = request.headers.get("Authorization", "")
    token = auth_header.removeprefix("Bearer ") if auth_header.startswith("Bearer ") else None
    if token != CP_API_TOKEN:
        logger.warning("Agent API token mismatch")
        raise HTTPException(status_code=403, detail="Forbidden: invalid API token")

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
image_provider_manager = ProviderManager.from_config_client(config_client)
generate_image_tool = GenerateImageAgentTool(provider_manager=image_provider_manager)
legacy_generate_image_tool = GenerateImageTool(provider_manager=image_provider_manager)

cp_context_service_client = CPContextServiceClient(base_url=CP_URL, api_token=CP_API_TOKEN)
cp_event_store_client = CPEventStoreClient(base_url=CP_URL, api_token=CP_API_TOKEN)
context_provider = EventSourcedContextProvider(cp_context_service_client)
crash_recovery = CrashRecovery(cp_event_store_client)
agent_runner = LangGraphRunner(model_factory=lambda model: create_llm(llm_config.with_model(model)), event_store=cp_event_store_client)
# PLAN-290 M0.3: active-run cancel registry shared by /chat stream and
# POST /internal/v1/agent/runs/{runId}/cancel (CP forwards from chat cancel).
run_cancel_registry = RunCancelRegistry()

# RAG
PG_DSN = (
    get_env("XIHE_PG_DSN")
    or "postgresql+psycopg://xihe:@localhost:12634/xihe"
)
embedding_model: str | None = None
_embedding_api_key: str | None = None
_embedding_api_base: str | None = None
embedding_enabled = False


def _refresh_embedding_config() -> None:
    global embedding_model, _embedding_api_key, _embedding_api_base
    global embedding_enabled, embedding_service, embedding_adapter, vector_store

    embedding_model = config_client.get("embedding", "model")
    _embedding_api_key = None
    _embedding_api_base = None

    if embedding_model:
        try:
            _, provider, _, resolved_api_base = get_llm_provider(embedding_model)
            provider_cfg = config_client.get_providers().get(provider, {})
            _embedding_api_key = provider_cfg.get("apiKey") or None
            _embedding_api_base = provider_cfg.get("baseUrl") or resolved_api_base
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

AGENT_INSTRUCTIONS = (
    config_client.get("agent-runtime", "instructions")
    or "You are xihe Agent. Answer in Chinese by default. "
    "Use the provided tools whenever the user asks about workspace files, directories, "
    "or commands, then answer with the tool results."
)
AGENT_USER_NAME = (
    config_client.get("agent-profile", "userName")
    or "User"
)
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
            logger.info("Token usage: input={} output={} total={}",
                        meta.get("input_tokens", "?"),
                        meta.get("output_tokens", "?"),
                        meta.get("total_tokens", "?"))
    except Exception:
        logger.debug("Token usage metadata not available")


def _derive_llm_ready(
    report: dict[str, Any],
    catalog: dict[str, Any],
    config: LLMConfig,
) -> tuple[str, str | None]:
    required_status = (
        report.get("domains", {})
        .get("llm-provider", {})
        .get("effective", "unknown")
    )
    if required_status in {"unreachable", "unauthorized", "invalid_response"}:
        return "unknown", None
    if config.provider == "mock":
        return "ready", None

    provider_info = catalog.get("providers", {}).get(config.provider)
    if not isinstance(provider_info, dict):
        return "missing_credentials", None

    provider_status = provider_info.get("status")
    if provider_status == "missing_credentials":
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
        item.get("name")
        for item in model_entries
        if isinstance(item, dict) and isinstance(item.get("name"), str)
    }
    chat_models = {
        item.get("name")
        for item in model_entries
        if isinstance(item, dict)
        and item.get("capabilities", {}).get("chat") is True
    }
    if config.model and config.model not in model_names:
        return "model_unavailable", provider_info.get("verifiedAt")
    if config.model and config.model not in chat_models:
        return "model_unavailable", provider_info.get("verifiedAt")
    return "ready", provider_info.get("verifiedAt")


def _llm_readiness_error_code(readiness: str) -> str:
    return {
        "missing_credentials": "LLM_NOT_CONFIGURED",
        "invalid_credentials": "LLM_CREDENTIALS_INVALID",
        "unreachable": "LLM_PROVIDER_UNREACHABLE",
        "model_unavailable": "LLM_MODEL_UNAVAILABLE",
    }.get(readiness, "AGENT_UNAVAILABLE")


def _classify_llm_exception(error: Exception) -> tuple[str, str, bool]:
    """Map provider failures to safe, stable client-facing error semantics."""
    text = str(error).lower()
    if any(marker in text for marker in ("missing credentials", "api key", "apikey")):
        return "LLM_NOT_CONFIGURED", "Provider credentials are not configured", True
    if any(marker in text for marker in ("authentication", "unauthorized", "401", "403")):
        return "LLM_CREDENTIALS_INVALID", "Provider credentials were rejected", False
    if any(marker in text for marker in ("timeout", "timed out")):
        return "LLM_PROVIDER_UNREACHABLE", "Provider request timed out", True
    if any(marker in text for marker in ("connection", "connect", "dns", "unreachable")):
        return "LLM_PROVIDER_UNREACHABLE", "Provider is unreachable", True
    return "AGENT_STREAM_FAILED", "Agent stream failed", True


async def reload_runtime_config(reason: str) -> dict[str, Any]:
    """Refresh config-derived dependencies and swap their runtime snapshot atomically."""
    global llm_config, image_provider_manager, generate_image_tool
    global AGENT_INSTRUCTIONS, AGENT_USER_NAME, USE_SUPERVISOR, USE_REGISTRY
    global _llm_ready, _llm_verified_at, _runtime_config_revision, _model_catalog, _agent_status

    async with _runtime_refresh_lock:
        report = await config_client.sync_with_retry()
        if report.get("refreshed"):
            staged_llm_config = LLMConfig.from_config_client(config_client)
            staged_image_manager = ProviderManager.from_config_client(config_client)
            staged_catalog = await fetch_model_catalog(config_client)
        else:
            staged_llm_config = llm_config
            staged_image_manager = image_provider_manager
            staged_catalog = _model_catalog

        staged_ready, staged_verified_at = _derive_llm_ready(
            report,
            staged_catalog,
            staged_llm_config,
        )

        llm_config = staged_llm_config
        image_provider_manager = staged_image_manager
        generate_image_tool = GenerateImageAgentTool(provider_manager=image_provider_manager)
        _model_catalog = staged_catalog
        _llm_ready = staged_ready
        _llm_verified_at = staged_verified_at
        _runtime_config_revision = config_client.config_revision
        _refresh_embedding_config()

        if cc_instructions := config_client.get("agent-runtime", "instructions"):
            AGENT_INSTRUCTIONS = cc_instructions
        if cc_user_name := config_client.get("agent-profile", "userName"):
            AGENT_USER_NAME = cc_user_name
        USE_SUPERVISOR = config_client.get_bool("agent-runtime", "useSupervisor")
        USE_REGISTRY = config_client.get_bool("agent-runtime", "useRegistry")
        _agent_status = "ok" if staged_ready == "ready" else "degraded"

        logger.info(
            "[LIFECYCLE] service=agent event=runtime_config_swapped reason={} revision={} llmReady={} provider={} model={} verifiedAt={}",
            reason,
            _runtime_config_revision,
            _llm_ready,
            llm_config.provider,
            llm_config.model,
            _llm_verified_at or "none",
        )
        return report


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
        "configured": bool(llm_config.api_key) or llm_config.provider == "mock",
        "readiness": _llm_ready,
        "configRevision": _runtime_config_revision,
        "verifiedAt": _llm_verified_at,
    }


@asynccontextmanager
async def lifespan(app: FastAPI):
    global worker_registry, _watcher_observer, _watcher_event_handler
    global AGENT_INSTRUCTIONS, AGENT_USER_NAME, USE_SUPERVISOR, USE_REGISTRY
    global _agent_status

    logger.info(
        "[LIFECYCLE] service=agent event=startup_begin provider={} model={} cp_url={}",
        llm_config.provider,
        llm_config.model,
        CP_URL,
    )

    # Config sync, provider preflight, and readiness form one atomic startup path.
    try:
        await reload_runtime_config(reason="startup")
    except Exception as e:
        _agent_status = "degraded"
        logger.error(
            "[LIFECYCLE] service=agent event=config_sync_failed error={}",
            e,
            exc_info=True,
        )

    await _apply_cp_log_level()
    poll_task = asyncio.create_task(_poll_runtime_config())

    # MCP is request-scoped; pure chat must not trigger remote discovery at startup.
    logger.info("[LIFECYCLE] service=agent event=mcp_init_deferred reason=lazy_request")

    logger.info(
        "[LIFECYCLE] service=agent event=status_change from=starting to={} reason=runtime_config_loaded llmReady={}",
        _agent_status,
        _llm_ready,
    )

    # Recover any sessions configured for crash recovery before accepting traffic.
    recover_ids = _parse_recover_session_ids()
    if recover_ids:
        try:
            recovered = await crash_recovery.recover_many(recover_ids)
            logger.info("Crash recovery complete: {} session(s)", len(recovered))
            for sid, ctx in recovered.items():
                logger.info(
                    "Recovered session {} latest_sequence={} message_count={}",
                    sid,
                    ctx.latest_sequence,
                    len(ctx.messages),
                )
        except Exception:
            logger.warning("Crash recovery failed", exc_info=True)

    if USE_REGISTRY:
        from xihe_agent.registry.watcher import start_watcher

        model = create_llm(llm_config)
        custom_tools = [approval_tool, generate_image_tool]
        # Registry startup must not initialize MCP. Workspace/tool requests
        # discover tools lazily in the request-scoped workspace path.
        mcp_tools: list[Any] = []
        _workers_dir = config_client.get("agent-runtime", "workersDir")
        worker_registry = WorkerRegistry(workers_dir=_workers_dir)
        worker_registry.load_all(model, mcp_tools, custom_tools)
        _watcher_observer, _watcher_event_handler = start_watcher(
            worker_registry, model, mcp_tools, custom_tools,
        )
        logger.info("Worker registry initialized with {} worker(s)", len(worker_registry.list_workers()))

    yield

    logger.info("[LIFECYCLE] service=agent event=shutdown reason=lifespan_exit")
    if _watcher_observer is not None:
        _watcher_observer.stop()
        _watcher_observer.join()
    if poll_task is not None:
        poll_task.cancel()
        with suppress(asyncio.CancelledError):
            await poll_task


app = FastAPI(title="xihe-agent", version="0.1.0", lifespan=lifespan)
app.include_router(models_router)


@app.middleware("http")
async def request_id_middleware(request: Request, call_next):
    request_id = request.headers.get("X-Request-Id") or str(uuid4())
    with logger.contextualize(request_id=request_id):
        response = await call_next(request)
    response.headers["X-Request-Id"] = request_id
    return response


@app.exception_handler(HTTPException)
async def problem_details_handler(request: Request, exc: HTTPException) -> JSONResponse:
    request_id = request.headers.get("X-Request-Id") or str(uuid4())
    # Do not expose dependency, validation, or internal exception messages.
    detail = "Agent request failed"
    return JSONResponse(
        status_code=exc.status_code,
        media_type="application/problem+json",
        headers={"X-Request-Id": request_id},
        content={
            "type": "https://xihe.dev/problems/agent-error",
            "title": "Agent request failed",
            "status": exc.status_code,
            "code": "AGENT_REQUEST_FAILED",
            "detail": detail,
            "requestId": request_id,
        },
    )


@app.exception_handler(RequestValidationError)
async def validation_problem_handler(request: Request, exc: RequestValidationError) -> JSONResponse:
    request_id = request.headers.get("X-Request-Id") or str(uuid4())
    return JSONResponse(
        status_code=400,
        media_type="application/problem+json",
        headers={"X-Request-Id": request_id},
        content={
            "type": "https://xihe.dev/problems/invalid-request",
            "title": "Invalid request",
            "status": 400,
            "code": "INVALID_REQUEST",
            "detail": "Request validation failed",
            "requestId": request_id,
        },
    )


@app.exception_handler(Exception)
async def internal_problem_handler(request: Request, exc: Exception) -> JSONResponse:
    logger.exception("Unhandled Agent request failure")
    request_id = request.headers.get("X-Request-Id") or str(uuid4())
    return JSONResponse(
        status_code=500,
        media_type="application/problem+json",
        headers={"X-Request-Id": request_id},
        content={
            "type": "https://xihe.dev/problems/internal-error",
            "title": "Internal server error",
            "status": 500,
            "code": "INTERNAL_ERROR",
            "detail": "Agent request failed",
            "requestId": request_id,
        },
    )


_token_counter = TokenCounter()


def _model_window_tokens(model: str | None) -> int:
    """Best-effort model context window (decision #11). model_cost first;
    the 3-tier contextPolicy maxInputTokens override lands with F1 config."""
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


@app.post("/internal/v1/agent/chat")
async def chat(request: Request, _token: None = Depends(verify_api_token)):
    data = await request.json()
    content: str = data.get("content", "")
    session_id: str = data.get("sessionId", "default")
    workspace_id: str | None = data.get("workspaceId") or None
    request_id: str = request.headers.get("X-Request-Id") or str(uuid4())
    run_id: str = request.headers.get("X-Chat-Run-Id") or data.get("runId") or str(uuid4())
    operation_id: str | None = request.headers.get("X-Operation-Id") or data.get("operationId") or None
    user_name: str = data.get("userName", AGENT_USER_NAME)
    model_override: str | None = data.get("model")
    provider_override: str | None = data.get("provider")
    tool_mode: str = data.get("toolMode", "none")
    instructions: str = data.get("instructions", AGENT_INSTRUCTIONS)
    chat_history_raw: list[dict[str, Any]] = data.get("history", [])
    credential_lease: str | None = data.get("credentialLease") or None
    provider_connection_id: str | None = data.get("providerConnectionId") or None
    connection_revision = data.get("connectionRevision")

    if _llm_ready != "ready" and not credential_lease:
        error_code = _llm_readiness_error_code(_llm_ready)
        return JSONResponse(
            status_code=503,
            media_type="application/problem+json",
            headers={"X-Request-Id": request_id},
            content={
                "type": "https://xihe.dev/problems/llm-not-ready",
                "title": "LLM is not ready",
                "status": 503,
                "code": error_code,
                "detail": f"Agent LLM readiness is {_llm_ready}",
                "retryable": True,
                "provider": llm_config.provider,
                "model": model_override or llm_config.model,
                "requestId": request_id,
                "runId": run_id,
            },
        )

    if tool_mode not in {"none", "workspace"}:
        return JSONResponse(
            status_code=400,
            media_type="application/problem+json",
            headers={"X-Request-Id": request_id},
            content={
                "type": "https://xihe.dev/problems/invalid-tool-mode",
                "title": "Invalid tool mode",
                "status": 400,
                "code": "INVALID_REQUEST",
                "detail": "toolMode must be none or workspace",
                "requestId": request_id,
                "runId": run_id,
            },
        )

    request_config: LLMConfig
    if credential_lease:
        try:
            grant = await config_client.redeem_provider_lease({
                "lease": credential_lease,
                "runId": run_id,
                "providerConnectionId": provider_connection_id or "",
                "providerId": provider_override or "",
                "model": model_override or "",
                "connectionRevision": int(connection_revision or 0),
            })
        except Exception as exc:
            logger.warning(
                "Provider credential lease unavailable runId={} connectionId={} errorType={}",
                run_id,
                provider_connection_id,
                type(exc).__name__,
            )
            return JSONResponse(
                status_code=503,
                media_type="application/problem+json",
                headers={"X-Request-Id": request_id},
                content={
                    "type": "https://xihe.dev/problems/provider-connection-unavailable",
                    "title": "Provider connection unavailable",
                    "status": 503,
                    "code": "PROVIDER_CONNECTION_UNAVAILABLE",
                    "detail": "The selected provider connection is unavailable",
                    "retryable": True,
                    "provider": provider_override or "",
                    "model": model_override or "",
                    "requestId": request_id,
                    "runId": run_id,
                },
            )
        request_config = LLMConfig(
            provider=str(grant.get("provider", provider_override or "")),
            route_provider=str(grant.get("routeProvider", grant.get("provider", ""))),
            api_key=str(grant.get("apiKey") or ""),
            api_base=str(grant.get("baseUrl") or ""),
            model=str(grant.get("model") or model_override or ""),
            timeout=llm_config.timeout,
            max_tokens=llm_config.max_tokens,
            temperature=llm_config.temperature,
        )
    else:
        request_config = llm_config
    if not credential_lease and provider_override and provider_override != llm_config.provider:
        provider_info = _model_catalog.get("providers", {}).get(provider_override)
        provider_runtime = config_client.get_provider(provider_override)
        if not isinstance(provider_info, dict) or provider_info.get("status") != "ready" or not provider_runtime:
            return JSONResponse(
                status_code=503,
                media_type="application/problem+json",
                headers={"X-Request-Id": request_id},
                content={
                    "type": "https://xihe.dev/problems/model-unavailable",
                    "title": "Provider is not ready",
                    "status": 503,
                    "code": "LLM_MODEL_UNAVAILABLE",
                    "detail": "Selected provider is not ready",
                    "retryable": True,
                    "provider": provider_override,
                    "model": model_override or "",
                    "requestId": request_id,
                    "runId": run_id,
                },
            )
        request_config = LLMConfig(
            provider=cast(ProviderName, provider_override),
            api_key=str(provider_runtime.get("apiKey", "")),
            api_base=str(provider_runtime.get("baseUrl", "")),
            model=str(provider_runtime.get("model", "")),
            timeout=llm_config.timeout,
            max_tokens=llm_config.max_tokens,
            temperature=llm_config.temperature,
        )
    if model_override:
        request_config = request_config.with_model(model_override)

    logger.info(
        "[LIFECYCLE] service=agent event=chat_stream_started requestId={} sessionId={} workspaceId={} runId={} provider={} model={} contentLength={}",
        request_id,
        session_id,
        workspace_id,
        run_id,
        request_config.provider,
        request_config.model,
        len(content),
    )

    # Enrich with RAG context if knowledge base has content
    instructions = await _enrich_with_rag_context(content, instructions)

    chat_history = _deserialize_messages(chat_history_raw)
    model = create_llm(request_config)
    # Register before streaming so CP cancel can reach an in-flight run.
    cancel_event = run_cancel_registry.register(run_id)
    request_runner = LangGraphRunner(
        model_factory=lambda _model: create_llm(request_config),
        event_store=cp_event_store_client,
    )

    async def event_stream():
        terminal_sent = False
        error_sent = False
        error_seen = False
        llm_request_started = False
        terminal_outcome = "success"
        terminal_error_code: str | None = None
        token_count = 0
        assistant_chars = 0
        event_index = 0

        def correlated_data(event_data: dict[str, Any]) -> dict[str, Any]:
            payload = dict(event_data)
            payload.setdefault("requestId", request_id)
            payload.setdefault("runId", run_id)
            if operation_id:
                payload.setdefault("operationId", operation_id)
            return payload

        try:
            mcp_tools = await _get_tools_for_mode(tool_mode, workspace_id)
            if USE_SUPERVISOR and tool_mode == "workspace":
                raise ApprovalExecutorUnsupportedError(
                    "Approval is not supported by the buffered supervisor executor"
                )
                # Supervisor path remains on legacy tools until full migration.
                from langchain_core.messages import HumanMessage

                from xihe_agent.agent.supervisor import build_supervisor

                custom_tools = [approval_tool, generate_image_tool]
                supervisor = build_supervisor(
                    model, mcp_tools, custom_tools,
                    registry=worker_registry if USE_REGISTRY else None,
                )
                result = await supervisor.ainvoke({
                    "messages": _to_langchain_messages(chat_history) + [HumanMessage(content=content)]
                })
                for msg in result["messages"]:
                    if hasattr(msg, "content") and msg.content:
                        token_count += 1
                        msg_content = _content_length(msg.content)
                        assistant_chars += msg_content
                        event_index += 1
                        logger.debug(
                            "[LIFECYCLE] service=agent event=chat_stream_chunk requestId={} sessionId={} runId={} eventIndex={} tokenChars={}",
                            request_id,
                            session_id,
                            run_id,
                            event_index,
                            msg_content,
                        )
                        yield render_sse("token", correlated_data({"content": msg.content, "type": "token"}))
                terminal_sent = True
                yield render_sse("done", correlated_data({"type": "done"}))
            else:
                context = await context_provider.load(session_id, after_sequence=0)
                context.runtime_state["user_name"] = user_name
                context.runtime_state["instructions"] = instructions
                context.metadata.update({
                    "requestId": request_id,
                    "runId": run_id,
                    "sessionId": session_id,
                    "workspaceId": workspace_id,
                    "operationId": operation_id,
                })

                all_tools = [] if tool_mode == "none" else [approval_tool, generate_image_tool]
                if mcp_tools:
                    all_tools = list(mcp_tools) + all_tools

                messages = list(chat_history)
                messages.append(TextMessage(role="human", content=content))

                config = RunnerConfig(
                    model=model_override or request_config.model,
                    system_prompt=instructions,
                    tools=all_tools,
                    context=context,
                    cancel_event=cancel_event,
                )

                llm_request_started = True
                async for event in request_runner.stream(messages, config):
                    if event.type == "token":
                        token_chars = _content_length(event.data.get("content"))
                        token_count += 1
                        event_index += 1
                        if event.data.get("hint") != "reasoning":
                            assistant_chars += token_chars
                        logger.debug(
                            "[LIFECYCLE] service=agent event=chat_stream_chunk requestId={} sessionId={} runId={} eventIndex={} tokenChars={}",
                            request_id,
                            session_id,
                            run_id,
                            event_index,
                            token_chars,
                        )
                        yield render_sse("token", correlated_data(event.data))
                    elif event.type == "error":
                        error_seen = True
                        structured_code = event.data.get("code")
                        if structured_code:
                            terminal_error_code = str(structured_code)
                            error_detail = str(event.data.get("error", "Agent stream failed"))
                            retryable = False
                        else:
                            terminal_error_code, error_detail, retryable = _classify_llm_exception(
                                RuntimeError(str(event.data.get("error", "Agent stream failed")))
                            )
                        terminal_outcome = (
                            "ambiguous"
                            if llm_request_started and terminal_error_code in {"LLM_PROVIDER_UNREACHABLE", "AGENT_STREAM_FAILED"}
                            else "partial" if assistant_chars > 0 else "error"
                        )
                        if not error_sent:
                            error_sent = True
                            yield render_sse("error", correlated_data({
                                "code": terminal_error_code,
                                "detail": error_detail,
                                "retryable": retryable,
                                "outcome": terminal_outcome,
                                "type": "error",
                            }))
                    elif event.type == "done":
                        if terminal_sent:
                            continue
                        terminal_sent = True
                        done_data = {**event.data, "type": "done", "outcome": terminal_outcome}
                        if terminal_error_code:
                            done_data["errorCode"] = terminal_error_code
                        yield render_sse("done", correlated_data(done_data))
                    elif event.type == "usage":
                        # PLAN-294 decision #14: when no provider usage chunk
                        # arrived (source=fallback), estimate the input size
                        # from the assembled request so the compression signal
                        # and audit trail still carry a usable value.
                        usage_data = dict(event.data.get("usage") or {})
                        if usage_data.get("source") in (None, "fallback"):
                            estimated = _estimate_input_tokens(messages)
                            usage_data.setdefault("estimatedInputTokens", estimated)
                            usage_data["source"] = "estimated" if estimated else "fallback"
                        else:
                            usage_data.setdefault("estimatedInputTokens", 0)
                        # PLAN-294 M3 (decision #5): the model window rides
                        # along so the CP compaction gate can evaluate the
                        # percentage threshold without a config dependency.
                        usage_data["windowTokens"] = _model_window_tokens(request_config.model)
                        yield render_sse("usage", correlated_data({"usage": usage_data}))
                    else:
                        yield render_sse(event.type, correlated_data(event.data))
        except ApprovalTerminalError as exc:
            error_seen = True
            terminal_error_code = exc.code
            error_detail = str(exc)
            retryable = False
            terminal_outcome = "error"
            logger.info(
                "[LIFECYCLE] service=agent event=chat_approval_terminal requestId={} sessionId={} workspaceId={} runId={} errorCode={}",
                request_id,
                session_id,
                workspace_id,
                run_id,
                terminal_error_code,
            )
            if not error_sent:
                error_sent = True
                yield render_sse("error", correlated_data({
                    "code": terminal_error_code,
                    "detail": error_detail,
                    "retryable": retryable,
                    "outcome": terminal_outcome,
                    "type": "error",
                }))
        except Exception as exc:
            error_seen = True
            terminal_error_code, error_detail, retryable = _classify_llm_exception(exc)
            terminal_outcome = (
                "ambiguous"
                if llm_request_started and terminal_error_code in {"LLM_PROVIDER_UNREACHABLE", "AGENT_STREAM_FAILED"}
                else "partial" if assistant_chars > 0 else "error"
            )
            logger.exception(
                "[LIFECYCLE] service=agent event=chat_stream_failed requestId={} sessionId={} workspaceId={} runId={} errorCode={}",
                request_id,
                session_id,
                workspace_id,
                run_id,
                terminal_error_code,
            )
            if not error_sent:
                error_sent = True
                yield render_sse("error", correlated_data({
                    "code": terminal_error_code,
                    "detail": error_detail,
                    "retryable": retryable,
                    "outcome": terminal_outcome,
                    "type": "error",
                }))
        finally:
            # Always drop the cancel handle when the run body ends (terminal,
            # abort, or client disconnect) so later cancels report unknown.
            run_cancel_registry.unregister(run_id)

        if not terminal_sent:
            terminal_sent = True
            if not error_seen:
                terminal_outcome = "ambiguous"
            done_data: dict[str, Any] = {
                "type": "done",
                "synthetic": True,
                "outcome": terminal_outcome,
            }
            if error_seen and terminal_error_code:
                done_data["errorCode"] = terminal_error_code
            yield render_sse("done", correlated_data(done_data))

        logger.info(
            "[LIFECYCLE] service=agent event=chat_stream_finished requestId={} sessionId={} workspaceId={} runId={} tokenCount={} assistantChars={} outcome={}",
            request_id,
            session_id,
            workspace_id,
            run_id,
            token_count,
            assistant_chars,
            terminal_outcome,
        )

    return StreamingResponse(event_stream(), media_type="text/event-stream")


@app.post("/internal/v1/agent/runs/{run_id}/cancel")
async def cancel_run(run_id: str, request: Request, _token: None = Depends(verify_api_token)):
    """PLAN-290 M0.3 Agent-side cancel contract (CP forwards chat cancel here).

    Returns one of:
    - accepted: cancel attached to an active run (HTTP 202)
    - unknown: runId not registered / already finished (HTTP 404)
    - failed: cancel action itself failed (HTTP 500)
    """
    try:
        data = await request.json()
        if not isinstance(data, dict):
            data = {}
    except Exception:
        data = {}
    reason = str(data.get("reason") or "user_requested")
    workspace_id = data.get("workspaceId")

    try:
        status = run_cancel_registry.cancel(run_id)
    except Exception:
        logger.error(
            "[LIFECYCLE] service=agent event=run_cancel_endpoint runId={} status=failed reason={} workspaceId={}",
            run_id,
            reason,
            workspace_id,
            exc_info=True,
        )
        return JSONResponse(
            status_code=500,
            content={"status": "failed", "runId": run_id, "code": "CANCEL_FAILED"},
        )
    if status == "accepted":
        logger.info(
            "[LIFECYCLE] service=agent event=run_cancel_endpoint runId={} status=accepted reason={} workspaceId={}",
            run_id,
            reason,
            workspace_id,
        )
        return JSONResponse(
            status_code=202,
            content={"status": "accepted", "runId": run_id},
        )
    if status == "unknown":
        return JSONResponse(
            status_code=404,
            content={"status": "unknown", "runId": run_id},
        )
    logger.error(
        "[LIFECYCLE] service=agent event=run_cancel_endpoint runId={} status=failed reason={}",
        run_id,
        reason,
    )
    return JSONResponse(
        status_code=500,
        content={"status": "failed", "runId": run_id, "code": "CANCEL_FAILED"},
    )


def _rag_config_defaults() -> dict[str, float | int]:
    """PLAN-0307 T2.4: RAG defaults come from the DB `rag` domain; request params win."""
    return {
        "chunkSize": int(config_client.get("rag", "chunkSize") or 1000),
        "chunkOverlap": int(config_client.get("rag", "chunkOverlap") or 200),
        "topK": int(config_client.get("rag", "topK") or 5),
        "minScore": float(config_client.get("rag", "minScore") or 0.0),
    }


@app.post("/internal/v1/agent/rag/ingest")
async def rag_ingest(file: UploadFile = File(...), chunk_size: int | None = Form(None, alias="chunkSize"), chunk_overlap: int | None = Form(None, alias="chunkOverlap"), _token: None = Depends(verify_api_token)):
    if not embedding_enabled:
        raise HTTPException(status_code=503, detail="RAG embedding provider is not configured")
    defaults = _rag_config_defaults()
    if chunk_size is None:
        chunk_size = defaults["chunkSize"]
    if chunk_overlap is None:
        chunk_overlap = defaults["chunkOverlap"]
    content = (await file.read()).decode("utf-8", errors="replace")
    chunks = rag_chunk(content, chunk_size=chunk_size, chunk_overlap=chunk_overlap, metadata={"filename": file.filename})
    doc_ids = []
    for chunk in chunks:
        doc_id = await vector_store.add(chunk["text"], chunk["metadata"])
        doc_ids.append(doc_id)
    return {"status": "ok", "chunks": len(chunks), "docIds": doc_ids}


@app.post("/internal/v1/agent/rag/search")
async def rag_search(query: str = Form(...), top_k: int | None = Form(None, alias="topK"), min_score: float | None = Form(None, alias="minScore"), _token: None = Depends(verify_api_token)):
    if not embedding_enabled:
        raise HTTPException(status_code=503, detail="RAG embedding provider is not configured")
    defaults = _rag_config_defaults()
    if top_k is None:
        top_k = defaults["topK"]
    if min_score is None:
        min_score = defaults["minScore"]
    query_emb = await embedding_service.embed(query)
    results = await vector_store.search(query_emb, top_k=top_k, min_score=min_score)
    return {"results": results}


@app.get("/internal/v1/agent/rag/stats")
async def rag_stats(_token: None = Depends(verify_api_token)):
    return {"totalDocuments": await vector_store.count()}


@app.delete("/internal/v1/agent/rag/documents/{doc_id}")
async def rag_delete(doc_id: str, _token: None = Depends(verify_api_token)):
    ok = await vector_store.delete(doc_id)
    return {"deleted": ok}


def _content_length(content: Any) -> int:
    if isinstance(content, str):
        return len(content)
    if isinstance(content, list):
        return sum(_content_length(item) for item in content)
    if isinstance(content, dict):
        return _content_length(content.get("text") or content.get("content") or "")
    return 0


def _deserialize_messages(raw: list[dict[str, Any]]) -> list[Message]:
    result: list[Message] = []
    for item in raw:
        role = item.get("role", "human")
        if role not in ("human", "ai", "system", "tool"):
            role = "human"
        result.append(TextMessage(role=role, content=item.get("content", "")))
    return result


def _to_langchain_messages(messages: list[Message]) -> list[BaseMessage]:
    from langchain_core.messages import (
        AIMessage,
        HumanMessage,
        SystemMessage,
        ToolMessage,
    )

    result: list[BaseMessage] = []
    for msg in messages:
        if msg.role == "human":
            result.append(HumanMessage(content=msg.content))
        elif msg.role == "ai":
            result.append(AIMessage(content=msg.content))
        elif msg.role == "system":
            result.append(SystemMessage(content=msg.content))
        elif msg.role == "tool":
            result.append(ToolMessage(content=msg.content, tool_call_id=""))
    return result


@app.post("/internal/v1/agent/approval/respond")
async def approval_respond(request: Request, _token: None = Depends(verify_api_token)):
    data = await request.json()
    request_id = data.get("requestId", "")
    approved = data.get("approved", False)
    status, decision = approval_tool.resolve_approval_status(request_id, bool(approved))
    if status in {"accepted", "already_decided"}:
        return {
            "status": status,
            "requestId": request_id,
            "approved": decision,
        }
    if status == "conflict":
        raise HTTPException(status_code=409, detail=f"Approval decision conflict: {request_id}")
    if status == "expired":
        raise HTTPException(status_code=410, detail=f"Approval request expired: {request_id}")
    raise HTTPException(status_code=404, detail=f"No pending approval: {request_id}")


@app.get("/internal/v1/agent/approval/pending")
async def approval_pending(_token: None = Depends(verify_api_token)):
    return {"pending": approval_tool.get_pending()}


@app.get("/internal/v1/agent/approval/{request_id}")
async def approval_status(request_id: str, _token: None = Depends(verify_api_token)):
    status = approval_tool.get_approval_status(request_id)
    if status is None:
        raise HTTPException(status_code=404, detail=f"Approval request not found: {request_id}")
    return status


@app.post("/internal/v1/agent/mcp/reinit")
async def reinit_mcp(_token: None = Depends(verify_api_token)):
    try:
        await mcp_manager.reinitialize()
        return {
            "status": "ok",
            "toolsCount": len(mcp_manager.tools),
            "tools": [t.spec.name for t in mcp_manager.tools],
        }
    except Exception as e:
        logger.error("MCP reinit failed", exc_info=e)
        return {"status": "error", "code": "MCP_REINITIALIZE_FAILED", "requestId": str(uuid4())}


@app.get("/internal/v1/agent/registry/workers")
async def registry_list_workers(_token: None = Depends(verify_api_token)):
    if not USE_REGISTRY or worker_registry is None:
        raise HTTPException(status_code=404, detail="Registry mode is not enabled")
    workers = worker_registry.list_workers()
    return {
        "workers": [
            {
                "id": w.id,
                "name": w.name,
                "description": w.description,
                "enabled": w.enabled,
                "filePath": w.file_path,
                "errorCode": "WORKER_INITIALIZATION_FAILED" if w.error else None,
            }
            for w in workers
        ],
    }


@app.post("/internal/v1/agent/registry/workers/{worker_id}/enable")
async def registry_enable_worker(worker_id: str, _token: None = Depends(verify_api_token)):
    if not USE_REGISTRY or worker_registry is None:
        raise HTTPException(status_code=404, detail="Registry mode is not enabled")
    model = create_llm(llm_config)
    custom_tools = [approval_tool, generate_image_tool]
    ok = worker_registry.enable(worker_id, model, mcp_manager.tools, custom_tools)
    if not ok:
        raise HTTPException(status_code=404, detail=f"Worker '{worker_id}' not found")
    return {"status": "ok", "workerId": worker_id, "enabled": True}


@app.post("/internal/v1/agent/registry/workers/{worker_id}/disable")
async def registry_disable_worker(worker_id: str, _token: None = Depends(verify_api_token)):
    if not USE_REGISTRY or worker_registry is None:
        raise HTTPException(status_code=404, detail="Registry mode is not enabled")
    ok = worker_registry.disable(worker_id)
    if not ok:
        raise HTTPException(status_code=404, detail=f"Worker '{worker_id}' not found")
    return {"status": "ok", "workerId": worker_id, "enabled": False}


@app.get("/internal/v1/agent/health")
async def health():
    llm_status = get_llm_initialization_status()
    return {
        "status": _agent_status,
        "liveness": "up" if _agent_status != "starting" else "starting",
        "instanceId": _instance_id,
        "llmReady": _llm_ready,
        "configRevision": _runtime_config_revision,
        "configSync": config_client.last_sync_report,
        "llm": llm_status,
        "cpUrl": CP_URL,
        "mcpInitialized": mcp_manager.initialized,
        "toolsCount": len(mcp_manager.tools),
        "tools": [t.spec.name for t in mcp_manager.tools],
        "version": "0.1.0",
        "framework": "langgraph",
    }


@app.get("/internal/v1/agent/tools")
async def list_tools(_token: None = Depends(verify_api_token)):
    return {
        "tools": [
            {"name": t.spec.name, "description": t.spec.description}
            for t in mcp_manager.tools
        ],
        "customTools": [
            {"name": approval_tool.name, "description": approval_tool.description}
        ],
    }


if __name__ == "__main__":
    load_project_env()

    import uvicorn

    logger.info(
        "Starting xihe Agent on %s:%s provider=%s cp=%s",
        AGENT_HOST,
        AGENT_PORT,
        llm_config.provider,
        CP_URL,
    )
    uvicorn.run(
        "xihe_agent.main:app",
        host=AGENT_HOST,
        port=AGENT_PORT,
        log_level=AGENT_LOG_LEVEL.lower(),
        reload=False,
    )
