import asyncio
import hashlib
import json
from datetime import UTC, datetime, timedelta
from unittest.mock import AsyncMock

import pytest

from xihe_agent.adapters.approval_tool import (
    APPROVAL_EVENT_SINK_KEY,
    ApprovalAgentTool,
    ApprovalCoordinator,
    ApprovalExpiredError,
    ApprovalInput,
    ApprovalRejectedError,
    ApprovalTool,
    redact_approval_details,
)
from xihe_agent.interfaces.context import AgentContext


@pytest.fixture
def tool():
    return ApprovalTool()


def test_approval_tool_creation(tool):
    assert tool.name == "request_approval"
    assert "human approval" in tool.description
    assert tool.args_schema == ApprovalInput
    assert tool.pending_requests == {}
    assert tool.pending_payloads == {}
    assert tool.approval_results == {}


@pytest.mark.asyncio
async def test_approval_pending(tool):
    request_ids = []

    async def track_approval(tool, action, details):
        rid = tool.pending_requests
        result = await tool._arun(action=action, details=details)
        return result

    async def resolve_later(tool, action, details):
        import asyncio
        await asyncio.sleep(0.01)
        for rid, payload in list(tool.pending_payloads.items()):
            tool.resolve_approval(rid, True)

    import asyncio

    result = await asyncio.gather(
        track_approval(tool, "delete file", details="/tmp/test.txt"),
        resolve_later(tool, "delete file", details="/tmp/test.txt"),
    )

    pending = tool.get_pending()
    assert len(pending) == 0

    approved_result = result[0]
    assert "Approved" in approved_result


@pytest.mark.asyncio
async def test_approval_resolve(tool):
    import asyncio

    async def request_and_resolve():
        rid = list(tool.pending_requests.keys())
        result = await tool._arun(action="format disk", details="/dev/sda")
        return result

    async def do_resolve(tool):
        await asyncio.sleep(0.01)
        for rid in list(tool.pending_payloads.keys()):
            tool.resolve_approval(rid, True)

    result = await asyncio.gather(request_and_resolve(), do_resolve(tool))

    assert "Approved" in result[0]


@pytest.mark.asyncio
async def test_approval_rejection(tool):
    import asyncio

    async def request_and_resolve():
        result = await tool._arun(action="delete database")
        return result

    async def do_reject(tool):
        await asyncio.sleep(0.01)
        for rid in list(tool.pending_payloads.keys()):
            tool.resolve_approval(rid, False)

    result = await asyncio.gather(request_and_resolve(), do_reject(tool))

    assert "Rejected" in result[0]


def test_approval_already_resolved(tool):
    result = tool.resolve_approval("nonexistent-id", True)
    assert result is False


def test_approval_get_pending_returns_list(tool):
    pending = tool.get_pending()
    assert isinstance(pending, list)

    tool.pending_payloads["test-id"] = {
        "action": "restart service",
        "details": "nginx",
        "request_id": "test-id",
    }
    pending = tool.get_pending()
    assert len(pending) == 1
    assert pending[0]["action"] == "restart service"


@pytest.mark.asyncio
async def test_agent_approval_emits_canonical_event_before_waiting():
    import asyncio

    tool = ApprovalAgentTool(timeout_seconds=1)
    context = AgentContext.empty("session-1")
    context.metadata.update({"runId": "run-1", "sessionId": "session-1", "workspaceId": "workspace-1"})
    published = []

    async def publish(payload):
        published.append(payload)

    context.metadata["_approval_event_sink"] = publish
    request_task = asyncio.create_task(tool.execute({"action": "delete file", "details": "README.md"}, context))
    for _ in range(10):
        if published:
            break
        await asyncio.sleep(0)

    assert len(published) == 1
    payload = published[0]
    assert payload["requestId"] in tool.pending_requests
    assert payload["runId"] == "run-1"
    assert payload["sessionId"] == "session-1"
    assert payload["workspaceId"] == "workspace-1"
    assert payload["tool"] == "request_approval"
    assert payload["action"] == "delete file"
    assert payload["details"] == "README.md"
    assert payload["expiresAt"].endswith("Z")

    tool.resolve_approval(payload["requestId"], True)
    result = await request_task
    assert result["approval"] == "approved"
    assert "Approved" in result["content"]


@pytest.mark.asyncio
async def test_agent_approval_expires_fail_closed():
    import asyncio

    tool = ApprovalAgentTool(timeout_seconds=0.01)
    context = AgentContext.empty("session-expired")
    published = []

    async def publish(payload):
        published.append(payload)

    context.metadata["_approval_event_sink"] = publish
    with pytest.raises(ApprovalExpiredError):
        await tool.execute({"action": "rotate key"}, context)
    assert published[0]["requestId"] not in tool.pending_requests


@pytest.mark.asyncio
async def test_agent_approval_rejection_is_terminal():
    import asyncio

    tool = ApprovalAgentTool(timeout_seconds=1)
    context = AgentContext.empty("session-rejected")
    published = []

    async def publish(payload):
        published.append(payload)

    context.metadata["_approval_event_sink"] = publish
    request_task = asyncio.create_task(tool.execute({"action": "delete file"}, context))
    for _ in range(10):
        if published:
            break
        await asyncio.sleep(0)

    tool.resolve_approval(published[0]["requestId"], False)
    with pytest.raises(ApprovalRejectedError):
        await request_task


def _make_context(session_id: str, metadata: dict | None = None) -> AgentContext:
    context = AgentContext.empty(session_id)
    if metadata:
        context.metadata.update(metadata)
    return context


def _publishing_sink(published: list[dict]):
    async def publish(payload):
        published.append(payload)

    return publish


def _wait_for_published(published: list[dict], expected: int = 1):
    async def wait():
        for _ in range(100):
            if len(published) >= expected:
                return
            await asyncio.sleep(0)
        raise AssertionError(f"expected {expected} published events, got {len(published)}")

    return wait()


# ---------------------------------------------------------------------------
# Coordinator state machine: pending -> approved/rejected/expired
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_coordinator_pending_payload_is_preserved_and_resolves_approved():
    coordinator = ApprovalCoordinator(timeout_seconds=1)
    published: list[dict] = []
    context = _make_context(
        "session-state",
        {"runId": "run-1", "sessionId": "session-state", "workspaceId": "ws-1"},
    )

    request_task = asyncio.create_task(
        coordinator.request("delete file", "README.md", context, _publishing_sink(published))
    )
    await _wait_for_published(published)

    request_id = published[0]["requestId"]
    status = coordinator.get_status(request_id)
    assert status is not None
    assert status["status"] == "pending"
    assert status["tool"] == "request_approval"
    assert status["action"] == "delete file"
    assert status["details"] == "README.md"
    assert status["runId"] == "run-1"
    assert status["sessionId"] == "session-state"
    assert status["workspaceId"] == "ws-1"
    assert status["expiresAt"].endswith("Z")
    assert len(coordinator.get_pending()) == 1
    assert coordinator.get_pending()[0]["requestId"] == request_id

    resolved_status, decision = coordinator.resolve_status(request_id, True)
    assert (resolved_status, decision) == ("accepted", True)

    result = await request_task
    assert result == {
        "content": "Approved: delete file",
        "approval": "approved",
        "requestId": request_id,
    }

    completed = coordinator.get_status(request_id)
    assert completed is not None
    assert completed["status"] == "approved"
    assert completed["approved"] is True
    assert completed["action"] == "delete file"
    assert coordinator.get_pending() == []


@pytest.mark.asyncio
async def test_coordinator_reject_transition_preserves_payload_and_raises():
    coordinator = ApprovalCoordinator(timeout_seconds=1)
    published: list[dict] = []
    context = _make_context("session-reject-state")

    request_task = asyncio.create_task(
        coordinator.request("rm -rf", None, context, _publishing_sink(published))
    )
    await _wait_for_published(published)
    request_id = published[0]["requestId"]

    assert coordinator.resolve_status(request_id, False) == ("accepted", False)
    with pytest.raises(ApprovalRejectedError):
        await request_task

    completed = coordinator.get_status(request_id)
    assert completed is not None
    assert completed["status"] == "rejected"
    assert completed["approved"] is False
    assert completed["requestId"] == request_id


@pytest.mark.asyncio
async def test_coordinator_expiry_transitions_to_expired_and_raises():
    coordinator = ApprovalCoordinator(timeout_seconds=0.01)
    published: list[dict] = []
    context = _make_context("session-expiry-state")

    with pytest.raises(ApprovalExpiredError):
        await coordinator.request("rotate key", None, context, _publishing_sink(published))

    request_id = published[0]["requestId"]
    completed = coordinator.get_status(request_id)
    assert completed is not None
    assert completed["status"] == "expired"
    assert completed["approved"] is None
    assert completed["requestId"] == request_id
    assert coordinator.resolve_status(request_id, True) == ("expired", None)


# ---------------------------------------------------------------------------
# Duplicate decision idempotency
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_duplicate_same_decision_returns_already_decided_and_consistent_result():
    coordinator = ApprovalCoordinator(timeout_seconds=1)
    published: list[dict] = []
    context = _make_context("session-dup-approve")

    request_task = asyncio.create_task(
        coordinator.request("deploy", None, context, _publishing_sink(published))
    )
    await _wait_for_published(published)
    request_id = published[0]["requestId"]

    assert coordinator.resolve_status(request_id, True) == ("accepted", True)
    assert coordinator.resolve_status(request_id, True) == ("already_decided", True)
    assert coordinator.resolve_status(request_id, True) == ("already_decided", True)

    result = await request_task
    assert result["approval"] == "approved"

    # After completion the terminal outcome keeps reporting already_decided.
    assert coordinator.resolve_status(request_id, True) == ("already_decided", True)


@pytest.mark.asyncio
async def test_duplicate_same_rejection_is_idempotent_after_completion():
    coordinator = ApprovalCoordinator(timeout_seconds=1)
    published: list[dict] = []
    context = _make_context("session-dup-reject")

    request_task = asyncio.create_task(
        coordinator.request("drop table", None, context, _publishing_sink(published))
    )
    await _wait_for_published(published)
    request_id = published[0]["requestId"]

    assert coordinator.resolve_status(request_id, False) == ("accepted", False)
    with pytest.raises(ApprovalRejectedError):
        await request_task

    assert coordinator.resolve_status(request_id, False) == ("already_decided", False)
    assert coordinator.get_status(request_id)["status"] == "rejected"


# ---------------------------------------------------------------------------
# Conflicting decisions
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_opposite_decisions_report_conflict():
    coordinator = ApprovalCoordinator(timeout_seconds=1)
    published: list[dict] = []
    context = _make_context("session-conflict")

    request_task = asyncio.create_task(
        coordinator.request("scale cluster", None, context, _publishing_sink(published))
    )
    await _wait_for_published(published)
    request_id = published[0]["requestId"]

    status, decision = coordinator.resolve_status(request_id, True)
    assert (status, decision) == ("accepted", True)

    status, decision = coordinator.resolve_status(request_id, False)
    assert (status, decision) == ("conflict", True)

    result = await request_task
    assert result["approval"] == "approved"

    # Post-completion conflict still reports the recorded decision.
    assert coordinator.resolve_status(request_id, False) == ("conflict", True)


# ---------------------------------------------------------------------------
# Completed TTL: queryable within timeout, purged after timeout
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_completed_outcome_survives_within_ttl(monkeypatch):
    import xihe_agent.adapters.approval_tool as approval_module

    coordinator = ApprovalCoordinator(timeout_seconds=60)
    published: list[dict] = []
    context = _make_context("session-ttl")

    request_task = asyncio.create_task(
        coordinator.request("cleanup cache", None, context, _publishing_sink(published))
    )
    await _wait_for_published(published)
    request_id = published[0]["requestId"]

    coordinator.resolve_status(request_id, True)
    assert (await request_task)["approval"] == "approved"

    # Freeze just under the TTL boundary; outcome must remain queryable.
    just_before_expiry = coordinator.completed_at[request_id] + timedelta(seconds=59)
    frozen = _FrozenDatetime(just_before_expiry)
    monkeypatch.setattr(approval_module, "datetime", frozen)

    assert coordinator.get_status(request_id) is not None
    assert coordinator.get_pending() == []
    assert coordinator.resolve_status(request_id, True) == ("already_decided", True)


@pytest.mark.asyncio
async def test_completed_outcome_is_purged_after_ttl(monkeypatch):
    import xihe_agent.adapters.approval_tool as approval_module

    coordinator = ApprovalCoordinator(timeout_seconds=60)
    published: list[dict] = []
    context = _make_context("session-ttl-purge")

    request_task = asyncio.create_task(
        coordinator.request("cleanup cache", None, context, _publishing_sink(published))
    )
    await _wait_for_published(published)
    request_id = published[0]["requestId"]

    coordinator.resolve_status(request_id, True)
    await request_task

    after_expiry = coordinator.completed_at[request_id] + timedelta(seconds=61)
    monkeypatch.setattr(approval_module, "datetime", _FrozenDatetime(after_expiry))

    assert coordinator.get_status(request_id) is None
    assert coordinator.resolve_status(request_id, True) == ("not_found", None)


class _FrozenDatetime:
    """Instance that replaces ``datetime`` in approval_tool: now() is frozen, rest delegates."""

    def __init__(self, fixed_now: datetime) -> None:
        self._fixed_now = fixed_now

    def now(self, tz=None):
        if tz is not None:
            return self._fixed_now.astimezone(tz)
        return self._fixed_now

    def __getattr__(self, name):
        return getattr(datetime, name)


# ---------------------------------------------------------------------------
# Agent restart: fresh coordinator has no knowledge of prior requests
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_new_coordinator_instance_cannot_see_old_requests():
    first = ApprovalCoordinator(timeout_seconds=60)
    published_first: list[dict] = []
    context = _make_context("session-restart")

    request_task = asyncio.create_task(
        first.request("restart probe", None, context, _publishing_sink(published_first))
    )
    await _wait_for_published(published_first)
    request_id = published_first[0]["requestId"]
    first.resolve_status(request_id, True)
    await request_task

    restarted = ApprovalCoordinator(timeout_seconds=60)
    assert restarted.get_status(request_id) is None
    assert restarted.get_pending() == []
    assert restarted.resolve_status(request_id, True) == ("not_found", None)


# ---------------------------------------------------------------------------
# Event sink isolation
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_request_without_sink_raises_and_leaves_no_pending():
    coordinator = ApprovalCoordinator(timeout_seconds=1)
    context = _make_context("session-no-sink")

    with pytest.raises(RuntimeError, match="could not be delivered"):
        await coordinator.request("delete file", None, context, None)

    assert coordinator.get_pending() == []
    assert coordinator.pending_requests == {}
    assert coordinator.pending_payloads == {}


@pytest.mark.asyncio
async def test_non_callable_sink_is_treated_as_none():
    tool = ApprovalAgentTool(timeout_seconds=1)
    context = _make_context("session-bad-sink", {APPROVAL_EVENT_SINK_KEY: "not-callable"})

    with pytest.raises(RuntimeError, match="could not be delivered"):
        await tool.execute({"action": "delete file"}, context)

    assert tool.get_pending() == []
    assert tool.coordinator.pending_requests == {}


# ---------------------------------------------------------------------------
# Reject -> no downstream tool: coordinator gains no new pending after rejection
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_reject_raises_and_produces_no_new_pending():
    coordinator = ApprovalCoordinator(timeout_seconds=1)
    published: list[dict] = []
    context = _make_context("session-no-downstream")

    request_task = asyncio.create_task(
        coordinator.request("delete file", None, context, _publishing_sink(published))
    )
    await _wait_for_published(published)
    request_id = published[0]["requestId"]

    coordinator.resolve_status(request_id, False)
    with pytest.raises(ApprovalRejectedError):
        await request_task

    assert coordinator.get_pending() == []
    assert coordinator.pending_requests == {}
    assert coordinator.pending_payloads == {}


# ---------------------------------------------------------------------------
# Publish-before-wait ordering
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_event_sink_is_called_before_entering_wait():
    coordinator = ApprovalCoordinator(timeout_seconds=1)
    context = _make_context("session-order")

    order: list[str] = []

    async def recording_sink(payload):
        order.append("publish")

    waiting_sink = AsyncMock(side_effect=recording_sink)
    request_task = asyncio.create_task(coordinator.request("delete file", None, context, waiting_sink))

    for _ in range(100):
        if waiting_sink.call_count:
            break
        await asyncio.sleep(0)

    assert waiting_sink.call_count == 1
    assert order == ["publish"]

    # The request is registered as pending (waiting) only after the sink ran.
    request_id = waiting_sink.call_args.args[0]["requestId"]
    assert request_id in coordinator.pending_requests
    assert coordinator.get_status(request_id)["status"] == "pending"

    coordinator.resolve_status(request_id, True)
    result = await request_task
    assert result["approval"] == "approved"
    assert waiting_sink.await_count == 1


# --- PLAN-292 M1: canonical arguments hash (CP grant matching) ---

def test_canonical_hash_matches_cp_vector():
    """Cross-language fixture: the hash below is asserted by the CP test
    ApprovalServiceTest.consumeApprovedGrantCrossLanguageCanonicalVector,
    which recomputes it with Jackson (ORDER_MAP_ENTRIES_BY_KEYS + compact).
    If this hash changes, both suites must change in the same commit."""
    wrapper = {
        "tool": "write_file",
        "arguments": {
            "path": "notes/大文件.md",
            "content": '中文内容 line1\nline2 "quoted"',
            "mode": "overwrite",
            "size": 1234,
            "flag": True,
            "nested": {"b": 1, "a": [1, 2, "x"], "e": "", "d": None},
        },
    }
    details = json.dumps(wrapper, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    preview, arguments_hash = redact_approval_details(details)
    assert arguments_hash == "827e3965b8f623f5722f1ba4f8a29dd38fce8d661b92e386d27502a4fa2a7c27"
    assert preview == details


def test_canonical_hash_is_input_format_independent():
    """Same logical object, different key order / spacing -> same hash."""
    compact = json.dumps(
        {"tool": "write_file", "arguments": {"path": "a.md", "content": "hi"}},
        ensure_ascii=False, sort_keys=True, separators=(",", ":"),
    )
    spaced = json.dumps(
        {"arguments": {"content": "hi", "path": "a.md"}, "tool": "write_file"},
        ensure_ascii=False, indent=2,
    )
    _, hash_compact = redact_approval_details(compact)
    _, hash_spaced = redact_approval_details(spaced)
    assert hash_compact == hash_spaced


def test_hash_covers_full_arguments_beyond_preview_limit():
    """PLAN-292 H1 regression: >500-char arguments must hash the FULL canonical
    form so CP can match after preview truncation."""
    big_content = "x" * 2000
    details = json.dumps(
        {"tool": "write_file", "arguments": {"path": "big.md", "content": big_content}},
        ensure_ascii=False, sort_keys=True, separators=(",", ":"),
    )
    preview, arguments_hash = redact_approval_details(details)
    assert preview.endswith("…[truncated]")
    full_hash = hashlib.sha256(details.encode("utf-8")).hexdigest()
    assert arguments_hash == full_hash
    truncated_hash = hashlib.sha256(
        (details[:500] + "…[truncated]").encode("utf-8")
    ).hexdigest()
    assert arguments_hash != truncated_hash
