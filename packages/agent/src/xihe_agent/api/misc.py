"""Cancel / summarize / MCP / health / tools routes.

Moved verbatim from `main.py` (PLAN-0473 T2.2); status codes, payloads, and
log lines unchanged.
"""

from uuid import uuid4

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse
from loguru import logger

from xihe_agent.api.shared import problem_details, verify_api_token
from xihe_agent.app_state import (
    CP_URL,
    _classify_llm_exception,
    approval_tool,
    config_client,
    get_llm_initialization_status,
    mcp_manager,
    run_cancel_registry,
)
from xihe_agent.llm.base import LLMConfig
from xihe_agent.llm.summarize import summarize_with_llm

router = APIRouter()


@router.post("/internal/v1/agent/runs/{run_id}/cancel", dependencies=[Depends(verify_api_token)])
async def cancel_run(run_id: str, request: Request):
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


@router.post("/internal/v1/agent/summarize", dependencies=[Depends(verify_api_token)])
async def summarize(request: Request):
    """PLAN-0354 spec §8: one bounded semantic-summary call for CP compaction.

    The CP issues a short credential lease for this hop; the Agent redeems it
    and calls the provider once. No events, no persistence, no [Constraints]
    data: CP owns fallback, cost accounting and the SC section (I3/I4).
    """
    data = await request.json()
    request_id: str = request.headers.get("X-Request-Id") or str(uuid4())
    session_id: str = str(data.get("sessionId") or "")
    run_id: str = str(data.get("runId") or "")
    provider_override: str | None = data.get("provider") or None
    model_override: str | None = data.get("model") or None
    credential_lease: str | None = data.get("credentialLease") or None
    provider_connection_id: str | None = data.get("providerConnectionId") or None
    connection_revision = data.get("connectionRevision")
    text: str = data.get("text") or ""
    prior_summary: str | None = data.get("priorSummary") or None

    if not credential_lease:
        return problem_details(request_id, 400, "INVALID_REQUEST", "credentialLease is required")
    if not text.strip():
        return problem_details(request_id, 400, "INVALID_REQUEST", "text is required")

    try:
        grant = await config_client.redeem_provider_lease(
            {
                "lease": credential_lease,
                "runId": run_id,
                "providerConnectionId": provider_connection_id or "",
                "providerId": provider_override or "",
                "model": model_override or "",
                "connectionRevision": int(connection_revision or 0),
            }
        )
    except Exception as exc:
        logger.warning(
            "Provider credential lease unavailable for summarize sessionId={} errorType={}",
            session_id,
            type(exc).__name__,
        )
        return problem_details(
            request_id, 503, "PROVIDER_CONNECTION_UNAVAILABLE",
            "The selected provider connection is unavailable", retryable=True)

    run_llm_entries = config_client.get_domain("llm-provider")
    run_llm_config = LLMConfig.from_entries(run_llm_entries)
    request_config = LLMConfig(
        provider=str(grant.get("provider", provider_override or "")),
        route_provider=str(grant.get("routeProvider", grant.get("provider", ""))),
        api_key=str(grant.get("apiKey") or ""),
        api_base=str(grant.get("baseUrl") or ""),
        model=str(grant.get("model") or model_override or ""),
        timeout=run_llm_config.timeout,
        max_tokens=min(run_llm_config.max_tokens, 2048),
        temperature=run_llm_config.temperature,
    )
    # Late-bound through app_state so config-refresh replacement (and tests)
    # keep the pre-split `main.create_llm` semantics.
    import xihe_agent.app_state as state

    summarizer = state.create_llm(request_config)  # type: ignore[attr-defined]
    try:
        summary, usage = await summarize_with_llm(summarizer, text, prior_summary)
    except Exception as exc:
        error_code, error_detail, retryable = _classify_llm_exception(exc)
        logger.warning(
            "[LIFECYCLE] service=agent event=summarize_failed requestId={} sessionId={} errorCode={}",
            request_id,
            session_id,
            error_code,
        )
        return problem_details(request_id, 502, error_code, error_detail, retryable=retryable)

    # PLAN-0343 decision #10: pricing lookup key is provider/model.
    usage_model = request_config.model
    if usage_model and request_config.provider and "/" not in usage_model:
        usage_model = f"{request_config.provider}/{usage_model}"
    usage["model"] = usage_model
    logger.info(
        "[LIFECYCLE] service=agent event=summarize_completed requestId={} sessionId={} summaryChars={} source={}",
        request_id,
        session_id,
        len(summary),
        usage.get("source"),
    )
    return JSONResponse(content={"summary": summary, "usage": usage})


@router.post("/internal/v1/agent/mcp/reinit", dependencies=[Depends(verify_api_token)])
async def reinit_mcp():
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


@router.get("/internal/v1/agent/health")
async def health():
    llm_status = get_llm_initialization_status()
    from xihe_agent.app_state import _agent_status, _instance_id, _llm_ready, _runtime_config_revision

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


@router.get("/internal/v1/agent/tools", dependencies=[Depends(verify_api_token)])
async def list_tools():
    return {
        "tools": [{"name": t.spec.name, "description": t.spec.description} for t in mcp_manager.tools],
        "customTools": [{"name": approval_tool.name, "description": approval_tool.description}],
    }
