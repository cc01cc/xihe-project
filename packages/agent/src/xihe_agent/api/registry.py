"""Worker registry list/enable/disable routes.

Moved verbatim from `main.py` (PLAN-0473 T2.2); 404 gating on registry mode
and payload shapes unchanged.

PLAN-0590 (spec §6): `useRegistry` is no longer read through an import-time
binding, so a hot config swap is visible to these routes. The registry routes
carry no run identity by default (they are process capability gates), but a
caller that passes `workspaceId`/`userId` gets the request-scoped value from the
run-config snapshot instead of the process default.
"""

from fastapi import APIRouter, Depends, HTTPException, Query
from loguru import logger

from xihe_agent import app_state
from xihe_agent.api.shared import verify_api_token
from xihe_agent.llm.base import create_llm

router = APIRouter()


async def _registry_enabled(workspace_id: str | None, user_id: str | None) -> bool:
    """Resolve the registry capability gate for this caller."""
    if app_state.worker_registry is None:
        return False
    if not workspace_id and not user_id:
        return app_state.USE_REGISTRY
    try:
        snapshot = await app_state.run_config_resolver.resolve(workspace_id, user_id)
    except Exception as exc:  # noqa: BLE001 — capability gate must stay fail-safe
        logger.warning(
            "[LIFECYCLE] service=agent event=registry_snapshot_unavailable workspaceId={} userId={} errorType={}",
            workspace_id or "none",
            user_id or "none",
            type(exc).__name__,
        )
        return app_state.USE_REGISTRY
    return snapshot.get_bool("agent-runtime", "useRegistry")


@router.get("/internal/v1/agent/registry/workers", dependencies=[Depends(verify_api_token)])
async def registry_list_workers(
    workspace_id: str | None = Query(default=None, alias="workspaceId"),
    user_id: str | None = Query(default=None, alias="userId"),
):
    if not await _registry_enabled(workspace_id, user_id):
        raise HTTPException(status_code=404, detail="Registry mode is not enabled")
    registry = app_state.worker_registry
    if registry is None:
        raise HTTPException(status_code=404, detail="Registry mode is not enabled")
    workers = registry.list_workers()
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


@router.post("/internal/v1/agent/registry/workers/{worker_id}/enable", dependencies=[Depends(verify_api_token)])
async def registry_enable_worker(
    worker_id: str,
    workspace_id: str | None = Query(default=None, alias="workspaceId"),
    user_id: str | None = Query(default=None, alias="userId"),
):
    if not await _registry_enabled(workspace_id, user_id):
        raise HTTPException(status_code=404, detail="Registry mode is not enabled")
    registry = app_state.worker_registry
    if registry is None:
        raise HTTPException(status_code=404, detail="Registry mode is not enabled")
    model = create_llm(app_state.llm_config)
    custom_tools = [app_state.approval_tool, app_state.generate_image_tool]
    # PLAN-0588 decision #16: a worker is a process-level unit with no workspace
    # identity, so it no longer inherits the (first) MCP shard's tool face.
    ok = registry.enable(worker_id, model, [], custom_tools)
    if not ok:
        raise HTTPException(status_code=404, detail=f"Worker '{worker_id}' not found")
    return {"status": "ok", "workerId": worker_id, "enabled": True}


@router.post("/internal/v1/agent/registry/workers/{worker_id}/disable", dependencies=[Depends(verify_api_token)])
async def registry_disable_worker(
    worker_id: str,
    workspace_id: str | None = Query(default=None, alias="workspaceId"),
    user_id: str | None = Query(default=None, alias="userId"),
):
    if not await _registry_enabled(workspace_id, user_id):
        raise HTTPException(status_code=404, detail="Registry mode is not enabled")
    registry = app_state.worker_registry
    if registry is None:
        raise HTTPException(status_code=404, detail="Registry mode is not enabled")
    ok = registry.disable(worker_id)
    if not ok:
        raise HTTPException(status_code=404, detail=f"Worker '{worker_id}' not found")
    return {"status": "ok", "workerId": worker_id, "enabled": False}
