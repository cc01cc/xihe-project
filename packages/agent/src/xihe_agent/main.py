"""
xihe-agent: FastAPI app composition root.

PLAN-0473 M1 (spec/agent-module-boundaries.md): HTTP routes and request
schemas live in `xihe_agent.api.*` (grouped by domain); process-wide runtime
singletons, env constants, and shared helpers live in `xihe_agent.app_state`.
This module keeps only: logging setup, config refresh orchestration, app
lifespan, middleware/exception handlers, and router registration.
"""

import asyncio
import logging
import os
import sys
from contextlib import asynccontextmanager, suppress
from typing import Any
from uuid import uuid4

import litellm
from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from loguru import logger

from xihe_agent.app_state import (
    AGENT_HOST,
    AGENT_PORT,
    CP_URL,
    SyncReport,
    _derive_llm_ready,
    _parse_recover_session_ids,
    _resolve_policy_for_model,
    _runtime_refresh_lock,
    config_client,
    crash_recovery,
)
from xihe_agent.dotenv_loader import load_project_env, parse_cli_overrides
from xihe_agent.llm.base import LLMConfig, create_llm
from xihe_agent.llm.models import fetch_model_catalog
from xihe_agent.llm.token_counter import TokenCounter
from xihe_agent.registry.registry import WorkerRegistry
from xihe_agent.security_defaults import enforce_security_defaults
from xihe_agent.tools import GenerateImageAgentTool, ProviderManager


def get_env(name: str) -> str | None:  # re-exported for compatibility
    from xihe_agent.app_state import get_env as _get_env

    return _get_env(name)


# Suppress litellm verbose debugging that prints Authorization headers and
# full request payloads. The redaction boundary already masks Bearer/JWT, but
# disabling verbose output at the source keeps credentials out of logs.
litellm.suppress_debug_info = True  # type: ignore[attr-defined]
with suppress(Exception):
    litellm.set_verbose = False  # type: ignore[attr-defined]




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


AGENT_LOG_LEVEL = normalize_agent_log_level(get_log_level_env("XIHE_LOG_LEVEL_AGENT", "XIHE_LOG_LEVEL", default="info"))

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
_APPLIED_LOG_LEVEL = AGENT_LOG_LEVEL


def _configure_log_level(level_name: str) -> None:
    global _APPLIED_LOG_LEVEL
    level = normalize_agent_log_level(level_name)
    if level == _APPLIED_LOG_LEVEL:
        return  # PLAN-0307 T2.15: idempotent so the periodic reload is cheap
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
    _APPLIED_LOG_LEVEL = level


async def _apply_cp_log_level() -> None:
    try:
        level = config_client.get("logging", "levelAgent")
        if level:
            _configure_log_level(level)
    except Exception:
        logger.warning("CP log level unavailable, keeping current level", exc_info=True)


# app_state helpers imported under a distinct alias to keep the logging
# functions' call graph explicit (main owns log-level wiring; app_state owns
# the shared helpers).


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









async def reload_runtime_config(reason: str) -> SyncReport:
    """Refresh config-derived dependencies and swap their runtime snapshot atomically."""
    import xihe_agent.app_state as state

    async with _runtime_refresh_lock:
        report = await config_client.sync_with_retry()
        if report.get("refreshed"):
            staged_llm_config = LLMConfig.from_config_client(config_client)
            staged_image_manager = ProviderManager.from_env(config_client.get("llm-provider", "imageProvider"))
            staged_catalog = await fetch_model_catalog(config_client)
            # PLAN-0307 T2.15 (decision #23): `logging.levelAgent` is hot-applied
            # on every refreshed snapshot; env stays the startup bootstrap only.
            await _apply_cp_log_level()
        else:
            staged_llm_config = state.llm_config
            staged_image_manager = state.image_provider_manager
            staged_catalog = state._model_catalog

        staged_ready, staged_verified_at = _derive_llm_ready(
            report,
            staged_catalog,
            staged_llm_config,
        )

        state.llm_config = staged_llm_config
        state.image_provider_manager = staged_image_manager
        state.generate_image_tool = GenerateImageAgentTool(provider_manager=staged_image_manager)
        state._model_catalog = staged_catalog
        state._llm_ready = staged_ready
        state._llm_verified_at = staged_verified_at
        state._runtime_config_revision = config_client.config_revision
        state._refresh_embedding_config()

        if cc_instructions := config_client.get("agent-runtime", "instructions"):
            state.AGENT_INSTRUCTIONS = cc_instructions
        if cc_user_name := config_client.get("agent-profile", "userName"):
            state.AGENT_USER_NAME = cc_user_name
        state.USE_SUPERVISOR = config_client.get_bool("agent-runtime", "useSupervisor")
        state.USE_REGISTRY = config_client.get_bool("agent-runtime", "useRegistry")
        state._agent_status = "ok" if staged_ready == "ready" else "degraded"
        # PLAN-0341 T1.6: rebuild TokenCounter when tokenizerRef is configured.
        try:
            default_model = staged_llm_config.model if staged_llm_config else None
            policy = _resolve_policy_for_model(default_model)
            if policy.tokenizer_ref:
                state._token_counter = TokenCounter(tokenizer_ref=policy.tokenizer_ref, model=default_model)
                logger.info(
                    "[LIFECYCLE] service=agent event=tokenizer_ref_applied ref={} model={}",
                    policy.tokenizer_ref,
                    default_model,
                )
        except Exception as e:
            logger.warning("Failed to apply tokenizerRef from context-policy: {}", e)

        logger.info(
            "[LIFECYCLE] service=agent event=runtime_config_swapped reason={} revision={} llmReady={} provider={} model={} verifiedAt={}",
            reason,
            state._runtime_config_revision,
            state._llm_ready,
            state.llm_config.provider,
            state.llm_config.model,
            state._llm_verified_at or "none",
        )
        return report




@asynccontextmanager
async def lifespan(app: FastAPI):
    import xihe_agent.app_state as state

    logger.info(
        "[LIFECYCLE] service=agent event=startup_begin provider={} model={} cp_url={}",
        state.llm_config.provider,
        state.llm_config.model,
        CP_URL,
    )

    # Config sync, provider preflight, and readiness form one atomic startup path.
    try:
        await reload_runtime_config(reason="startup")
    except Exception as e:
        state._agent_status = "degraded"
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
        state._agent_status,
        state._llm_ready,
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

    if state.USE_REGISTRY:
        from xihe_agent.registry.watcher import start_watcher

        model = create_llm(state.llm_config)
        custom_tools = [state.approval_tool, state.generate_image_tool]
        # Registry startup must not initialize MCP. Workspace/tool requests
        # discover tools lazily in the request-scoped workspace path.
        mcp_tools: list[Any] = []
        _workers_dir = config_client.get("agent-runtime", "workersDir")
        registry = WorkerRegistry(workers_dir=_workers_dir)
        registry.load_all(model, mcp_tools, custom_tools)
        state.worker_registry = registry
        state._watcher_observer, state._watcher_event_handler = start_watcher(
            registry,
            model,
            mcp_tools,
            custom_tools,
        )
        logger.info("Worker registry initialized with {} worker(s)", len(registry.list_workers()))

    yield

    logger.info("[LIFECYCLE] service=agent event=shutdown reason=lifespan_exit")
    if state._watcher_observer is not None:
        state._watcher_observer.stop()
        state._watcher_observer.join()
    if poll_task is not None:
        poll_task.cancel()
        with suppress(asyncio.CancelledError):
            await poll_task


app = FastAPI(title="xihe-agent", version="0.1.0", lifespan=lifespan)

from xihe_agent.api.approval import router as approval_router  # noqa: E402
from xihe_agent.api.chat import router as chat_router  # noqa: E402
from xihe_agent.api.misc import router as misc_router  # noqa: E402
from xihe_agent.api.rag import router as rag_router  # noqa: E402
from xihe_agent.api.registry import router as registry_router  # noqa: E402
from xihe_agent.llm.models import router as models_router  # noqa: E402

app.include_router(models_router)
app.include_router(chat_router)
app.include_router(misc_router)
app.include_router(rag_router)
app.include_router(approval_router)
app.include_router(registry_router)


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


if __name__ == "__main__":
    # PLAN-0307 T3.5: CLI --set is the highest-priority config layer.
    load_project_env(parse_cli_overrides(sys.argv[1:]))
    # PLAN-0307 T3.4: reject dangerous factory defaults in prod (WARN in dev/test).
    enforce_security_defaults()

    import uvicorn

    import xihe_agent.app_state as state

    logger.info(
        "Starting xihe Agent on %s:%s provider=%s cp=%s",
        AGENT_HOST,
        AGENT_PORT,
        state.llm_config.provider,
        CP_URL,
    )
    uvicorn.run(
        "xihe_agent.main:app",
        host=AGENT_HOST,
        port=AGENT_PORT,
        log_level=AGENT_LOG_LEVEL.lower(),
        reload=False,
    )
