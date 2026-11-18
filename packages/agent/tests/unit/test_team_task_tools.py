"""task-188 MVP⑤ S2: the four team-task board tools — tool-edge contract tests.

Verification classes at the adapter edge (no CP, no real stack — the client is an
injected fake, same pattern as the ask_user event-sink tests):
* the four ToolSpecs match the ToolFaceRegistry faces (names, no checkpoint schema),
* every success path returns the canonical JSON envelope with the CP row passthrough,
* local validation failures are model-readable INVALID_ARGUMENT envelopes and never
  reach the client,
* CP problem codes (403/404/409 family) pass through verbatim, never reclassified,
* unrecognised client failures are TEAM_TASK_TRANSPORT, never a fabricated CP code,
* an unwired run answers TEAM_TASK_CLIENT_UNAVAILABLE (G3-a 灰度: pure gain).
"""

import json

import pytest

from xihe_agent.adapters.team_task_tools import (
    DESCRIPTION_MAX,
    SCOPE_ENTRY_MAX,
    SCOPE_LIST_MAX,
    SUBJECT_MAX,
    TEAM_TASK_CLIENT_KEY,
    MOVE_STATUSES,
    UPDATE_ACTIONS,
    TeamTaskCreateTool,
    TeamTaskGetTool,
    TeamTaskListTool,
    TeamTaskUpdateTool,
)
from xihe_agent.interfaces.context import AgentContext

TASK_ID = "2d3f6f8e-7f1b-4f5a-9c3d-7f1b4f5a9c3d"


def _row(**overrides):
    row = {
        "taskId": TASK_ID,
        "teamRootSessionId": "root-session",
        "taskNo": 7,
        "revision": 3,
        "subject": "Wire the board adapters",
        "description": "packages/agent adapters",
        "status": "pending",
        "ready": True,
        "ownerSessionId": None,
        "ownerName": None,
        "blockedBy": [],
        "writeScopeWarnings": [],
        "createdBySessionId": "caller-session",
        "createdAt": "2026-11-18T04:00:00Z",
        "updatedAt": "2026-11-18T04:00:00Z",
    }
    row.update(overrides)
    return row


def _context(client=None) -> AgentContext:
    context = AgentContext.empty("session-1")
    context.metadata.update(
        {"runId": "run-1", "sessionId": "session-1", "workspaceId": "workspace-1"}
    )
    if client is not None:
        context.metadata[TEAM_TASK_CLIENT_KEY] = client
    return context


def _recording_client(calls: list, payload=None, error=None):
    async def client(tool: str, arguments: dict) -> dict:
        calls.append((tool, arguments))
        if error is not None:
            raise error
        return payload if payload is not None else {"task": _row()}

    return client


# -- spec shapes ------------------------------------------------------------------------------


def test_specs_match_the_tool_face_registry_faces():
    tools = [TeamTaskCreateTool(), TeamTaskListTool(), TeamTaskGetTool(), TeamTaskUpdateTool()]
    assert [tool.name for tool in tools] == [
        "team_task_create",
        "team_task_list",
        "team_task_get",
        "team_task_update",
    ]
    for tool in tools:
        # Pure read/write: no waiting semantics, so no checkpoint-safe schema (G3-a 判据 1).
        assert tool.spec.checkpoint_safe_schema is None
        assert tool.name == tool.spec.name
        assert tool.description == tool.spec.description


def test_update_spec_declares_the_six_cas_verbs():
    tool = TeamTaskUpdateTool()
    properties = tool.spec.input_schema["properties"]
    assert set(properties["action"]["enum"]) == UPDATE_ACTIONS == {
        "claim",
        "complete",
        "reopen",
        "move",
        "reassign",
        "update_details",
    }
    assert set(properties["status"]["enum"]) == MOVE_STATUSES
    assert tool.spec.input_schema["required"] == ["taskId", "expectedRevision", "action"]


# -- success paths ------------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_create_returns_the_created_card_envelope():
    calls: list = []
    tool = TeamTaskCreateTool()
    result = await tool.execute(
        {
            "subject": "Wire the board adapters",
            "description": "packages/agent adapters",
            "blockedBy": [],
            "writeScopes": ["packages/agent"],
        },
        _context(_recording_client(calls)),
    )

    assert calls == [
        (
            "team_task_create",
            {
                "subject": "Wire the board adapters",
                "description": "packages/agent adapters",
                "blockedBy": [],
                "writeScopes": ["packages/agent"],
            },
        )
    ]
    assert result["status"] == "ok"
    assert result["task"]["taskId"] == TASK_ID
    # content is the canonical envelope JSON (sorted keys, compact separators).
    assert json.loads(result["content"]) == {
        "status": "ok",
        "task": _row(),
    }


@pytest.mark.asyncio
async def test_list_returns_the_whole_board():
    calls: list = []
    rows = [_row(taskNo=1), _row(taskNo=2, status="deleted")]
    tool = TeamTaskListTool()
    result = await tool.execute(
        {}, _context(_recording_client(calls, payload={"tasks": rows}))
    )

    assert calls == [("team_task_list", {})]  # read-only: no arguments
    assert result["status"] == "ok"
    assert result["tasks"] == rows
    assert json.loads(result["content"]) == {"status": "ok", "tasks": rows}


@pytest.mark.asyncio
async def test_get_returns_one_card():
    calls: list = []
    tool = TeamTaskGetTool()
    result = await tool.execute({"taskId": TASK_ID}, _context(_recording_client(calls)))

    assert calls == [("team_task_get", {"taskId": TASK_ID})]
    assert result["status"] == "ok"
    assert result["task"]["taskId"] == TASK_ID


@pytest.mark.asyncio
async def test_update_claim_passes_the_advisory_cas_arguments():
    calls: list = []
    tool = TeamTaskUpdateTool()
    result = await tool.execute(
        {"taskId": TASK_ID, "expectedRevision": 3, "action": "claim"},
        _context(_recording_client(calls, payload={"task": _row(revision=4)})),
    )

    assert calls == [
        (
            "team_task_update",
            {"taskId": TASK_ID, "expectedRevision": 3, "action": "claim"},
        )
    ]
    assert result["status"] == "ok"
    assert result["task"]["revision"] == 4


@pytest.mark.asyncio
async def test_update_reassign_allows_null_owner_to_unclaim():
    calls: list = []
    tool = TeamTaskUpdateTool()
    result = await tool.execute(
        {
            "taskId": TASK_ID,
            "expectedRevision": 3,
            "action": "reassign",
            "ownerSessionId": None,
        },
        _context(_recording_client(calls)),
    )

    assert calls[0][1]["ownerSessionId"] is None
    assert result["status"] == "ok"


@pytest.mark.asyncio
async def test_update_details_validates_like_create():
    calls: list = []
    tool = TeamTaskUpdateTool()
    result = await tool.execute(
        {
            "taskId": TASK_ID,
            "expectedRevision": 3,
            "action": "update_details",
            "subject": "New subject",
            "writeScopes": ["packages/agent"],
        },
        _context(_recording_client(calls)),
    )

    assert calls[0][1]["subject"] == "New subject"
    assert result["status"] == "ok"


# -- local validation: model-readable INVALID_ARGUMENT, client never called ---------------------


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "payload",
    [
        {},
        {"subject": "   "},
        {"subject": "x" * (SUBJECT_MAX + 1)},
        {"subject": "ok", "description": "x" * (DESCRIPTION_MAX + 1)},
        {"subject": "ok", "description": 42},
        {"subject": "ok", "blockedBy": "not-a-list"},
        {"subject": "ok", "blockedBy": ["x"] * (SCOPE_LIST_MAX + 1)},
        {"subject": "ok", "blockedBy": ["   "]},
        {"subject": "ok", "writeScopes": ["x" * (SCOPE_ENTRY_MAX + 1)]},
    ],
)
async def test_create_invalid_arguments_never_reach_the_client(payload):
    calls: list = []
    tool = TeamTaskCreateTool()
    result = await tool.execute(payload, _context(_recording_client(calls)))

    assert result["status"] == "error"
    assert result["code"] == "INVALID_ARGUMENT"
    assert result["message"]
    assert calls == []
    assert json.loads(result["content"])["code"] == "INVALID_ARGUMENT"


@pytest.mark.asyncio
async def test_get_requires_a_task_id():
    calls: list = []
    tool = TeamTaskGetTool()
    result = await tool.execute({}, _context(_recording_client(calls)))

    assert result["status"] == "error"
    assert result["code"] == "INVALID_ARGUMENT"
    assert calls == []


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "payload",
    [
        # advisory CAS: expectedRevision is mandatory.
        {"taskId": TASK_ID, "action": "claim"},
        {"taskId": TASK_ID, "expectedRevision": "3", "action": "claim"},
        {"taskId": TASK_ID, "expectedRevision": True, "action": "claim"},
        {"taskId": TASK_ID, "expectedRevision": -1, "action": "claim"},
        # unknown verb.
        {"taskId": TASK_ID, "expectedRevision": 3, "action": "delete"},
        # move needs a valid target status.
        {"taskId": TASK_ID, "expectedRevision": 3, "action": "move"},
        {"taskId": TASK_ID, "expectedRevision": 3, "action": "move", "status": "blocked"},
        # reassign target must be a non-empty string when present.
        {"taskId": TASK_ID, "expectedRevision": 3, "action": "reassign", "ownerSessionId": " "},
        # update_details re-runs the create-side bounds.
        {"taskId": TASK_ID, "expectedRevision": 3, "action": "update_details", "subject": " "},
    ],
)
async def test_update_invalid_arguments_never_reach_the_client(payload):
    calls: list = []
    tool = TeamTaskUpdateTool()
    result = await tool.execute(payload, _context(_recording_client(calls)))

    assert result["status"] == "error"
    assert result["code"] == "INVALID_ARGUMENT"
    assert calls == []


# -- CP problem codes pass through verbatim -----------------------------------------------------


class _ProblemResponse:
    """``httpx.Response``-shaped double: only the two attributes the mapper reads."""

    def __init__(self, status_code: int, payload: dict):
        self.status_code = status_code
        self._payload = payload

    def json(self) -> dict:
        return self._payload


class _ProblemError(Exception):
    """``httpx.HTTPStatusError``-shaped double carrying a problem+json body."""

    def __init__(self, status_code: int, payload: dict):
        super().__init__(f"{status_code} problem")
        self.response = _ProblemResponse(status_code, payload)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("status_code", "problem"),
    [
        (400, {"code": "INVALID_REQUEST", "detail": "subject is required"}),
        (403, {"code": "TEAM_TASK_FORBIDDEN", "detail": "an explicit TEAM_TASK_MANAGE grant is required"}),
        (404, {"code": "TEAM_TASK_NOT_FOUND", "detail": "task is not on this board"}),
        (409, {"code": "TEAM_TASK_CONFLICT", "detail": "expectedRevision does not match the current revision"}),
        (409, {"code": "TEAM_TASK_TREE_BROKEN", "detail": "ancestor missing"}),
        (409, {"code": "TEAM_TASK_CYCLE", "detail": "blockedBy would close a dependency cycle"}),
        (409, {"code": "TEAM_TASK_INVALID_TARGET", "detail": "target session does not exist"}),
    ],
)
async def test_cp_problem_codes_pass_through_verbatim(status_code, problem):
    calls: list = []
    tool = TeamTaskUpdateTool()
    result = await tool.execute(
        {"taskId": TASK_ID, "expectedRevision": 3, "action": "claim"},
        _context(
            _recording_client(calls, error=_ProblemError(status_code, problem))
        ),
    )

    # CP's word is never reclassified and never guessed.
    assert result["status"] == "error"
    assert result["code"] == problem["code"]
    assert result["message"] == problem["detail"]
    assert json.loads(result["content"]) == {
        "status": "error",
        "code": problem["code"],
        "message": problem["detail"],
    }
    assert len(calls) == 1  # the call was attempted exactly once


@pytest.mark.asyncio
async def test_cp_error_carried_by_plain_code_attribute_is_mapped():
    class CodeCarrierError(Exception):
        code = "TEAM_TASK_FORBIDDEN"

    calls: list = []
    tool = TeamTaskGetTool()
    result = await tool.execute(
        {"taskId": TASK_ID}, _context(_recording_client(calls, error=CodeCarrierError("no")))
    )

    assert result["status"] == "error"
    assert result["code"] == "TEAM_TASK_FORBIDDEN"


# -- transport / protocol / unwired failures are readable, never raised -------------------------


@pytest.mark.asyncio
async def test_unrecognised_client_failure_is_transport_not_a_fabricated_cp_code():
    calls: list = []
    tool = TeamTaskListTool()
    result = await tool.execute(
        {}, _context(_recording_client(calls, error=RuntimeError("connection reset")))
    )

    assert result["status"] == "error"
    assert result["code"] == "TEAM_TASK_TRANSPORT"
    assert "team_task_list" in result["message"]


@pytest.mark.asyncio
async def test_non_dict_client_result_is_a_protocol_error():
    calls: list = []

    async def bad_client(tool: str, arguments: dict):
        calls.append((tool, arguments))
        return ["not", "a", "dict"]

    tool = TeamTaskGetTool()
    result = await tool.execute({"taskId": TASK_ID}, _context(bad_client))

    assert result["status"] == "error"
    assert result["code"] == "TEAM_TASK_PROTOCOL"
    assert calls == [("team_task_get", {"taskId": TASK_ID})]


@pytest.mark.asyncio
async def test_wrong_success_shape_is_a_protocol_error():
    calls: list = []
    tool = TeamTaskGetTool()
    result = await tool.execute(
        {"taskId": TASK_ID},
        _context(_recording_client(calls, payload={"unexpected": True})),
    )

    assert result["status"] == "error"
    assert result["code"] == "TEAM_TASK_PROTOCOL"


@pytest.mark.asyncio
async def test_unwired_run_answers_client_unavailable_for_all_four_tools():
    tools = [TeamTaskCreateTool(), TeamTaskListTool(), TeamTaskGetTool(), TeamTaskUpdateTool()]
    payloads = [
        {"subject": "x"},
        {},
        {"taskId": TASK_ID},
        {"taskId": TASK_ID, "expectedRevision": 1, "action": "claim"},
    ]
    for tool, payload in zip(tools, payloads):
        result = await tool.execute(payload, _context())
        assert result["status"] == "error"
        assert result["code"] == "TEAM_TASK_CLIENT_UNAVAILABLE"


@pytest.mark.asyncio
async def test_non_callable_client_metadata_is_treated_as_unwired():
    context = _context()
    context.metadata[TEAM_TASK_CLIENT_KEY] = "not-callable"
    result = await TeamTaskListTool().execute({}, context)
    assert result["code"] == "TEAM_TASK_CLIENT_UNAVAILABLE"
