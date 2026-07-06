import asyncio
from typing import Any
from uuid import uuid4

from langchain_core.tools import BaseTool
from loguru import logger
from pydantic import BaseModel, Field

from xihe_agent.interfaces.context import AgentContext
from xihe_agent.interfaces.tool import BaseAgentTool, ToolSpec


class ApprovalInput(BaseModel):
    action: str = Field(description="Description of the action requiring approval")
    details: str | None = Field(default=None, description="Additional details")


class ApprovalAgentTool(BaseAgentTool):
    """Agent-tool implementation of the approval request tool."""

    def __init__(self) -> None:
        self.pending_requests: dict[str, asyncio.Event] = {}
        self.pending_payloads: dict[str, dict[str, Any]] = {}
        self.approval_results: dict[str, bool] = {}

    async def execute(self, input: dict[str, Any], context: AgentContext) -> dict[str, Any]:
        action = input.get("action", "")
        details = input.get("details")
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
            return {"content": f"Approved: {action}"}
        return {"content": f"Rejected: {action}"}

    @property
    def spec(self) -> ToolSpec:
        return ToolSpec(
            name="request_approval",
            description="Request human approval before executing a sensitive operation",
            input_schema={
                "type": "object",
                "properties": {
                    "action": {"type": "string", "description": "Description of the action requiring approval"},
                    "details": {"type": "string", "description": "Additional details"},
                },
                "required": ["action"],
            },
        )

    @property
    def name(self) -> str:
        return self.spec.name

    @property
    def description(self) -> str:
        return self.spec.description

    def resolve_approval(self, request_id: str, approved: bool) -> bool:
        if request_id not in self.pending_requests:
            return False
        self.approval_results[request_id] = approved
        self.pending_requests[request_id].set()
        return True

    def get_pending(self) -> list[dict[str, Any]]:
        return list(self.pending_payloads.values())


class ApprovalTool(BaseTool):
    """Legacy LangChain BaseTool implementation kept for supervisor/registry compatibility."""

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
