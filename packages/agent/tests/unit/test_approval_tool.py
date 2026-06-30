import pytest

from xihe_agent.adapters.approval_tool import ApprovalInput, ApprovalTool


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
