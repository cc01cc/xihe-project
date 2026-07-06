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

from fastapi import Depends, FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import StreamingResponse
from langchain_core.messages import BaseMessage
from litellm import get_llm_provider
from loguru import logger

from xihe_agent.adapters.approval_tool import ApprovalAgentTool, ApprovalTool
from xihe_agent.adapters.mcp_client import MCPAgentTool, MCPClientManager
from xihe_agent.adapters.sse_adapter import render_sse
from xihe_agent.agent_runner import LangGraphRunner
from xihe_agent.config_client import ConfigClient
from xihe_agent.context import (
    CPContextServiceClient,
    CPEventStoreClient,
    EventSourcedContextProvider,
)
from xihe_agent.dotenv_loader import load_project_env
from xihe_agent.interfaces.agent_runner import RunnerConfig
from xihe_agent.interfaces.message import Message
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

logger.remove(0)  # Remove default stderr handler
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
        pass  # CP unreachable at startup, keep current level


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
            pass  # Poll failure, keep current level
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
MCP_URL = f"{CP_URL}/mcp"
AGENT_HOST = get_env("XIHE_AGENT_HOST") or "0.0.0.0"
AGENT_PORT = get_int_env("XIHE_AGENT_PORT", 12632)
MCP_RETRY_INTERVAL = 2.0
CP_API_TOKEN = get_env("XIHE_CP_API_TOKEN") or "dev-token-not-secure"


def verify_api_token(request: Request) -> None:
    token = request.headers.get("X-Api-Token")
    if token != CP_API_TOKEN:
        logger.warning("Agent API token mismatch")
        raise HTTPException(status_code=403, detail="Forbidden: invalid API token")

mcp_manager = MCPClientManager(
    cp_url=MCP_URL,
    server_name="cp",
    workspace_id=get_env("XIHE_WORKSPACE_ID"),
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
agent_runner = LangGraphRunner(model_factory=lambda model: create_llm(llm_config.with_model(model)), event_store=cp_event_store_client)

# RAG
PG_DSN = (
    config_client.get("infrastructure", "pgDsn")
    or config_client.get("workspace-config", "pgDsn")
    or "postgresql+psycopg://xihe:xihe123@postgres:5432/xihe"
)
embedding_model = config_client.get("embedding", "model")
_embedding_api_key: str | None = None
_embedding_api_base: str | None = None
if embedding_model:
    try:
        _, provider, _, api_base = get_llm_provider(embedding_model)
        provider_cfg = config_client.get_providers().get(provider, {})
        _embedding_api_key = provider_cfg.get("apiKey")
        _embedding_api_base = api_base
    except Exception as e:
        logger.warning("Failed to resolve embedding provider: {}", e)
embedding_service = EmbeddingService(
    model=embedding_model,
    api_key=_embedding_api_key,
    api_base=_embedding_api_base,
)
embedding_adapter = LiteLLMEmbeddings(service=embedding_service)
_dim = config_client.get("embedding", "dimensions")
vector_store = VectorStore(
    dsn=PG_DSN, embedding_service=embedding_adapter,
    vector_size=int(_dim) if _dim else None,
)

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

    logger.info(
        "Starting xihe Agent (provider={}, model={}, cp={}, supervisor={}, registry={})",
        llm_config.provider,
        llm_config.model,
        CP_URL,
        USE_SUPERVISOR,
        USE_REGISTRY,
    )

    # Override log level from CP ConfigService at startup
    await _apply_cp_log_level()

    # Start background poll for log level changes
    poll_task = asyncio.create_task(_poll_log_level())

    # Sync CP config and re-initialize after sync
    await config_client.sync_with_retry()
    llm_config = LLMConfig.from_config_client(config_client)
    image_provider_manager = ProviderManager.from_config_client(config_client)
    generate_image_tool = GenerateImageAgentTool(provider_manager=image_provider_manager)
    if cc_instructions := config_client.get("logging", "instructions"):
        AGENT_INSTRUCTIONS = cc_instructions
    if cc_user_name := config_client.get("logging", "userName"):
        AGENT_USER_NAME = cc_user_name
    USE_SUPERVISOR = config_client.get_bool("logging", "useSupervisor")
    USE_REGISTRY = config_client.get_bool("logging", "useRegistry")
    logger.info("Re-initialized from CP config after sync")
    mcp_retry_task: asyncio.Task[None] | None = None
    try:
        await mcp_manager.initialize()
        logger.info("MCP initialized successfully on startup")
    except Exception as e:
        logger.warning("MCP init failed (CP may be offline): {}", e)
        logger.info("Agent will retry MCP init in the background")
        mcp_retry_task = asyncio.create_task(mcp_manager.ensure_ready())

    if USE_REGISTRY:
        from xihe_agent.registry.watcher import start_watcher

        model = create_llm(llm_config)
        custom_tools = [legacy_approval_tool, legacy_generate_image_tool]
        _workers_dir = config_client.get("logging", "workersDir")
        worker_registry = WorkerRegistry(workers_dir=_workers_dir)
        worker_registry.load_all(model, mcp_manager.tools, custom_tools)
        _watcher_observer, _watcher_event_handler = start_watcher(
            worker_registry, model, mcp_manager.tools, custom_tools,
        )
        logger.info("Worker registry initialized with {} worker(s)", len(worker_registry.list_workers()))

    yield

    if _watcher_observer is not None:
        _watcher_observer.stop()
        _watcher_observer.join()
    if mcp_retry_task is not None:
        mcp_retry_task.cancel()
        with suppress(asyncio.CancelledError):
            await mcp_retry_task
    if poll_task is not None:
        poll_task.cancel()
        with suppress(asyncio.CancelledError):
            await poll_task


app = FastAPI(title="xihe-agent", version="0.1.0", lifespan=lifespan)
app.include_router(models_router)


@app.post("/chat")
async def chat(request: Request, _token: None = Depends(verify_api_token)):
    data = await request.json()
    content: str = data.get("content", "")
    session_id: str = data.get("session_id", "default")
    user_name: str = data.get("user_name", AGENT_USER_NAME)
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
            if USE_SUPERVISOR:
                # Supervisor path remains on legacy tools until full migration.
                from langchain_core.messages import HumanMessage

                from xihe_agent.agent.supervisor import build_supervisor

                custom_tools = [legacy_approval_tool, legacy_generate_image_tool]
                supervisor = build_supervisor(
                    model, mcp_manager.tools, custom_tools,
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

                all_tools = [MCPAgentTool(t) for t in mcp_manager.tools]
                all_tools.extend([approval_tool, generate_image_tool])

                messages = list(chat_history)
                messages.append(Message(role="human", content=content))

                config = RunnerConfig(
                    model=model_override or llm_config.model,
                    system_prompt=instructions,
                    tools=all_tools,
                    context=context,
                )

                async for event in agent_runner.stream(messages, config):
                    yield render_sse(event.type, event.data)
        except Exception as e:
            logger.exception("Agent streaming error")
            yield render_sse("error", {"error": str(e)})

    return StreamingResponse(event_stream(), media_type="text/event-stream")


@app.post("/rag/ingest")
async def rag_ingest(file: UploadFile = File(...), chunk_size: int = Form(1000), chunk_overlap: int = Form(200), _token: None = Depends(verify_api_token)):
    content = (await file.read()).decode("utf-8", errors="replace")
    chunks = rag_chunk(content, chunk_size=chunk_size, chunk_overlap=chunk_overlap, metadata={"filename": file.filename})
    doc_ids = []
    for chunk in chunks:
        doc_id = await vector_store.add(chunk["text"], chunk["metadata"])
        doc_ids.append(doc_id)
    return {"status": "ok", "chunks": len(chunks), "doc_ids": doc_ids}


@app.post("/rag/search")
async def rag_search(query: str = Form(...), top_k: int = Form(5), min_score: float = Form(0.0), _token: None = Depends(verify_api_token)):
    query_emb = await embedding_service.embed(query)
    results = await vector_store.search(query_emb, top_k=top_k, min_score=min_score)
    return {"results": results}


@app.get("/rag/stats")
async def rag_stats(_token: None = Depends(verify_api_token)):
    return {"total_documents": await vector_store.count()}


@app.delete("/rag/documents/{doc_id}")
async def rag_delete(doc_id: str, _token: None = Depends(verify_api_token)):
    ok = await vector_store.delete(doc_id)
    return {"deleted": ok}


def _deserialize_messages(raw: list[dict[str, Any]]) -> list[Message]:
    result: list[Message] = []
    for item in raw:
        role = item.get("role", "human")
        if role not in ("human", "ai", "system", "tool"):
            role = "human"
        result.append(Message(role=role, content=item.get("content", "")))
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


@app.post("/approval/respond")
async def approval_respond(request: Request, _token: None = Depends(verify_api_token)):
    data = await request.json()
    request_id = data.get("request_id", "")
    approved = data.get("approved", False)
    success = approval_tool.resolve_approval(request_id, bool(approved))
    if success:
        return {"status": "ok"}
    return {"status": "not_found", "error": f"No pending approval: {request_id}"}


@app.get("/approval/pending")
async def approval_pending(_token: None = Depends(verify_api_token)):
    return {"pending": approval_tool.get_pending()}


@app.post("/mcp/reinit")
async def reinit_mcp(_token: None = Depends(verify_api_token)):
    try:
        await mcp_manager.reinitialize()
        return {
            "status": "ok",
            "tools_count": len(mcp_manager.tools),
            "tools": [t.name for t in mcp_manager.tools],
        }
    except Exception as e:
        logger.error("MCP reinit failed", exc_info=e)
        return {"status": "error", "error": str(e)}


@app.get("/registry/workers")
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
                "file_path": w.file_path,
                "error": w.error,
            }
            for w in workers
        ],
    }


@app.post("/registry/workers/{worker_id}/enable")
async def registry_enable_worker(worker_id: str, _token: None = Depends(verify_api_token)):
    if not USE_REGISTRY or worker_registry is None:
        raise HTTPException(status_code=404, detail="Registry mode is not enabled")
    model = create_llm(llm_config)
    custom_tools = [legacy_approval_tool, legacy_generate_image_tool]
    ok = worker_registry.enable(worker_id, model, mcp_manager.tools, custom_tools)
    if not ok:
        raise HTTPException(status_code=404, detail=f"Worker '{worker_id}' not found")
    return {"status": "ok", "worker_id": worker_id, "enabled": True}


@app.post("/registry/workers/{worker_id}/disable")
async def registry_disable_worker(worker_id: str, _token: None = Depends(verify_api_token)):
    if not USE_REGISTRY or worker_registry is None:
        raise HTTPException(status_code=404, detail="Registry mode is not enabled")
    ok = worker_registry.disable(worker_id)
    if not ok:
        raise HTTPException(status_code=404, detail=f"Worker '{worker_id}' not found")
    return {"status": "ok", "worker_id": worker_id, "enabled": False}


@app.get("/health")
async def health():
    llm_status = get_llm_initialization_status()
    return {
        "status": "ok" if mcp_manager.initialized else "degraded",
        "llm": llm_status,
        "cp_url": CP_URL,
        "mcp_initialized": mcp_manager.initialized,
        "tools_count": len(mcp_manager.tools),
        "tools": [t.name for t in mcp_manager.tools],
        "version": "0.1.0",
        "framework": "langgraph",
    }


@app.get("/tools")
async def list_tools(_token: None = Depends(verify_api_token)):
    return {
        "tools": [
            {"name": t.name, "description": t.description}
            for t in mcp_manager.tools
        ],
        "custom_tools": [
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
