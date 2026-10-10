"""Approval respond/pending/status routes.

Moved verbatim from `main.py` (PLAN-0473 T2.2); status codes (409/410/404)
and payload shapes unchanged.
"""

from fastapi import APIRouter, Depends, HTTPException, Request

from xihe_agent.api.shared import verify_api_token
from xihe_agent.app_state import approval_tool

router = APIRouter()


@router.post("/internal/v1/agent/approval/respond", dependencies=[Depends(verify_api_token)])
async def approval_respond(request: Request):
    data = await request.json()
    request_id = data.get("requestId", "")
    approved = data.get("approved", False)
    # PLAN-0328 M1 (decision #23): optional rejection feedback forwarded to the blocked tool.
    raw_feedback = data.get("feedback")
    feedback = raw_feedback if isinstance(raw_feedback, str) and raw_feedback else None
    status, decision = approval_tool.resolve_approval_status(request_id, bool(approved), feedback)
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


@router.get("/internal/v1/agent/approval/pending", dependencies=[Depends(verify_api_token)])
async def approval_pending():
    return {"pending": approval_tool.get_pending()}


@router.get("/internal/v1/agent/approval/{request_id}", dependencies=[Depends(verify_api_token)])
async def approval_status(request_id: str):
    status = approval_tool.get_approval_status(request_id)
    if status is None:
        raise HTTPException(status_code=404, detail=f"Approval request not found: {request_id}")
    return status
