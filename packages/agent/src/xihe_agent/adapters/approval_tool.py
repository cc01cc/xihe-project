import asyncio
import os
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import uuid4

from langchain_core.tools import BaseTool
from loguru import logger
from pydantic import BaseModel, Field

from xihe_agent.interfaces.context import AgentContext
from xihe_agent.interfaces.tool import BaseAgentTool, ToolSpec

ApprovalEventSink = Callable[[dict[str, Any]], Awaitable[None]]
APPROVAL_EVENT_SINK_KEY = "_approval_event_sink"


class ApprovalTerminalError(RuntimeError):
    """Terminal error raised when an approval gate cannot continue a run."""

    code = "APPROVAL_FAILED"


class ApprovalRejectedError(ApprovalTerminalError):
    code = "APPROVAL_REJECTED"


class ApprovalExpiredError(ApprovalTerminalError):
    code = "APPROVAL_EXPIRED"


class ApprovalExecutorUnsupportedError(ApprovalTerminalError):
    code = "APPROVAL_EXECUTOR_UNSUPPORTED"


def _configured_timeout_seconds() -> float:
    raw = os.getenv("XIHE_APPROVAL_TIMEOUT_SECONDS", "300")
    try:
        return max(0.1, float(raw))
    except ValueError:
        logger.warning("Invalid XIHE_APPROVAL_TIMEOUT_SECONDS value: {}", raw)
        return 300.0


class ApprovalInput(BaseModel):
    action: str = Field(description="Description of the action requiring approval")
    details: str | None = Field(default=None, description="Additional details")


class ApprovalCoordinator:
    """Coordinates pending approvals and publishes run-scoped request events."""

    def __init__(self, timeout_seconds: float | None = None) -> None:
        self.timeout_seconds = timeout_seconds if timeout_seconds is not None else _configured_timeout_seconds()
        self.pending_requests: dict[str, asyncio.Event] = {}
        self.pending_payloads: dict[str, dict[str, Any]] = {}
        self.approval_results: dict[str, bool] = {}
        self.completed_payloads: dict[str, dict[str, Any]] = {}
        self.completed_statuses: dict[str, str] = {}
        self.completed_decisions: dict[str, bool | None] = {}
        self.completed_at: dict[str, datetime] = {}

    async def request(
        self,
        action: str,
        details: str | None,
        context: AgentContext,
        event_sink: ApprovalEventSink | None,
    ) -> dict[str, Any]:
        request_id = str(uuid4())
        event = asyncio.Event()
        metadata = context.metadata
        now = datetime.now(UTC)
        payload = {
            "requestId": request_id,
            "runId": str(metadata.get("runId", "")),
            "sessionId": str(metadata.get("sessionId", context.aggregate_id)),
            "workspaceId": str(metadata.get("workspaceId", "")),
            "tool": "request_approval",
            "action": action,
            "details": details or "",
            "expiresAt": (now + timedelta(seconds=self.timeout_seconds)).isoformat().replace("+00:00", "Z"),
        }
        self.pending_requests[request_id] = event
        self.pending_payloads[request_id] = payload

        if event_sink is None:
            self.pending_requests.pop(request_id, None)
            self.pending_payloads.pop(request_id, None)
            logger.error("Approval event sink is unavailable: requestId={}", request_id)
            raise RuntimeError("Approval request could not be delivered")

        try:
            # Publish before waiting so the user can resolve the blocked tool.
            await event_sink(payload)
            await asyncio.wait_for(event.wait(), timeout=self.timeout_seconds)
        except TimeoutError:
            logger.warning("Approval request expired: requestId={}", request_id)
            self.pending_requests.pop(request_id, None)
            self.pending_payloads.pop(request_id, None)
            self._complete(request_id, payload, "expired", None)
            raise ApprovalExpiredError(f"Approval request expired: {request_id}")
        except Exception:
            self.pending_requests.pop(request_id, None)
            self.pending_payloads.pop(request_id, None)
            raise

        approved = self.approval_results.pop(request_id, False)
        self.pending_requests.pop(request_id, None)
        self.pending_payloads.pop(request_id, None)
        self._complete(request_id, payload, "approved" if approved else "rejected", approved)
        if not approved:
            raise ApprovalRejectedError(f"Approval request rejected: {request_id}")
        return {
            "content": f"Approved: {action}",
            "approval": "approved",
            "requestId": request_id,
        }

    def resolve(self, request_id: str, approved: bool) -> bool:
        status, _ = self.resolve_status(request_id, approved)
        return status in {"accepted", "already_decided"}

    def resolve_status(self, request_id: str, approved: bool) -> tuple[str, bool | None]:
        self._purge_completed()
        event = self.pending_requests.get(request_id)
        if event is not None:
            if request_id in self.approval_results:
                existing = self.approval_results[request_id]
                return ("already_decided", existing) if existing == approved else ("conflict", existing)
            self.approval_results[request_id] = approved
            event.set()
            return "accepted", approved

        if request_id in self.completed_statuses:
            existing = self.completed_decisions[request_id]
            if existing is None:
                return "expired", None
            return ("already_decided", existing) if existing == approved else ("conflict", existing)
        return "not_found", None

    def get_pending(self) -> list[dict[str, Any]]:
        self._purge_completed()
        return list(self.pending_payloads.values())

    def get_status(self, request_id: str) -> dict[str, Any] | None:
        self._purge_completed()
        if request_id in self.pending_payloads:
            return {"status": "pending", **self.pending_payloads[request_id]}
        if request_id in self.completed_statuses:
            payload = self.completed_payloads[request_id]
            return {
                "status": self.completed_statuses[request_id],
                "approved": self.completed_decisions[request_id],
                **payload,
            }
        return None

    def _complete(
        self,
        request_id: str,
        payload: dict[str, Any],
        status: str,
        decision: bool | None,
    ) -> None:
        self.completed_payloads[request_id] = payload
        self.completed_statuses[request_id] = status
        self.completed_decisions[request_id] = decision
        self.completed_at[request_id] = datetime.now(UTC)

    def _purge_completed(self) -> None:
        cutoff = datetime.now(UTC) - timedelta(seconds=self.timeout_seconds)
        for request_id, completed_at in list(self.completed_at.items()):
            if completed_at < cutoff:
                self.completed_at.pop(request_id, None)
                self.completed_payloads.pop(request_id, None)
                self.completed_statuses.pop(request_id, None)
                self.completed_decisions.pop(request_id, None)


class ApprovalAgentTool(BaseAgentTool):
    """Agent-tool implementation of the approval request tool."""

    def __init__(self, timeout_seconds: float | None = None) -> None:
        self.coordinator = ApprovalCoordinator(timeout_seconds)
        self.pending_requests = self.coordinator.pending_requests
        self.pending_payloads = self.coordinator.pending_payloads
        self.approval_results = self.coordinator.approval_results

    async def execute(self, input: dict[str, Any], context: AgentContext) -> dict[str, Any]:
        action = input.get("action", "")
        details = input.get("details")
        event_sink = context.metadata.get(APPROVAL_EVENT_SINK_KEY)
        if event_sink is not None and not callable(event_sink):
            event_sink = None
        return await self.coordinator.request(action, details, context, event_sink)

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
        return self.coordinator.resolve(request_id, approved)

    def get_pending(self) -> list[dict[str, Any]]:
        return self.coordinator.get_pending()

    def resolve_approval_status(self, request_id: str, approved: bool) -> tuple[str, bool | None]:
        return self.coordinator.resolve_status(request_id, approved)

    def get_approval_status(self, request_id: str) -> dict[str, Any] | None:
        return self.coordinator.get_status(request_id)


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
