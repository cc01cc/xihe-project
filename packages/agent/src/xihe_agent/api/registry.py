"""Worker registry list/enable/disable routes.

Moved verbatim from `main.py` (PLAN-0473 T2.2); 404 gating on registry mode
and payload shapes unchanged.
"""

from fastapi import APIRouter, Depends, HTTPException

from xihe_agent.api.shared import verify_api_token
from xihe_agent.app_state import (
    USE_REGISTRY,
    approval_tool,
    generate_image_tool,
    llm_config,
    mcp_manager,
    worker_registry,
)
from xihe_agent.llm.base import create_llm

router = APIRouter()


@router.get("/internal/v1/agent/registry/workers", dependencies=[Depends(verify_api_token)])
async def registry_list_workers():
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


@router.post("/internal/v1/agent/registry/workers/{worker_id}/enable", dependencies=[Depends(verify_api_token)])
async def registry_enable_worker(worker_id: str):
    if not USE_REGISTRY or worker_registry is None:
        raise HTTPException(status_code=404, detail="Registry mode is not enabled")
    model = create_llm(llm_config)
    custom_tools = [approval_tool, generate_image_tool]
    ok = worker_registry.enable(worker_id, model, mcp_manager.tools, custom_tools)
    if not ok:
        raise HTTPException(status_code=404, detail=f"Worker '{worker_id}' not found")
    return {"status": "ok", "workerId": worker_id, "enabled": True}


@router.post("/internal/v1/agent/registry/workers/{worker_id}/disable", dependencies=[Depends(verify_api_token)])
async def registry_disable_worker(worker_id: str):
    if not USE_REGISTRY or worker_registry is None:
        raise HTTPException(status_code=404, detail="Registry mode is not enabled")
    ok = worker_registry.disable(worker_id)
    if not ok:
        raise HTTPException(status_code=404, detail=f"Worker '{worker_id}' not found")
    return {"status": "ok", "workerId": worker_id, "enabled": False}
