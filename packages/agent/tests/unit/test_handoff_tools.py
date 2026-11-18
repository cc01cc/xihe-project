"""task-40 §3 batch 2 (L0): the two name-based hand-off faces and their CP transport.

What these tests defend (each one is a real failure mode, not a shape check):

* the gray seam: no XIHE_CP_URL / no runId ⇒ the tools answer HANDOFF_CLIENT_UNAVAILABLE instead of
  inventing an endpoint or raising through the model;
* a display name the roster does not know is a **refusal the model can act on** (mention_unresolved +
  a hint to read the roster), not a transport error it will retry blindly;
* the idempotency key is a function of (run, target, instruction) — a replay is a replay, a changed
  audience is a new submission (same rule as the composer);
* the two faces stay separate: dispatch carries no cc field, so the model is never asked to guess
  whether it is assigning work or copying somebody.
"""

from types import SimpleNamespace

import httpx
import pytest

from xihe_agent.adapters.handoff_tools import (
    CODE_CLIENT_UNAVAILABLE,
    HANDOFF_CLIENT_KEY,
    TOOL_DISPATCH,
    TOOL_LIST_PARTICIPANTS,
    DispatchAgentTaskTool,
    ListSessionParticipantsTool,
)
from xihe_agent.agent_runner.handoff_client import (
    CODE_TRANSPORT,
    HandoffClientError,
    build_handoff_client,
    resolve_cp_base_url,
)

RUN_ID = "30717d9c-3eb9-4759-a330-06a37d5ce9cd"
CP = "http://cp.test"


def _context(run_id: str | None = RUN_ID, client=None):
    metadata = {}
    if run_id is not None:
        metadata["runId"] = run_id
    if client is not None:
        metadata[HANDOFF_CLIENT_KEY] = client
    return SimpleNamespace(metadata=metadata)


def _client(run_id: str | None = RUN_ID):
    return build_handoff_client(_context(run_id), environ={"XIHE_CP_URL": CP}, api_token="tok")


# ── gray seam ────────────────────────────────────────────────────────────────────────────────────


def test_base_url_gate_requires_an_explicit_cp(monkeypatch=None):
    assert resolve_cp_base_url({}) is None
    assert resolve_cp_base_url({"XIHE_CP_URL": "   "}) is None
    assert resolve_cp_base_url({"XIHE_CP_URL": CP + "/"}) == CP


def test_builder_stays_unwired_without_cp_or_run():
    assert build_handoff_client(_context(), environ={}, api_token="tok") is None
    assert build_handoff_client(_context(run_id=None), environ={"XIHE_CP_URL": CP}) is None


@pytest.mark.asyncio
async def test_faces_answer_unavailable_when_the_client_is_absent():
    for tool in (ListSessionParticipantsTool(), DispatchAgentTaskTool()):
        result = await tool.execute({"target_display_name": "ewLead", "instruction": "x"}, _context(client=None))
        assert result["status"] == "error"
        assert result["code"] == CODE_CLIENT_UNAVAILABLE


def test_the_two_faces_are_separate_and_dispatch_has_no_cc_field():
    roster = ListSessionParticipantsTool().spec
    dispatch = DispatchAgentTaskTool().spec
    assert roster.name != dispatch.name
    schema = dispatch.input_schema
    assert set(schema["properties"]) == {"target_display_name", "instruction"}
    # CC 语义不许混进「派活」：模型不该从同一个口里判断是指派还是抄送
    assert not any("cc" in key.lower() for key in schema["properties"])


# ── transport ───────────────────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_roster_read_maps_display_names(httpx_mock):
    httpx_mock.add_response(
        method="GET",
        url=f"{CP}/internal/v1/chat/runs/{RUN_ID}/participants",
        json={
            "runId": RUN_ID,
            "participants": [
                {
                    "participantId": "p1",
                    "displayName": "ewLead",
                    "principalKind": "AGENT",
                    "role": "PRIMARY",
                    "respondPolicy": "respond",
                    "disabled": False,
                },
                {
                    "participantId": "p2",
                    "displayName": "owner",
                    "principalKind": "HUMAN",
                    "role": "PRIMARY",
                    "respondPolicy": "respond",
                    "disabled": True,
                },
            ],
        },
    )
    result = await _client()(TOOL_LIST_PARTICIPANTS, {})
    assert result["status"] == "ok"
    assert [peer["display_name"] for peer in result["participants"]] == ["ewLead", "owner"]
    assert result["participants"][1]["disabled"] is True


@pytest.mark.asyncio
async def test_dispatch_reports_the_woken_run_and_the_announced_line(httpx_mock):
    httpx_mock.add_response(
        method="POST",
        url=f"{CP}/internal/v1/chat/runs/{RUN_ID}/to",
        json={
            "runId": RUN_ID,
            "roundId": f"wake:to:agent:{RUN_ID}",
            "messageId": "message-1",
            "to": {
                "requested": 1,
                "runIds": ["child-run"],
                "failedTargets": [],
                "deferredTargets": [],
                "notifiedTargets": [],
                "suppressedTargets": [],
            },
            "cc": {"notified": [], "ignored": []},
        },
    )
    result = await _client()(TOOL_DISPATCH, {"target_display_name": "ewLead", "instruction": "核对读数"})
    assert result["status"] == "ok"
    assert result["dispatched_runs"] == 1
    assert result["announced"] is True
    import json

    body = json.loads(httpx_mock.get_requests()[0].content)
    assert body["toDisplayNames"] == ["ewLead"]
    assert "ccDisplayNames" not in body or body["ccDisplayNames"] == []


@pytest.mark.asyncio
async def test_unresolved_name_is_a_model_actionable_refusal_not_a_transport_error(httpx_mock):
    httpx_mock.add_response(
        method="POST",
        url=f"{CP}/internal/v1/chat/runs/{RUN_ID}/to",
        status_code=422,
        json={
            "code": "HANDOFF_TARGETS_REQUIRED",
            "detail": "unresolved=@GhostWriterZ, reason=mention_unresolved",
        },
    )
    result = await _client()(TOOL_DISPATCH, {"target_display_name": "@GhostWriterZ", "instruction": "转达"})
    assert result["status"] == "refused"
    assert result["reason"] == "mention_unresolved"
    assert TOOL_LIST_PARTICIPANTS in result["hint"]


@pytest.mark.asyncio
async def test_other_refusals_keep_their_cp_code(httpx_mock):
    httpx_mock.add_response(
        method="POST",
        url=f"{CP}/internal/v1/chat/runs/{RUN_ID}/to",
        status_code=409,
        json={"code": "HANDOFF_RUN_NOT_ACTIVE", "detail": "Run is terminal"},
    )
    with pytest.raises(HandoffClientError) as failure:
        await _client()(TOOL_DISPATCH, {"target_display_name": "ewLead", "instruction": "x"})
    assert failure.value.code == "HANDOFF_RUN_NOT_ACTIVE"


@pytest.mark.asyncio
async def test_transport_failure_is_reported_with_its_own_code(httpx_mock):
    httpx_mock.add_exception(httpx.ConnectError("boom"))
    with pytest.raises(HandoffClientError) as failure:
        await _client()(TOOL_LIST_PARTICIPANTS, {})
    assert failure.value.code == CODE_TRANSPORT


@pytest.mark.asyncio
async def test_idempotency_key_is_stable_per_audience_and_text(httpx_mock):
    def respond(request):
        return httpx.Response(
            200,
            json={
                "runId": RUN_ID,
                "roundId": "r",
                "messageId": "m",
                "to": {
                    "requested": 1,
                    "runIds": ["child"],
                    "failedTargets": [],
                    "deferredTargets": [],
                    "notifiedTargets": [],
                    "suppressedTargets": [],
                },
                "cc": {"notified": [], "ignored": []},
            },
        )

    httpx_mock.add_callback(respond, method="POST", url=f"{CP}/internal/v1/chat/runs/{RUN_ID}/to", is_reusable=True)
    client = _client()
    await client(TOOL_DISPATCH, {"target_display_name": "ewLead", "instruction": "同一件事"})
    await client(TOOL_DISPATCH, {"target_display_name": "ewLead", "instruction": "同一件事"})
    await client(TOOL_DISPATCH, {"target_display_name": "otherLead", "instruction": "同一件事"})
    keys = [request.headers["Idempotency-Key"] for request in httpx_mock.get_requests()]
    assert keys[0] == keys[1], "重放同一调用必须幂等"
    assert keys[2] != keys[0], "换受众就是换一次提交"
