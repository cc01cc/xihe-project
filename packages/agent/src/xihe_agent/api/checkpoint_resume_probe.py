"""Exact Host E2E controls for real-process continuation interruption tests."""

from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict

from xihe_agent.agent_runner import checkpoint_resume_failpoint
from xihe_agent.api.shared import verify_api_token

router = APIRouter()


class FailpointRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    action: Literal["arm", "release"]
    stage: Literal["before_tool_dispatch", "after_tool_dispatch"] | None = None


@router.get(
    "/internal/v1/agent/checkpoint-resume-probe",
    dependencies=[Depends(verify_api_token)],
)
async def failpoint_status() -> dict[str, object]:
    return await checkpoint_resume_failpoint.status()


@router.post(
    "/internal/v1/agent/checkpoint-resume-probe",
    dependencies=[Depends(verify_api_token)],
)
async def control_failpoint(request: FailpointRequest) -> dict[str, object]:
    try:
        if request.action == "arm":
            if request.stage is None:
                raise HTTPException(status_code=400, detail="Failpoint stage is required")
            await checkpoint_resume_failpoint.arm(request.stage)
        elif request.stage is not None:
            raise HTTPException(status_code=400, detail="Release does not accept a stage")
        else:
            await checkpoint_resume_failpoint.release()
        return await checkpoint_resume_failpoint.status()
    except HTTPException:
        raise
    except RuntimeError:
        raise HTTPException(status_code=409, detail="Checkpoint resume failpoint is unavailable") from None
