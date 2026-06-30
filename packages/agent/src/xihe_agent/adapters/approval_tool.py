import asyncio
from typing import Any
from uuid import uuid4

from langchain_core.tools import BaseTool
from loguru import logger
from pydantic import BaseModel, Field


class ApprovalInput(BaseModel):
    action: str = Field(description="Description of the action requiring approval")
    details: str | None = Field(default=None, description="Additional details")


class ApprovalTool(BaseTool):
    name: str = "request_approval"
    description: str = "Request human approval before executing a sensitive operation"
    args_schema: type[BaseModel] = ApprovalInput

    pending_requests: dict[str, asyncio.Event] = {}
    pending_payloads: dict[str, dict[str, Any]] = {}
    approval_results: dict[str, bool] = {}

    def _run(self, action: str, details: str | None = None) -> str:
        raise NotImplementedError("Use async run")

    async def _arun(self, action: str, details: str | None = None) -> str:
        request_id = str(uuid4())
        event = asyncio.Event()
        self.pending_requests[request_id] = event
        self.pending_payloads[request_id] = {
            "action": action,
            "details": details or "",
            "request_id": request_id,
        }

        logger.info("Approval requested: id=%s action=%s", request_id, action)

        await event.wait()

        result = self.approval_results.pop(request_id, False)
        self.pending_requests.pop(request_id, None)
        self.pending_payloads.pop(request_id, None)

        if result:
            return f"Approved: {action}"
        return f"Rejected: {action}"

    def resolve_approval(self, request_id: str, approved: bool) -> bool:
        if request_id not in self.pending_requests:
            return False
        self.approval_results[request_id] = approved
        self.pending_requests[request_id].set()
        return True

    def get_pending(self) -> list[dict[str, Any]]:
        return list(self.pending_payloads.values())
