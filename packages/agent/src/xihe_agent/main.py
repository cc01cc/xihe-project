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
from typing import Any
from uuid import uuid4

from fastapi import Depends, FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, StreamingResponse
from langchain_core.messages import BaseMessage
from litellm import get_llm_provider
from loguru import logger

from xihe_agent.adapters.approval_tool import ApprovalAgentTool, ApprovalTool
from xihe_agent.adapters.mcp_client import MCPClientManager
from xihe_agent.adapters.sse_adapter import render_sse
from xihe_agent.agent_runner import LangGraphRunner
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
from xihe_agent.llm.base import LLMConfig, create_llm
from xihe_agent.llm.models import _models_router
from xihe_agent.llm.models import router as models_router
from xihe_agent.rag import EmbeddingService, LiteLLMEmbeddings, VectorStore
from xihe_agent.rag import chunk_document as rag_chunk
from xihe_agent.registry.registry import WorkerRegistry
from xihe_agent.tools import GenerateImageAgentTool, GenerateImageTool, ProviderManager


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
async def _apply_cp_log_level():
    try:
        config_client = ConfigClient()
        level = await config_client.get("logging", "levelAgent")
        if level:
            level = normalize_agent_log_level(level)
            logger.remove()  # Remove all handlers
            _log_dir = get_env("XIHE_LOG_DIR") or "logs"
            logger.add(sys.stderr, level=level.upper())
            logger.add(
                os.path.join(_log_dir, "agent.log"),
                rotation="100 MB", retention=7,
                level=level.upper(), serialize=True,
            )
    except Exception:
        logger.warning("CP unreachable at startup, keeping current log level", exc_info=True)


async def _poll_log_level():
    while True:
        try:
            config_client = ConfigClient()
            level = await config_client.get("logging", "levelAgent")
            if level:
                level = normalize_agent_log_level(level)
                logger.remove()  # Remove all handlers
                _log_dir = get_env("XIHE_LOG_DIR") or "logs"
                logger.add(sys.stderr, level=level.upper())
                logger.add(
                    os.path.join(_log_dir, "agent.log"),
                    rotation="100 MB", retention=7,
                    level=level.upper(), serialize=True,
                )
        except Exception:
            logger.warning("CP log-level poll failed, keeping current level", exc_info=True)
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

mcp_manager = MCPClientManager(
    cp_url=MCP_URL,
    server_name="cp",
    workspace_id=get_env("XIHE_WORKSPACE_ID"),
    api_token=CP_API_TOKEN,
    retry_interval=MCP_RETRY_INTERVAL,
)
approval_tool = ApprovalAgentTool()
legacy_approval_tool = ApprovalTool()
config_client = ConfigClient(cp_url=CP_URL, api_token=CP_API_TOKEN)
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

# RAG
PG_DSN = (
    config_client.get("infrastructure", "pgDsn")
    or config_client.get("workspace-config", "pgDsn")
    or "postgresql+psycopg://xihe:@postgres:5432/xihe"
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
    config_client.get("logging", "instructions")
    or "You are xihe Agent. Answer in Chinese by default. "
    "Use the provided tools whenever the user asks about workspace files, directories, "
    "or commands, then answer with the tool results."
)
AGENT_USER_NAME = (
    config_client.get("logging", "userName")
    or "User"
)
USE_SUPERVISOR = config_client.get_bool("logging", "useSupervisor")
USE_REGISTRY = config_client.get_bool("logging", "useRegistry")

worker_registry: WorkerRegistry | None = None
_watcher_observer: Any = None
_watcher_event_handler: Any = None
_agent_status: str = "starting"  # starting | ok | degraded


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
        return []

    try:
        await mcp_manager.initialize(workspace_id=workspace_id)
    except Exception as e:
        logger.warning(
            "[LIFECYCLE] service=agent event=mcp_request_init_failed workspaceId={} error={}",
            workspace_id,
            e,
        )
        return []
    return mcp_manager.tools


def get_llm_initialization_status() -> dict[str, Any]:
    return {
        "provider": llm_config.provider,
        "model": llm_config.model,
        "api_base": llm_config.api_base,
        "configured": bool(llm_config.api_key) or llm_config.provider == "mock",
    }


@asynccontextmanager
async def lifespan(app: FastAPI):
    global worker_registry, _watcher_observer, _watcher_event_handler
    global llm_config, image_provider_manager, generate_image_tool, AGENT_INSTRUCTIONS, AGENT_USER_NAME, USE_SUPERVISOR, USE_REGISTRY
    global _agent_status

    logger.info(
        "[LIFECYCLE] service=agent event=startup_begin provider={} model={} cp_url={}",
        llm_config.provider,
        llm_config.model,
        CP_URL,
    )

    # Override log level from CP ConfigService at startup
    await _apply_cp_log_level()

    # Start background poll for log level changes
    poll_task = asyncio.create_task(_poll_log_level())

    # Sync CP config and re-initialize after sync
    config_sync_succeeded = False
    try:
        await config_client.sync_with_retry()
        llm_config = LLMConfig.from_config_client(config_client)
        image_provider_manager = ProviderManager.from_config_client(config_client)
        generate_image_tool = GenerateImageAgentTool(provider_manager=image_provider_manager)
        _refresh_embedding_config()
        if cc_instructions := config_client.get("logging", "instructions"):
            AGENT_INSTRUCTIONS = cc_instructions
        if cc_user_name := config_client.get("logging", "userName"):
            AGENT_USER_NAME = cc_user_name
        USE_SUPERVISOR = config_client.get_bool("logging", "useSupervisor")
        USE_REGISTRY = config_client.get_bool("logging", "useRegistry")
        config_sync_succeeded = True
        logger.info("[LIFECYCLE] service=agent event=config_sync_ok provider={} model={}", llm_config.provider, llm_config.model)
    except Exception as e:
        logger.error("[LIFECYCLE] service=agent event=config_sync_failed error={}", e, exc_info=True)
        # Keep status as "starting" — health endpoint will report starting

    # MCP is request-scoped; pure chat must not trigger remote discovery at startup.
    logger.info("[LIFECYCLE] service=agent event=mcp_init_deferred reason=lazy_request")

    # Mark agent as ready only after config sync (MCP is optional).
    if config_sync_succeeded:
        _agent_status = "ok"
        logger.info("[LIFECYCLE] service=agent event=status_change from=starting to=ok reason=config_sync_complete")

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
        mcp_tools = await _get_mcp_tools(get_env("XIHE_WORKSPACE_ID"))
        _workers_dir = config_client.get("logging", "workersDir")
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


@app.post("/internal/v1/agent/chat")
async def chat(request: Request, _token: None = Depends(verify_api_token)):
    data = await request.json()
    content: str = data.get("content", "")
    session_id: str = data.get("sessionId", "default")
    workspace_id: str | None = data.get("workspaceId") or None
    user_name: str = data.get("userName", AGENT_USER_NAME)
    model_override: str | None = data.get("model")
    instructions: str = data.get("instructions", AGENT_INSTRUCTIONS)
    chat_history_raw: list[dict[str, Any]] = data.get("history", [])

    logger.info("Chat request: session={}, content={}...", session_id, content[:60])

    # Enrich with RAG context if knowledge base has content
    instructions = await _enrich_with_rag_context(content, instructions)

    chat_history = _deserialize_messages(chat_history_raw)
    cfg = llm_config.with_model(model_override) if model_override else llm_config
    model = create_llm(cfg)

    async def event_stream():
        try:
            mcp_tools = await _get_mcp_tools(workspace_id)
            if USE_SUPERVISOR:
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
                        yield render_sse("token", {"content": msg.content})
                yield render_sse("done", {})
            else:
                context = await context_provider.load(session_id, after_sequence=0)
                context.runtime_state["user_name"] = user_name
                context.runtime_state["instructions"] = instructions

                all_tools = [approval_tool, generate_image_tool]
                if mcp_tools:
                    all_tools = list(mcp_tools) + all_tools

                messages = list(chat_history)
                messages.append(TextMessage(role="human", content=content))

                config = RunnerConfig(
                    model=model_override or llm_config.model,
                    system_prompt=instructions,
                    tools=all_tools,
                    context=context,
                )

                async for event in agent_runner.stream(messages, config):
                    yield render_sse(event.type, event.data)
        except Exception:
            logger.exception("Agent streaming error")
            yield render_sse("error", {
                "code": "AGENT_STREAM_FAILED",
                "requestId": str(uuid4()),
                "detail": "Agent stream failed",
            })

    return StreamingResponse(event_stream(), media_type="text/event-stream")


@app.post("/internal/v1/agent/rag/ingest")
async def rag_ingest(file: UploadFile = File(...), chunk_size: int = Form(1000, alias="chunkSize"), chunk_overlap: int = Form(200, alias="chunkOverlap"), _token: None = Depends(verify_api_token)):
    if not embedding_enabled:
        raise HTTPException(status_code=503, detail="RAG embedding provider is not configured")
    content = (await file.read()).decode("utf-8", errors="replace")
    chunks = rag_chunk(content, chunk_size=chunk_size, chunk_overlap=chunk_overlap, metadata={"filename": file.filename})
    doc_ids = []
    for chunk in chunks:
        doc_id = await vector_store.add(chunk["text"], chunk["metadata"])
        doc_ids.append(doc_id)
    return {"status": "ok", "chunks": len(chunks), "docIds": doc_ids}


@app.post("/internal/v1/agent/rag/search")
async def rag_search(query: str = Form(...), top_k: int = Form(5, alias="topK"), min_score: float = Form(0.0, alias="minScore"), _token: None = Depends(verify_api_token)):
    if not embedding_enabled:
        raise HTTPException(status_code=503, detail="RAG embedding provider is not configured")
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
    success = approval_tool.resolve_approval(request_id, bool(approved))
    if success:
        return {"status": "ok"}
    raise HTTPException(status_code=404, detail=f"No pending approval: {request_id}")


@app.get("/internal/v1/agent/approval/pending")
async def approval_pending(_token: None = Depends(verify_api_token)):
    return {"pending": approval_tool.get_pending()}


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
