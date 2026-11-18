"""task-188 MVP⑤ S2 (L0): the runtime wiring of the team-task client callable.

Three frozen assertions at the assembly point (langgraph_runner.stream, the same
block that injects the approval/question sinks):
1. CP configured (XIHE_CP_URL) ⇒ metadata[TEAM_TASK_CLIENT_KEY] is a callable
   during the run, and is popped again in the finally cleanup;
2. CP not configured ⇒ the key stays absent — the four tools answer
   TEAM_TASK_CLIENT_UNAVAILABLE, exactly the pre-wiring behavior (G3-a 灰度);
3. assembly failure ⇒ same absent-key behavior, and the run itself is unaffected.

Plus the callable's own contract tests with a stubbed MCPClientManager (no real
stack): flat CP row → {"task": row}, list passthrough, is_error → a .code-
carrying raise that the coordinator passes through verbatim, transport errors
propagate un-reclassified, and a missing structuredContent is TEAM_TASK_PROTOCOL.
"""

from types import SimpleNamespace

import pytest
from langchain_core.messages import AIMessage

import xihe_agent.agent_runner.langgraph_runner as langgraph_runner_module
import xihe_agent.agent_runner.team_task_client as team_task_client_module
from xihe_agent.adapters.team_task_tools import (
    TEAM_TASK_CLIENT_KEY,
    TeamTaskUpdateTool,
)
from xihe_agent.agent_runner import LangGraphRunner
from xihe_agent.agent_runner.team_task_client import (
    CODE_PROTOCOL,
    TeamTaskMcpError,
    build_team_task_client,
    resolve_team_task_mcp_url,
)
from xihe_agent.interfaces.agent_runner import RunnerConfig
from xihe_agent.interfaces.context import AgentContext
from xihe_agent.interfaces.message import TextMessage

TASK_ID = "2d3f6f8e-7f1b-4f5a-9c3d-7f1b4f5a9c3d"


def _row(**overrides):
    row = {
        "taskId": TASK_ID,
        "teamRootSessionId": "root-session",
        "taskNo": 7,
        "revision": 3,
        "subject": "Wire the board client",
        "description": "runtime assembly",
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


def _llm_usage_event(run_id: str, total_tokens: int = 2) -> dict:
    return {
        "event": "on_chat_model_end",
        "name": "model",
        "run_id": run_id,
        "data": {
            "output": AIMessage(
                content="",
                usage_metadata={
                    "input_tokens": total_tokens // 2,
                    "output_tokens": total_tokens - total_tokens // 2,
                    "total_tokens": total_tokens,
                },
            )
        },
    }


async def _collect(runner: LangGraphRunner, config: RunnerConfig) -> list:
    return [event async for event in runner.stream([TextMessage(role="human", content="hi")], config)]


def _context() -> AgentContext:
    context = AgentContext.empty("session-1")
    context.metadata.update(
        {"runId": "run-1", "sessionId": "session-1", "workspaceId": "workspace-1"}
    )
    return context


class _StubManager:
    """Records construction + call_tool; answers a scripted result or raise."""

    instances: list = []
    result = None
    error: Exception | None = None

    def __init__(self, **kwargs):
        self.kwargs = kwargs
        self.calls: list = []
        _StubManager.instances.append(self)

    async def call_tool(self, name, arguments, headers):
        self.calls.append((name, arguments, headers))
        if _StubManager.error is not None:
            raise _StubManager.error
        return _StubManager.result

    @classmethod
    def reset(cls):
        cls.instances = []
        cls.result = None
        cls.error = None


@pytest.fixture
def stub_manager(monkeypatch):
    _StubManager.reset()
    monkeypatch.setattr(team_task_client_module, "MCPClientManager", _StubManager)
    return _StubManager


def _ok_result(structured, is_error=False, text=""):
    return SimpleNamespace(structured_content=structured, is_error=is_error, content=[])


# -- gray-release gate ------------------------------------------------------------------------


def test_resolve_url_gate_requires_explicit_cp_url():
    assert resolve_team_task_mcp_url({}) is None
    assert resolve_team_task_mcp_url({"XIHE_CP_URL": "   "}) is None
    assert (
        resolve_team_task_mcp_url({"XIHE_CP_URL": "http://cp:12631"})
        == "http://cp:12631/api/v1/mcp"
    )
    # trailing slash must not double the path
    assert (
        resolve_team_task_mcp_url({"XIHE_CP_URL": "http://cp:12631/"})
        == "http://cp:12631/api/v1/mcp"
    )


# -- assembly point (runner) --------------------------------------------------------------------


@pytest.mark.asyncio
async def test_runner_injects_client_when_cp_configured(monkeypatch):
    seen: list = []

    class FakeAgent:
        async def astream_events(self, _inputs, version, **kwargs):
            client = context.metadata.get(TEAM_TASK_CLIENT_KEY)
            seen.append(client)
            yield _llm_usage_event("m0")

    monkeypatch.setenv("XIHE_CP_URL", "http://cp:12631")
    monkeypatch.setattr(team_task_client_module, "_resolve_api_token", lambda: "token-1")
    monkeypatch.setattr(langgraph_runner_module, "build_react_graph", lambda _model, tools, **_kwargs: FakeAgent())
    context = _context()
    runner = LangGraphRunner(model_factory=lambda _model: object())
    config = RunnerConfig(model="fake", system_prompt="", tools=[], context=context)

    await _collect(runner, config)

    assert len(seen) == 1 and callable(seen[0])
    # finally cleanup pops the run-scoped callable with the sinks
    assert TEAM_TASK_CLIENT_KEY not in context.metadata


@pytest.mark.asyncio
async def test_runner_skips_injection_when_cp_unconfigured(monkeypatch):
    seen: list = []

    class FakeAgent:
        async def astream_events(self, _inputs, version, **kwargs):
            seen.append(context.metadata.get(TEAM_TASK_CLIENT_KEY))
            yield _llm_usage_event("m0")

    monkeypatch.delenv("XIHE_CP_URL", raising=False)
    monkeypatch.setattr(langgraph_runner_module, "build_react_graph", lambda _model, tools, **_kwargs: FakeAgent())
    context = _context()
    runner = LangGraphRunner(model_factory=lambda _model: object())
    config = RunnerConfig(model="fake", system_prompt="", tools=[], context=context)

    await _collect(runner, config)

    assert seen == [None]
    assert TEAM_TASK_CLIENT_KEY not in context.metadata


@pytest.mark.asyncio
async def test_runner_skips_injection_when_assembly_fails(monkeypatch):
    """构造失败（如令牌解析挂）不拖垮 run——灰度：不注入 = 今天行为。"""

    class FakeAgent:
        async def astream_events(self, _inputs, version, **kwargs):
            seen.append(context.metadata.get(TEAM_TASK_CLIENT_KEY))
            yield _llm_usage_event("m0")

    seen: list = []
    monkeypatch.setenv("XIHE_CP_URL", "http://cp:12631")

    def _boom():
        raise RuntimeError("token resolution unavailable")

    monkeypatch.setattr(team_task_client_module, "_resolve_api_token", _boom)
    monkeypatch.setattr(langgraph_runner_module, "build_react_graph", lambda _model, tools, **_kwargs: FakeAgent())
    context = _context()
    runner = LangGraphRunner(model_factory=lambda _model: object())
    config = RunnerConfig(model="fake", system_prompt="", tools=[], context=context)

    await _collect(runner, config)

    assert seen == [None]
    assert TEAM_TASK_CLIENT_KEY not in context.metadata


# -- callable contract (stubbed transport) ------------------------------------------------------


@pytest.mark.asyncio
async def test_client_wraps_flat_row_as_task(stub_manager):
    stub_manager.result = _ok_result(_row())
    context = _context()
    client = build_team_task_client(
        context, environ={"XIHE_CP_URL": "http://cp:12631"}, api_token="token-1"
    )
    assert client is not None

    result = await client("team_task_create", {"subject": "Wire the board client"})

    assert result == {"task": _row()}
    manager = stub_manager.instances[0]
    assert manager.kwargs["cp_url"] == "http://cp:12631/api/v1/mcp"
    assert manager.kwargs["workspace_id"] == "workspace-1"
    assert manager.kwargs["api_token"] == "token-1"
    name, arguments, headers = manager.calls[0]
    assert name == "team_task_create"
    assert arguments == {"subject": "Wire the board client"}
    # per-call identity headers are read at call time from the run context
    assert headers["X-Session-Id"] == "session-1"
    assert headers["X-Chat-Run-Id"] == "run-1"


@pytest.mark.asyncio
async def test_client_passes_list_shape_through(stub_manager):
    stub_manager.result = _ok_result({"tasks": [_row(), _row(taskNo=8)]})
    client = build_team_task_client(
        _context(), environ={"XIHE_CP_URL": "http://cp:12631"}, api_token="t"
    )

    result = await client("team_task_list", {})

    assert result == {"tasks": [_row(), _row(taskNo=8)]}


@pytest.mark.asyncio
async def test_client_raises_cp_code_verbatim_on_is_error(stub_manager):
    stub_manager.result = _ok_result({"code": "TEAM_TASK_CONFLICT"}, is_error=True)
    client = build_team_task_client(
        _context(), environ={"XIHE_CP_URL": "http://cp:12631"}, api_token="t"
    )

    with pytest.raises(TeamTaskMcpError) as err:
        await client("team_task_update", {"taskId": TASK_ID})

    assert err.value.code == "TEAM_TASK_CONFLICT"

    # the coordinator passes the code through un-reclassified
    async def _raising_client(tool_name, arguments):
        raise err.value

    context = _context()
    context.metadata[TEAM_TASK_CLIENT_KEY] = _raising_client
    result = await TeamTaskUpdateTool().execute(
        {"taskId": TASK_ID, "expectedRevision": 3, "action": "complete"}, context
    )
    envelope = result["content"]
    assert '"code":"TEAM_TASK_CONFLICT"' in envelope
    assert "TEAM_TASK_TRANSPORT" not in envelope


@pytest.mark.asyncio
async def test_client_propagates_transport_errors(stub_manager):
    stub_manager.error = ConnectionError("cp unreachable")
    client = build_team_task_client(
        _context(), environ={"XIHE_CP_URL": "http://cp:12631"}, api_token="t"
    )

    with pytest.raises(ConnectionError):
        await client("team_task_get", {"taskId": TASK_ID})

    # through the tool edge an unrecognised failure is TEAM_TASK_TRANSPORT
    async def _failing_client(tool_name, arguments):
        raise ConnectionError("cp unreachable")

    context = _context()
    context.metadata[TEAM_TASK_CLIENT_KEY] = _failing_client
    result = await TeamTaskUpdateTool().execute(
        {"taskId": TASK_ID, "expectedRevision": 3, "action": "complete"}, context
    )
    assert '"code":"TEAM_TASK_TRANSPORT"' in result["content"]


@pytest.mark.asyncio
async def test_client_reports_missing_structured_content_as_protocol(stub_manager):
    stub_manager.result = _ok_result(None)
    client = build_team_task_client(
        _context(), environ={"XIHE_CP_URL": "http://cp:12631"}, api_token="t"
    )

    with pytest.raises(TeamTaskMcpError) as err:
        await client("team_task_get", {"taskId": TASK_ID})

    assert err.value.code == CODE_PROTOCOL
