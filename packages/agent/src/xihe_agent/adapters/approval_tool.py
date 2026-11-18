import asyncio
import hashlib
import json
import os
import re
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime, timedelta
from typing import Any, TypeGuard
from uuid import uuid4

from langchain_core.tools import BaseTool
from loguru import logger
from pydantic import BaseModel, Field

from xihe_agent.interfaces.context import AgentContext
from xihe_agent.interfaces.tool import BaseAgentTool, CheckpointSafeToolSchema, ToolSpec

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


class ApprovalProtocolError(ApprovalTerminalError):
    """Terminal: the CP gate approval signal violated the frozen contract.

    Fail-closed companion for malformed/mismatched 409 APPROVAL_REQUIRED
    extensions (PLAN-0328 T1.9): no waiter may be registered from them and the
    call must not be retried.
    """

    code = "APPROVAL_FAILED"


class ApprovalRetryFailedError(ApprovalTerminalError):
    """Terminal: the single post-grant retry did not succeed (fail closed).

    A second 409/403 or any other retry-side MCP failure ends the approval flow
    for this call; the Agent never retries a third time.
    """

    code = "APPROVAL_FAILED"


APPROVAL_DETAILS_PREVIEW_LIMIT = 500
APPROVAL_FEEDBACK_LIMIT = 512
# Mirrors CP's own request-id validation (ApprovalAgentClient.status): the CP
# gate owns the id shape; anything else is a contract violation.
APPROVAL_REQUEST_ID_PATTERN = re.compile(r"^[A-Za-z0-9-]{1,128}$")
# Fail-closed ceiling for a pushed approval wait: a bogus far-future expiresAt
# must not produce an unbounded waiter.
EXTERNAL_WAIT_CEILING_S = 3600.0

# ---------------------------------------------------------------------------
# G3-a checkpoint-safe envelope (task-208 acceptance draft 判据 1/3/7)
# ---------------------------------------------------------------------------
#
# Symmetric to user_question_tool.py. Terminal semantics are UNCHANGED (PLAN-0381
# T3.2 / decision #23): a rejected or expired approval still raises
# ApprovalRejectedError / ApprovalExpiredError — those paths end the run by design
# and never produce a ToolMessage, so there is nothing to checkpoint-latch. The
# envelope is produced for the approved path (and carries the full status enum so a
# future ruling can envelope the terminal outcomes without a schema change; the
# enum/fields are the draft baseline, 只减不增).

REQUEST_APPROVAL_ENVELOPE_VERSION = "request-approval-envelope.v1"

# Same bound rationale as ask_user: schema bounds must accept every live arg the
# coordinator handles so validation stays in code and outcomes stay envelopes
# instead of dispatch-time projection failures. 65536 is the validator ceiling.
CHECKPOINT_SAFE_APPROVAL_INPUT_MAX_LENGTH = 65536

REQUEST_APPROVAL_CHECKPOINT_SAFE_SCHEMA = CheckpointSafeToolSchema(
    version=REQUEST_APPROVAL_ENVELOPE_VERSION,
    input_schema={
        "type": "object",
        "properties": {
            "action": {"type": "string", "maxLength": CHECKPOINT_SAFE_APPROVAL_INPUT_MAX_LENGTH},
            "details": {"type": "string", "maxLength": CHECKPOINT_SAFE_APPROVAL_INPUT_MAX_LENGTH},
        },
        "required": ["action"],
        "additionalProperties": False,
    },
    output_schema={
        "type": "object",
        "properties": {
            "requestId": {"type": "string", "maxLength": 64},
            "status": {
                "type": "string",
                "enum": ["approved", "rejected", "expired", "error"],
            },
            # Rejection feedback is capped at APPROVAL_FEEDBACK_LIMIT (512) before
            # it reaches the coordinator; 2048 is the draft baseline with headroom.
            # Only meaningful for status=rejected; "" otherwise.
            "feedback": {"type": "string", "maxLength": 2048},
        },
        "required": ["requestId", "status"],
        "additionalProperties": False,
    },
)

# Agent-side client shape for the CP C4 read-only endpoint (draft §2-C4, approval
# symmetric; implemented by the cp lane). Given a runId, return the durable
# approval row, or None when the run has none:
#   {"requestId": str, "state": "pending"|"approved"|"rejected"|"expired",
#    "feedback": str | None, "expiresAt": str | None}   # ISO-8601
APPROVAL_RESUME_LOOKUP_KEY = "_approval_resume_lookup"
ApprovalResumeLookup = Callable[[str], Awaitable[dict[str, Any] | None]]

APPROVAL_RESUME_STATE_APPROVED = "approved"
APPROVAL_RESUME_STATE_REJECTED = "rejected"
APPROVAL_RESUME_STATE_EXPIRED = "expired"
APPROVAL_RESUME_STATE_PENDING = "pending"


def _approval_envelope_result(request_id: str, status: str, feedback: str = "") -> dict[str, Any]:
    """Result whose content is the canonical request-approval envelope JSON."""
    envelope = {"requestId": request_id, "status": status, "feedback": feedback}
    return {
        "content": json.dumps(envelope, ensure_ascii=False, sort_keys=True, separators=(",", ":")),
        **envelope,
    }

_SECRET_PATTERNS = (
    re.compile(r"(?i)(bearer\s+[A-Za-z0-9\-._~+/=]+)"),
    re.compile(r'(?i)(api[_-]?key\s*[:=]\s*[^\s",}]+)'),
    re.compile(r'(?i)(secret\s*[:=]\s*[^\s",}]+)'),
    re.compile(r'(?i)(password\s*[:=]\s*[^\s",}]+)'),
    re.compile(r'(?i)(token\s*[:=]\s*[^\s",}]+)'),
)


def redact_approval_details(details: str | None) -> tuple[str, str]:
    """Redact approval details to a bounded preview plus canonical hash.

    PLAN-271 P0: full MCP arguments must never enter the approval row, SSE
    replay, or ordinary logs. Returns (preview, arguments_hash).

    PLAN-292 M1: the hash is always taken over the canonical form — parse
    then json.dumps(ensure_ascii=False, sort_keys=True, separators=(",", ":")).
    CP rebuilds the same canonical bytes with Jackson (ORDER_MAP_ENTRIES_BY_KEYS,
    compact) to match the grant by hash, so a >500-char preview truncation can
    no longer fail an approved call. String inputs must NOT be hashed raw.
    """
    raw = details or ""
    try:
        parsed = json.loads(raw) if isinstance(raw, str) else raw
        canonical = json.dumps(parsed, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    except Exception:
        canonical = str(raw)
    arguments_hash = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
    preview = canonical
    for pattern in _SECRET_PATTERNS:
        preview = pattern.sub("[REDACTED]", preview)
    if len(preview) > APPROVAL_DETAILS_PREVIEW_LIMIT:
        preview = preview[:APPROVAL_DETAILS_PREVIEW_LIMIT] + "…[truncated]"
    if not preview:
        # Fail-closed redaction: never fall back to raw full arguments.
        preview = "[REDACTED]"
    return preview, arguments_hash


def _configured_timeout_seconds() -> float:
    raw = os.getenv("XIHE_APPROVAL_TIMEOUT_SECONDS", "300")
    try:
        return max(0.1, float(raw))
    except ValueError:
        logger.warning("Invalid XIHE_APPROVAL_TIMEOUT_SECONDS value: {}", raw)
        return 300.0


def is_valid_approval_request_id(request_id: Any) -> TypeGuard[str]:
    """PLAN-0328 T1.9: the CP gate provides the request id; validate before keying state.

    Returns True only for a `str` matching the id pattern, so callers can rely
    on the narrowed `str` type after the guard.
    """
    return isinstance(request_id, str) and bool(APPROVAL_REQUEST_ID_PATTERN.fullmatch(request_id))


def parse_approval_expiry(value: Any) -> datetime:
    """Parse the CP gate expiresAt; malformed values fail closed (never wait unbounded)."""
    if isinstance(value, datetime):
        parsed = value
    elif isinstance(value, str) and value:
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            raise ApprovalProtocolError("CP gate approval expiresAt is malformed") from None
    else:
        raise ApprovalProtocolError("CP gate approval expiresAt is missing")
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    return parsed


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
        # PLAN-0328 M1: rejection feedback travels CP → Agent and is surfaced to the
        # model/terminal error; it is never persisted here beyond the pending window.
        self.approval_feedback: dict[str, str] = {}
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
        tool: str = "request_approval",
    ) -> dict[str, Any]:
        metadata = context.metadata
        # G3-a resume 认领: on replay after a restart the CP durable approval row
        # (keyed by runId, CP C4 read-only endpoint via the registered lookup)
        # settles the outcome BEFORE a new request is generated or published —
        # approved rows are consumed directly, pending rows re-arm the wait keyed
        # by the CP requestId, rejected/expired rows re-raise the same terminal
        # error the original wait produced. Without a registered lookup this is a
        # no-op.
        resume_lookup = metadata.get(APPROVAL_RESUME_LOOKUP_KEY)
        if callable(resume_lookup):
            row = await self._resume_row(resume_lookup, str(metadata.get("runId", "")))
            if row is not None:
                resumed = await self._request_from_resume_row(row, context, tool)
                if resumed is not None:
                    return resumed
        request_id = str(uuid4())
        event = asyncio.Event()
        now = datetime.now(UTC)
        preview, arguments_hash = redact_approval_details(details)
        payload = {
            "requestId": request_id,
            "runId": str(metadata.get("runId", "")),
            "sessionId": str(metadata.get("sessionId", context.aggregate_id)),
            "workspaceId": str(metadata.get("workspaceId", "")),
            "tool": tool,
            "action": action,
            "details": preview,
            "argumentsHash": f"sha256:{arguments_hash}",
            "expiresAt": (now + timedelta(seconds=self.timeout_seconds)).isoformat().replace("+00:00", "Z"),
        }
        self.pending_requests[request_id] = event
        self.pending_payloads[request_id] = payload

        if event_sink is None:
            self.pending_requests.pop(request_id, None)
            self.pending_payloads.pop(request_id, None)
            self.approval_feedback.pop(request_id, None)
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
            self.approval_feedback.pop(request_id, None)
            self._complete(request_id, payload, "expired", None)
            raise ApprovalExpiredError(f"Approval request expired: {request_id}")
        except asyncio.CancelledError:
            # PLAN-0323 A-1: task cancellation (BaseException) must not leave
            # the request pending, otherwise get_pending() keeps replaying an
            # approval from a cancelled run.
            logger.warning("Approval request cancelled: requestId={}", request_id)
            self.pending_requests.pop(request_id, None)
            self.pending_payloads.pop(request_id, None)
            self.approval_feedback.pop(request_id, None)
            raise
        except Exception:
            self.pending_requests.pop(request_id, None)
            self.pending_payloads.pop(request_id, None)
            self.approval_feedback.pop(request_id, None)
            raise

        approved = self.approval_results.pop(request_id, False)
        feedback = self.approval_feedback.pop(request_id, None)
        self.pending_requests.pop(request_id, None)
        self.pending_payloads.pop(request_id, None)
        self._complete(request_id, payload, "approved" if approved else "rejected", approved)
        if not approved:
            # PLAN-0328 M1 (decision #23): rejection may carry user feedback; it travels with
            # the terminal error so the model/user sees why the action was refused.
            message = f"Approval request rejected: {request_id}"
            if feedback:
                message = f"{message}. User feedback: {feedback}"
            raise ApprovalRejectedError(message)
        # G3-a: the approved result is the request-approval envelope; feedback is
        # empty on approval (it only travels with a rejection, which is terminal).
        return _approval_envelope_result(request_id=request_id, status="approved")

    def resolve(self, request_id: str, approved: bool) -> bool:
        status, _ = self.resolve_status(request_id, approved)
        return status in {"accepted", "already_decided"}

    async def await_external(
        self,
        request_id: str,
        tool: str,
        expires_at: datetime,
        context: AgentContext | None = None,
    ) -> bool:
        """Wait for a CP-gate approval decision pushed through the respond route.

        PLAN-0328 T1.9 (post-gate): CP owns the durable approval row created when
        the MCP gate answered the first call with 409 APPROVAL_REQUIRED; the Agent
        only registers a local waiter keyed by the CP-provided request id. The
        waiter is registered before any other check or await, so a decision that
        arrives while the 409 is still being processed is never lost.

        Returns True once approved; raises ApprovalRejectedError (carrying
        feedback) on rejection and ApprovalExpiredError on expiry/deadline.
        """
        if not is_valid_approval_request_id(request_id):
            raise ApprovalProtocolError("CP gate approval request id is invalid")
        if request_id in self.pending_requests or request_id in self.completed_statuses:
            raise ApprovalProtocolError(f"CP gate approval request id is already known: {request_id}")
        event = asyncio.Event()
        payload = self._external_payload(request_id, tool, expires_at, context)
        self.pending_requests[request_id] = event
        self.pending_payloads[request_id] = payload

        try:
            deadline = parse_approval_expiry(expires_at)
        except ApprovalProtocolError:
            self._discard_pending(request_id)
            raise

        remaining = (deadline - datetime.now(UTC)).total_seconds()
        if remaining <= 0:
            self._discard_pending(request_id)
            self._complete(request_id, payload, "expired", None)
            raise ApprovalExpiredError(f"Approval request expired: {request_id}")
        if remaining > EXTERNAL_WAIT_CEILING_S:
            logger.warning(
                "CP gate approval wait clamped to local ceiling: requestId={} expiresAt={}",
                request_id,
                deadline.isoformat(),
            )
        try:
            await asyncio.wait_for(event.wait(), timeout=min(remaining, EXTERNAL_WAIT_CEILING_S))
        except TimeoutError:
            logger.warning("CP gate approval request expired while waiting: requestId={}", request_id)
            self._discard_pending(request_id)
            self._complete(request_id, payload, "expired", None)
            raise ApprovalExpiredError(f"Approval request expired: {request_id}")
        except asyncio.CancelledError:
            # Task cancellation must not leave a pending waiter that the respond
            # route could later resolve for a cancelled run.
            logger.warning("CP gate approval request cancelled: requestId={}", request_id)
            self._discard_pending(request_id)
            raise
        except Exception:
            logger.warning("CP gate approval wait failed: requestId={}", request_id, exc_info=True)
            self._discard_pending(request_id)
            raise

        approved = self.approval_results.pop(request_id, False)
        feedback = self.approval_feedback.pop(request_id, None)
        self._discard_pending(request_id)
        self._complete(request_id, payload, "approved" if approved else "rejected", approved)
        if not approved:
            message = f"Approval request rejected: {request_id}"
            if feedback:
                message = f"{message}. User feedback: {feedback}"
            raise ApprovalRejectedError(message)
        return True

    def _external_payload(
        self,
        request_id: str,
        tool: str,
        expires_at: Any,
        context: AgentContext | None,
    ) -> dict[str, Any]:
        """Safe pending payload for a CP-owned approval (no raw arguments ever)."""
        metadata = context.metadata if context is not None else {}
        expires = ""
        if isinstance(expires_at, datetime):
            normalized = expires_at if expires_at.tzinfo else expires_at.replace(tzinfo=UTC)
            expires = normalized.isoformat().replace("+00:00", "Z")
        return {
            "requestId": request_id,
            "runId": str(metadata.get("runId", "")),
            "sessionId": str(metadata.get("sessionId", context.aggregate_id if context is not None else "")),
            "workspaceId": str(metadata.get("workspaceId", "")),
            "tool": tool,
            "action": f"Execute {tool}",
            "expiresAt": expires,
            "source": "cp_gate",
        }

    def _discard_pending(self, request_id: str) -> None:
        self.pending_requests.pop(request_id, None)
        self.pending_payloads.pop(request_id, None)
        self.approval_feedback.pop(request_id, None)

    # -- resume 认领 (G3-a A3: replay after restart claims the CP durable row) --
    async def _resume_row(
        self, lookup: ApprovalResumeLookup, run_id: str
    ) -> dict[str, Any] | None:
        """Call the C4 resume lookup, mapping every failure to "no row".

        Falling through to a fresh request on failure is acceptable because CP
        keeps at most one live approval per run (claim/replay vocabulary), so a
        duplicate publish is refused rather than silently double-asking.
        """
        try:
            row = await lookup(run_id)
        except Exception:
            logger.warning(
                "Approval resume lookup failed; falling back to a fresh request: runId={}",
                run_id,
                exc_info=True,
            )
            return None
        if not isinstance(row, dict) or not isinstance(row.get("requestId"), str) or not row["requestId"]:
            return None
        return row

    async def _request_from_resume_row(
        self, row: dict[str, Any], context: AgentContext, tool: str
    ) -> dict[str, Any] | None:
        """Map one CP durable approval row (looked up by runId) to an outcome.

        Returns None for unrecognized states so the caller falls through to a
        fresh request. Terminal outcomes re-raise exactly what the normal wait
        path raises (PLAN-0381 T3.2 unchanged); the completed tables are primed so
        a retried decision push resolves idempotently instead of not_found.
        """
        request_id = row["requestId"]
        state = row.get("state")
        feedback = row.get("feedback")
        if not isinstance(feedback, str):
            feedback = None
        payload = self._external_payload(
            request_id, tool, row.get("expiresAt") or "", context
        )
        if state == APPROVAL_RESUME_STATE_APPROVED:
            self._complete(request_id, payload, "approved", True)
            return _approval_envelope_result(request_id=request_id, status="approved")
        if state == APPROVAL_RESUME_STATE_REJECTED:
            self._complete(request_id, payload, "rejected", False)
            message = f"Approval request rejected: {request_id}"
            if feedback:
                message = f"{message}. User feedback: {feedback}"
            raise ApprovalRejectedError(message)
        if state == APPROVAL_RESUME_STATE_EXPIRED:
            self._complete(request_id, payload, "expired", None)
            raise ApprovalExpiredError(f"Approval request expired: {request_id}")
        if state == APPROVAL_RESUME_STATE_PENDING:
            # Reuse the proven CP-gate wait: it registers the waiter under the CP
            # requestId, never publishes (the durable row already exists — 判据 7
            # forbids a second request), clamps to the local ceiling and raises
            # the same terminal errors on rejection/expiry.
            # L-8 conservative choice: the remaining durable window owns the wait;
            # a missing/malformed expiresAt is a protocol violation, never an
            # unbounded wait.
            await self.await_external(request_id, tool, self._resume_expires_at(row, request_id), context)
            return _approval_envelope_result(request_id=request_id, status="approved")
        logger.warning(
            "Approval resume row has an unrecognized state: requestId={} state={}",
            request_id,
            state,
        )
        return None

    @staticmethod
    def _resume_expires_at(row: dict[str, Any], request_id: str) -> datetime:
        raw = row.get("expiresAt")
        if not isinstance(raw, str) or not raw:
            raise ApprovalProtocolError("CP resume approval expiresAt is missing")
        try:
            parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
        except ValueError:
            raise ApprovalProtocolError("CP resume approval expiresAt is malformed") from None
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=UTC)
        return parsed

    def resolve_status(self, request_id: str, approved: bool, feedback: str | None = None) -> tuple[str, bool | None]:
        """Resolve one pending request; PLAN-0328 M1 adds optional rejection feedback."""
        self._purge_completed()
        event = self.pending_requests.get(request_id)
        if event is not None:
            if request_id in self.approval_results:
                existing = self.approval_results[request_id]
                return ("already_decided", existing) if existing == approved else ("conflict", existing)
            self.approval_results[request_id] = approved
            if feedback:
                self.approval_feedback[request_id] = feedback[:APPROVAL_FEEDBACK_LIMIT]
            event.set()
            return "accepted", approved

        if request_id in self.completed_statuses:
            decision = self.completed_decisions[request_id]
            if decision is None:
                return "expired", None
            return ("already_decided", decision) if decision == approved else ("conflict", decision)
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
                self.approval_feedback.pop(request_id, None)


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
        tool = str(input.get("tool") or "request_approval")
        event_sink = context.metadata.get(APPROVAL_EVENT_SINK_KEY)
        if event_sink is not None and not callable(event_sink):
            event_sink = None
        return await self.coordinator.request(action, details, context, event_sink, tool)

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
            # G3-a 判据 1/7: a waiting approval run must checkpoint — the pending AI
            # message args project through this schema and the approved result
            # projects through the output envelope (判据 3).
            checkpoint_safe_schema=REQUEST_APPROVAL_CHECKPOINT_SAFE_SCHEMA,
        )

    @property
    def name(self) -> str:
        return self.spec.name

    @property
    def description(self) -> str:
        return self.spec.description

    def resolve_approval(self, request_id: str, approved: bool) -> bool:
        return self.coordinator.resolve(request_id, approved)

    async def await_external_approval(
        self,
        request_id: str,
        tool: str,
        expires_at: datetime,
        context: AgentContext | None = None,
    ) -> bool:
        """PLAN-0328 T1.9: wait for a CP-gate decision pushed through the respond route."""
        return await self.coordinator.await_external(request_id, tool, expires_at, context)

    def get_pending(self) -> list[dict[str, Any]]:
        return self.coordinator.get_pending()

    def resolve_approval_status(
        self, request_id: str, approved: bool, feedback: str | None = None
    ) -> tuple[str, bool | None]:
        return self.coordinator.resolve_status(request_id, approved, feedback)

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
