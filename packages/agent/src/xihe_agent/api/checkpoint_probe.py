"""E2E-only internal route for validating the CP-backed saver contract."""

from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from loguru import logger
from pydantic import BaseModel, Field

from xihe_agent.agent_runner.checkpoint_probe import run_checkpoint_saver_probe
from xihe_agent.agent_runner.checkpoint_saver import CheckpointStoreError
from xihe_agent.api.shared import verify_api_token

router = APIRouter()


class CheckpointProbeRequest(BaseModel):
    operation: Literal["round-trip", "recover"] = "round-trip"
    session_id: UUID = Field(alias="sessionId")
    user_id: UUID = Field(alias="userId")
    workspace_id: UUID = Field(alias="workspaceId")
    thread_id: str | None = Field(default=None, alias="threadId")
    checkpoint_id: str | None = Field(default=None, alias="checkpointId")
    probe_id: UUID | None = Field(default=None, alias="probeId")


@router.post("/internal/v1/agent/checkpoint-probe", dependencies=[Depends(verify_api_token)])
async def checkpoint_probe(request: CheckpointProbeRequest) -> dict:
    try:
        if request.operation == "recover" and any(
            value is None for value in (request.checkpoint_id, request.thread_id, request.probe_id)
        ):
            raise HTTPException(status_code=400, detail="Checkpoint recovery scope is invalid")
        if request.operation == "round-trip" and any(
            value is not None for value in (request.thread_id, request.checkpoint_id, request.probe_id)
        ):
            raise HTTPException(status_code=400, detail="Checkpoint probe scope is invalid")
        return await run_checkpoint_saver_probe(
            session_id=request.session_id,
            user_id=request.user_id,
            workspace_id=request.workspace_id,
            thread_id=request.thread_id,
            checkpoint_id=request.checkpoint_id,
            probe_id=request.probe_id,
        )
    except HTTPException:
        raise
    except Exception as exc:
        # Transport errors may carry request/response details, so their text stays hidden.
        # Our own bounded checkpoint validation errors carry only node/channel names and are
        # needed to diagnose a failed probe round trip (PLAN-0510 收尾）。
        if isinstance(exc, CheckpointStoreError):
            logger.error(
                "checkpoint saver probe failed failureType={} detail={}",
                type(exc).__name__,
                str(exc),
            )
        else:
            logger.error("checkpoint saver probe failed failureType={}", type(exc).__name__)
        raise HTTPException(status_code=503, detail="Checkpoint saver probe failed") from None
