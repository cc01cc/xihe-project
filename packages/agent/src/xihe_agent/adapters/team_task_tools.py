"""task-188 MVP⑤ S2 (D-1821): the four CP-owned team-task board tools — agent-side adapters.

Symmetric to :mod:`xihe_agent.adapters.user_question_tool`: the tools are pure
read/write (no waiter, no waiting semantics), so they deliberately do NOT carry a
`CheckpointSafeToolSchema` — nothing here blocks a run, so there is nothing for a
checkpoint to latch (G3-a 判据 1 applies to waiting tools only).

Wire authority: the four tool faces are registered in CP's `ToolFaceRegistry`
(`team_task_create` / `team_task_list` / `team_task_get` / `team_task_update`,
all mapping to the single `TEAM_TASK_MANAGE` atom, STRUCTURED shape) and executed by
CP's `TeamTaskService` (advisory CAS: every mutation carries `expectedRevision`;
the row is the referee). The read-only HTTP GETs on TeamTaskController are the HUMAN
Lead's board mouth — agents do not use them. The agent reaches the four faces through
the CP logical MCP channel (same pattern as `spawn_agent` / `acquire_credential`);
that CP dispatch is wired by the cp lane (task-188 S2 follow-up). Until then the
client callable is simply not registered and every call answers a readable error
envelope — pure gain, no behavior change (G3-a 灰度模式).

Client contract (the agent-side shape of the CP mouth, injected per run):
    callable(tool: str, arguments: dict) -> dict
  - `team_task_create` / `team_task_get` / `team_task_update` return
    `{"task": {<15-field board row>}}`;
  - `team_task_list` returns `{"tasks": [<row>, ...]}`.
  The row is CP's TeamTaskView projection (taskId/teamRootSessionId/taskNo/revision/
  subject/description/status/ready/ownerSessionId/ownerName/blockedBy/
  writeScopeWarnings/createdBySessionId/createdAt/updatedAt); the adapter passes it
  through unchanged — CP owns the wire.
  Failures raise a duck-typed problem error: `exc.response.status_code` +
  `exc.response.json()` carrying CP's problem `code` / `detail` (the
  `httpx.HTTPStatusError` shape), or a plain `exc.code` string carrier. The
  session/run identity rides the channel, so arguments never carry a sessionId.

Result shape: every return path produces the canonical JSON envelope as
`content` (plus the envelope fields spread on the result dict for the
model/tests):

* success — create/get/update: `{"status": "ok", "task": {...}}`;
  list: `{"status": "ok", "tasks": [...]}`
* local validation failure: `{"status": "error", "code": "INVALID_ARGUMENT",
  "message": ...}` (the model can fix its call and retry)
* CP failure: the CP problem `code` verbatim (TEAM_TASK_FORBIDDEN /
  TEAM_TASK_NOT_FOUND / TEAM_TASK_CONFLICT / TEAM_TASK_TREE_BROKEN /
  TEAM_TASK_CYCLE / TEAM_TASK_INVALID_TARGET / INVALID_REQUEST / ...) with the
  CP detail as `message` — never reclassified.
* transport/unknown failure: `{"status": "error", "code": "TEAM_TASK_TRANSPORT",
  "message": ...}` — a transport bug is reported, never fabricated into a CP code.
"""

import json
from collections.abc import Awaitable, Callable
from typing import Any

from loguru import logger

from xihe_agent.interfaces.context import AgentContext
from xihe_agent.interfaces.tool import BaseAgentTool, ToolSpec

# The per-run injected client (same metadata-injection pattern as
# `_approval_event_sink` / the G3-a resume lookups).
TEAM_TASK_CLIENT_KEY = "_team_task_client"
TeamTaskClient = Callable[[str, dict[str, Any]], Awaitable[dict[str, Any]]]

STATUS_OK = "ok"
STATUS_ERROR = "error"

CODE_INVALID_ARGUMENT = "INVALID_ARGUMENT"
CODE_TRANSPORT = "TEAM_TASK_TRANSPORT"
CODE_UNAVAILABLE = "TEAM_TASK_CLIENT_UNAVAILABLE"
CODE_PROTOCOL = "TEAM_TASK_PROTOCOL"

# Mirror of TeamTaskService's own bounds so a malformed call is a model-readable
# envelope instead of a wasted CP round trip; CP stays the final referee.
SUBJECT_MAX = 200
DESCRIPTION_MAX = 16384
SCOPE_LIST_MAX = 50
SCOPE_ENTRY_MAX = 512

# The six update verbs of TeamTaskService.update (spec/session/team-tasks.md §2).
UPDATE_ACTIONS = frozenset({"claim", "complete", "reopen", "move", "reassign", "update_details"})
# Task statuses accepted by the `move` action (TeamTaskService.requireStatusName).
MOVE_STATUSES = frozenset({"pending", "in_progress", "completed"})


def _envelope_result(envelope: dict[str, Any], **extra: Any) -> dict[str, Any]:
    """Result whose content is the canonical team-task envelope JSON.

    Mirrors `user_question_tool._envelope_result`: only `content` reaches the
    model/durable ToolMessage; the spread fields and extras are dict-only
    diagnostics for tests/debugging.
    """
    result: dict[str, Any] = {
        "content": json.dumps(envelope, ensure_ascii=False, sort_keys=True, separators=(",", ":")),
        **envelope,
    }
    result.update(extra)
    return result


def _ok_task_result(task: dict[str, Any]) -> dict[str, Any]:
    return _envelope_result({"status": STATUS_OK, "task": task})


def _ok_tasks_result(tasks: list[dict[str, Any]]) -> dict[str, Any]:
    return _envelope_result({"status": STATUS_OK, "tasks": tasks})


def _error_result(code: str, message: str) -> dict[str, Any]:
    return _envelope_result({"status": STATUS_ERROR, "code": code, "message": message})



def _unwrap_call_result(result: dict[str, Any]) -> dict[str, Any] | None:
    """Pass through an error marker produced by `TeamTaskCoordinator._call`.

    Returns the envelope-ready error dict, or `None` when the call succeeded
    and the payload shape checks continue.
    """
    if result.get("status") == STATUS_ERROR and isinstance(result.get("code"), str):
        return _error_result(result["code"], str(result.get("message") or result["code"]))
    return None

def _problem_code(exc: BaseException) -> tuple[str, str] | None:
    """Extract `(code, detail)` from a CP-shaped failure, else `None`.

    Recognised shapes, duck-typed on purpose (the adapter keeps no CP-client
    import): an exception exposing a non-empty string `code`, and an
    `httpx.HTTPStatusError`-shaped error whose response body is a problem
    object with a `code`. A CP failure is never reclassified and never
    fabricated: unrecognised exceptions are reported as TEAM_TASK_TRANSPORT.
    """
    code = getattr(exc, "code", None)
    if isinstance(code, str) and code:
        return code, str(exc)
    response = getattr(exc, "response", None)
    status_code = getattr(response, "status_code", None)
    if response is None or not isinstance(status_code, int):
        return None
    try:
        body = response.json()
    except Exception:
        logger.warning(
            "Team-task CP error body is not JSON (status={}); reporting transport",
            status_code,
        )
        return None
    if not isinstance(body, dict):
        return None
    body_code = body.get("code")
    if not isinstance(body_code, str) or not body_code:
        return None
    detail = body.get("detail") or body.get("message") or str(exc)
    return body_code, str(detail)


class TeamTaskCoordinator:
    """Validation + client-call + envelope mapping for the four board tools.

    Stateless on purpose: the board is CP-durable, the tools hold no pending
    state and no waiter (that is exactly why there is no checkpoint schema).
    """

    async def create(
        self, client: TeamTaskClient, arguments: dict[str, Any]
    ) -> dict[str, Any]:
        error_message = self._validate_create(arguments)
        if error_message is not None:
            return _error_result(CODE_INVALID_ARGUMENT, error_message)
        result = await self._call(client, "team_task_create", arguments)
        error_payload = _unwrap_call_result(result)
        if error_payload is not None:
            return error_payload
        if isinstance(result.get("task"), dict):
            return _ok_task_result(result["task"])
        return _protocol_result("team_task_create", result)

    async def list(
        self, client: TeamTaskClient, arguments: dict[str, Any]
    ) -> dict[str, Any]:
        result = await self._call(client, "team_task_list", {})
        error_payload = _unwrap_call_result(result)
        if error_payload is not None:
            return error_payload
        if isinstance(result.get("tasks"), list):
            tasks = result["tasks"]
            if all(isinstance(task, dict) for task in tasks):
                return _ok_tasks_result(tasks)
        return _protocol_result("team_task_list", result)

    async def get(
        self, client: TeamTaskClient, arguments: dict[str, Any]
    ) -> dict[str, Any]:
        error_message = self._validate_task_id(arguments)
        if error_message is not None:
            return _error_result(CODE_INVALID_ARGUMENT, error_message)
        result = await self._call(client, "team_task_get", arguments)
        error_payload = _unwrap_call_result(result)
        if error_payload is not None:
            return error_payload
        if isinstance(result.get("task"), dict):
            return _ok_task_result(result["task"])
        return _protocol_result("team_task_get", result)

    async def update(
        self, client: TeamTaskClient, arguments: dict[str, Any]
    ) -> dict[str, Any]:
        error_message = self._validate_update(arguments)
        if error_message is not None:
            return _error_result(CODE_INVALID_ARGUMENT, error_message)
        result = await self._call(client, "team_task_update", arguments)
        error_payload = _unwrap_call_result(result)
        if error_payload is not None:
            return error_payload
        if isinstance(result.get("task"), dict):
            return _ok_task_result(result["task"])
        return _protocol_result("team_task_update", result)

    # -- client call + error mapping ------------------------------------------
    async def _call(
        self, client: TeamTaskClient, tool: str, arguments: dict[str, Any]
    ) -> dict[str, Any]:
        try:
            result = await client(tool, arguments)
        except Exception as exc:
            problem = _problem_code(exc)
            if problem is not None:
                code, detail = problem
                logger.warning(
                    "Team-task CP call refused: tool={} code={} detail={}",
                    tool,
                    code,
                    detail,
                )
                return {"status": STATUS_ERROR, "code": code, "message": detail}
            logger.warning(
                "Team-task CP call failed: tool={} failure={}",
                tool,
                type(exc).__name__,
            )
            return {
                "status": STATUS_ERROR,
                "code": CODE_TRANSPORT,
                "message": f"{tool} transport failure: {exc}",
            }
        return result if isinstance(result, dict) else {"__raw__": result}

    # -- validation (mirror of TeamTaskService's bounds) ------------------------
    @staticmethod
    def _validate_create(arguments: dict[str, Any]) -> str | None:
        subject = arguments.get("subject")
        if not isinstance(subject, str) or not subject.strip():
            return "subject must be a non-empty string"
        if len(subject) > SUBJECT_MAX:
            return f"subject must be at most {SUBJECT_MAX} characters"
        description = arguments.get("description")
        if description is not None and (
            not isinstance(description, str) or len(description) > DESCRIPTION_MAX
        ):
            return f"description must be a string of at most {DESCRIPTION_MAX} characters"
        scope_error = TeamTaskCoordinator._validate_scope_list(
            arguments.get("blockedBy"), "blockedBy"
        )
        if scope_error is not None:
            return scope_error
        return TeamTaskCoordinator._validate_scope_list(
            arguments.get("writeScopes"), "writeScopes"
        )

    @staticmethod
    def _validate_task_id(arguments: dict[str, Any]) -> str | None:
        task_id = arguments.get("taskId")
        if not isinstance(task_id, str) or not task_id.strip():
            return "taskId must be a non-empty string"
        return None

    @staticmethod
    def _validate_update(arguments: dict[str, Any]) -> str | None:
        task_error = TeamTaskCoordinator._validate_task_id(arguments)
        if task_error is not None:
            return task_error
        expected = arguments.get("expectedRevision")
        if isinstance(expected, bool) or not isinstance(expected, int) or expected < 0:
            return "expectedRevision must be a non-negative integer (advisory CAS value)"
        action = arguments.get("action")
        if not isinstance(action, str) or action not in UPDATE_ACTIONS:
            return "action must be one of: claim / complete / reopen / move / reassign / update_details"
        if action == "move":
            status = arguments.get("status")
            if not isinstance(status, str) or status not in MOVE_STATUSES:
                return "status must be pending / in_progress / completed for action=move"
        if action == "reassign":
            owner = arguments.get("ownerSessionId")
            if owner is not None and (not isinstance(owner, str) or not owner.strip()):
                return "ownerSessionId must be a non-empty string or null (null unclaims)"
        if action == "update_details":
            return TeamTaskCoordinator._validate_create(arguments)
        return None

    @staticmethod
    def _validate_scope_list(value: Any, field: str) -> str | None:
        if value is None:
            return None
        if not isinstance(value, list):
            return f"{field} must be an array of scope strings"
        if len(value) > SCOPE_LIST_MAX:
            return f"{field} must have at most {SCOPE_LIST_MAX} entries"
        for entry in value:
            if not isinstance(entry, str) or not entry.strip() or len(entry) > SCOPE_ENTRY_MAX:
                return f"{field} entries must be non-empty strings of at most {SCOPE_ENTRY_MAX} characters"
        return None


def _protocol_result(tool: str, result: Any) -> dict[str, Any]:
    """The CP mouth answered outside the frozen client contract."""
    logger.warning("Team-task CP result has an unexpected shape: tool={}", tool)
    return _error_result(
        CODE_PROTOCOL,
        f"{tool} returned a result outside the team-task client contract",
    )


class _BaseTeamTaskTool(BaseAgentTool):
    """Shared plumbing: resolve the injected client, delegate to the coordinator."""

    def __init__(self) -> None:
        self.coordinator = TeamTaskCoordinator()

    @property
    def name(self) -> str:
        return self.spec.name

    @property
    def description(self) -> str:
        return self.spec.description

    def _client(self, context: AgentContext) -> TeamTaskClient | None:
        client = context.metadata.get(TEAM_TASK_CLIENT_KEY)
        return client if callable(client) else None


class TeamTaskCreateTool(_BaseTeamTaskTool):
    """Create one card on the tree's shared board (unclaimed, pending)."""

    @property
    def spec(self) -> ToolSpec:
        return ToolSpec(
            name="team_task_create",
            description=(
                "Create a task card on this team's shared board. The board belongs to the "
                "whole delegation tree, not to one session. Returns the created card."
            ),
            input_schema={
                "type": "object",
                "properties": {
                    "subject": {
                        "type": "string",
                        "description": f"Card title (required, max {SUBJECT_MAX} chars)",
                    },
                    "description": {
                        "type": "string",
                        "description": f"Optional body (max {DESCRIPTION_MAX} chars)",
                    },
                    "blockedBy": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": (
                            f"Optional taskIds that block this card (max {SCOPE_LIST_MAX})"
                        ),
                    },
                    "writeScopes": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": (
                            "Optional advisory workspace-relative paths this card expects "
                            "to modify"
                        ),
                    },
                },
                "required": ["subject"],
            },
        )

    async def execute(self, input: dict[str, Any], context: AgentContext) -> dict[str, Any]:
        client = self._client(context)
        if client is None:
            return _error_result(
                CODE_UNAVAILABLE,
                "team-task client is not wired for this run (CP mouth pending)",
            )
        return await self.coordinator.create(client, input)


class TeamTaskListTool(_BaseTeamTaskTool):
    """List every card of the tree's board, tombstones included."""

    @property
    def spec(self) -> ToolSpec:
        return ToolSpec(
            name="team_task_list",
            description=(
                "List all task cards on this team's shared board (including deleted "
                "tombstones). Read-only: no arguments."
            ),
            input_schema={"type": "object", "properties": {}},
        )

    async def execute(self, input: dict[str, Any], context: AgentContext) -> dict[str, Any]:
        client = self._client(context)
        if client is None:
            return _error_result(
                CODE_UNAVAILABLE,
                "team-task client is not wired for this run (CP mouth pending)",
            )
        return await self.coordinator.list(client, input)


class TeamTaskGetTool(_BaseTeamTaskTool):
    """Fetch one board card by taskId."""

    @property
    def spec(self) -> ToolSpec:
        return ToolSpec(
            name="team_task_get",
            description="Fetch one task card of this team's shared board by taskId.",
            input_schema={
                "type": "object",
                "properties": {
                    "taskId": {"type": "string", "description": "The card's taskId (uuid)"},
                },
                "required": ["taskId"],
            },
        )

    async def execute(self, input: dict[str, Any], context: AgentContext) -> dict[str, Any]:
        client = self._client(context)
        if client is None:
            return _error_result(
                CODE_UNAVAILABLE,
                "team-task client is not wired for this run (CP mouth pending)",
            )
        return await self.coordinator.get(client, input)


class TeamTaskUpdateTool(_BaseTeamTaskTool):
    """Mutate one board card through the six advisory-CAS verbs."""

    @property
    def spec(self) -> ToolSpec:
        return ToolSpec(
            name="team_task_update",
            description=(
                "Update one task card of this team's shared board. Advisory CAS: "
                "expectedRevision must match the card's current revision (re-read after "
                "a conflict). Actions: claim (take an unclaimed card), complete, reopen, "
                "move (set status), reassign (creator only; null ownerSessionId unclaims), "
                "update_details (owner only: subject/description/blockedBy/writeScopes)."
            ),
            input_schema={
                "type": "object",
                "properties": {
                    "taskId": {"type": "string", "description": "The card's taskId (uuid)"},
                    "expectedRevision": {
                        "type": "integer",
                        "description": "Current revision of the card (advisory CAS)",
                    },
                    "action": {
                        "type": "string",
                        "enum": sorted(UPDATE_ACTIONS),
                    },
                    "ownerSessionId": {
                        "type": "string",
                        "description": "reassign target session id (null unclaims)",
                    },
                    "status": {
                        "type": "string",
                        "enum": sorted(MOVE_STATUSES),
                        "description": "Target status for action=move",
                    },
                    "subject": {"type": "string"},
                    "description": {"type": "string"},
                    "blockedBy": {"type": "array", "items": {"type": "string"}},
                    "writeScopes": {"type": "array", "items": {"type": "string"}},
                },
                "required": ["taskId", "expectedRevision", "action"],
            },
        )

    async def execute(self, input: dict[str, Any], context: AgentContext) -> dict[str, Any]:
        client = self._client(context)
        if client is None:
            return _error_result(
                CODE_UNAVAILABLE,
                "team-task client is not wired for this run (CP mouth pending)",
            )
        return await self.coordinator.update(client, input)
