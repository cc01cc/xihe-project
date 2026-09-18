"""Tests for xihe_agent.agent_runner.langgraph_runner."""

import asyncio
import json
from datetime import UTC
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from langchain_core.messages import ToolMessage

import xihe_agent.agent_runner.langgraph_runner as langgraph_runner_module
from xihe_agent.adapters.approval_tool import ApprovalAgentTool
from xihe_agent.adapters.sse_adapter import LangGraphEventAdapter
from xihe_agent.agent_runner import LangGraphRunner
from xihe_agent.context.diagnostics import get_diagnostics_ledger
from xihe_agent.interfaces.agent_runner import AgentEvent, RunnerConfig
from xihe_agent.interfaces.context import AgentContext, ContextEpoch
from xihe_agent.interfaces.event_adapter import EventAdapter
from xihe_agent.interfaces.message import TextMessage
from xihe_agent.interfaces.tool import ToolSpec
from xihe_agent.llm.base import MockChatModel, create_llm

LCToolAdapter = langgraph_runner_module.LCToolAdapter


class FakeTool:
    """Minimal BaseAgentTool implementation for unit tests."""

    def __init__(self, name: str = "fake_tool"):
        self._spec = ToolSpec(
            name=name,
            description="A fake tool",
            input_schema={
                "type": "object",
                "properties": {"query": {"type": "string"}},
                "required": ["query"],
            },
        )

    @property
    def spec(self) -> ToolSpec:
        return self._spec

    async def execute(self, input: dict, context: dict) -> dict:
        return {"content": f"result for {input.get('query', '')}"}


class FakeCommandTool:
    """Fake `execute_command` tool returning a canned Runtime CommandResult."""

    def __init__(self, payload: str, name: str = "execute_command"):
        self._spec = ToolSpec(
            name=name,
            description="Execute a shell command",
            input_schema={
                "type": "object",
                "properties": {
                    "command": {"type": "string"},
                    "args": {"type": "array", "items": {"type": "string"}},
                },
                "required": ["command"],
            },
        )
        self._payload = payload

    @property
    def spec(self) -> ToolSpec:
        return self._spec

    async def execute(self, input: dict, context: dict) -> dict:
        return {"content": self._payload}


def _command_result(exit_code: int, stdout: str = "", stderr: str = "") -> str:
    return json.dumps(
        {
            "exit_code": exit_code,
            "stdout": stdout,
            "stderr": stderr,
            "success": exit_code == 0,
            "artifact_id": None,
        }
    )


@pytest.fixture(autouse=True)
def _reset_diagnostics_ledger():
    """PLAN-0342: keep the process-level session ledger isolated per test."""
    get_diagnostics_ledger().reset()
    yield
    get_diagnostics_ledger().reset()


@pytest.mark.asyncio
async def test_langgraph_runner_stream_yields_agent_events():
    runner = LangGraphRunner(model_factory=lambda _model: create_llm())
    config = RunnerConfig(
        model="mock",
        system_prompt="test",
        tools=[FakeTool()],
    )
    messages = [TextMessage(role="human", content="Hello")]

    events = []
    async for event in runner.stream(messages, config):
        events.append(event)

    assert len(events) > 0
    assert all(isinstance(e, AgentEvent) for e in events)
    token_events = [e for e in events if e.type == "token"]
    assert len(token_events) > 0


@pytest.mark.asyncio
async def test_langgraph_runner_uses_custom_event_adapter():
    class CustomAdapter(EventAdapter):
        def translate(self, raw_event: dict):
            if raw_event.get("event") == "on_chat_model_stream":
                return AgentEvent(type="token", data={"content": "custom"})
            return None

    runner = LangGraphRunner(
        model_factory=lambda _model: create_llm(),
        event_adapter=CustomAdapter(),
    )
    config = RunnerConfig(model="mock", system_prompt="test", tools=[])
    messages = [TextMessage(role="human", content="Hello")]

    events = []
    async for event in runner.stream(messages, config):
        events.append(event)

    assert all(
        e.type == "token" and e.data.get("content") == "custom"
        for e in events
        if e.type != "usage"
    )
    assert any(e.type == "usage" for e in events)


@pytest.mark.asyncio
async def test_langgraph_runner_default_adapter_is_langgraph_adapter():
    runner = LangGraphRunner(model_factory=lambda _model: create_llm())
    assert isinstance(runner._event_adapter, LangGraphEventAdapter)


@pytest.mark.asyncio
async def test_prompt_event_uses_timezone_aware_utc_timestamp():
    event_store = MagicMock()
    event_store.append = AsyncMock()
    runner = LangGraphRunner(
        model_factory=lambda _model: create_llm(),
        event_store=event_store,
    )

    await runner._append_prompt_admitted(
        [TextMessage(role="human", content="Hello")],
        AgentContext.empty("session-1"),
    )

    event = event_store.append.await_args.args[0]
    assert event.created_at.tzinfo is UTC
    assert event.created_at.utcoffset().total_seconds() == 0


@pytest.mark.asyncio
async def test_runner_fans_in_approval_event_before_blocked_tool_completes(monkeypatch):
    approval_tool = ApprovalAgentTool(timeout_seconds=1)

    class FakeAgent:
        def __init__(self, tools):
            self.tools = tools

        def astream_events(self, _inputs, version):
            assert version == "v2"
            adapted_tool = self.tools[0]

            async def events():
                yield {
                    "event": "on_tool_start",
                    "name": "request_approval",
                    "data": {"input": {"action": "delete file"}},
                    "run_id": "tool-run",
                }
                request_task = asyncio.create_task(adapted_tool._arun(action="delete file"))
                while not approval_tool.pending_payloads:
                    await asyncio.sleep(0)
                result = await request_task
                yield {
                    "event": "on_tool_end",
                    "name": "request_approval",
                    "data": {"output": result},
                    "run_id": "tool-run",
                }
                yield {"event": "on_chain_end", "name": "LangGraph", "data": {}, "run_id": "graph-run"}

            return events()

    monkeypatch.setattr(
        langgraph_runner_module,
        "create_react_agent",
        lambda _model, tools: FakeAgent(tools),
    )
    runner = LangGraphRunner(model_factory=lambda _model: object())
    context = AgentContext.empty("session-1")
    context.metadata.update({"runId": "run-1", "sessionId": "session-1", "workspaceId": "workspace-1"})

    received = []
    async for event in runner.stream(
        [TextMessage(role="human", content="delete the file")],
        RunnerConfig(model="fake", system_prompt="", tools=[approval_tool], context=context),
    ):
        received.append(event)
        if event.type == "approval_request":
            approval_tool.resolve_approval(event.data["requestId"], True)

    types = [event.type for event in received]
    # PLAN-0326 决策 #8：审批原语的 tool_call/tool_result 事件被抑制（其正规记录 =
    # 审批项），只保留 approval_request 事件本身；"先于工具放行"的语义由
    # approval_request 出现即代表阻塞成立来保证。
    assert "approval_request" in types
    assert "tool_result" not in types
    assert received[types.index("approval_request")].data["runId"] == "run-1"


def test_system_messages_inject_baseline_and_append_epoch_summary():
    """PLAN-0307 T2.19 (decision #28): baseline is never compressed; summary appends."""
    runner = LangGraphRunner(model_factory=lambda _model: create_llm())
    config = RunnerConfig(model="mock", system_prompt="BASELINE-INSTRUCTIONS", tools=[])
    context = AgentContext(
        aggregate_id="session-1",
        epoch=ContextEpoch(
            epoch_id="epoch-1",
            baseline_hash="hash-1",
            system_messages=["Conversation summary of compacted history:", "SUMMARY"],
        ),
    )

    messages = runner._build_system_messages(config, context)

    assert [m.content for m in messages] == [
        "BASELINE-INSTRUCTIONS",
        # PLAN-0340: L1b env always present (semi-trusted facts).
        next(m.content for m in messages if "Workspace environment" in m.content),
        "Conversation summary of compacted history:",
        "SUMMARY",
    ]


def test_system_messages_without_epoch_only_baseline():
    runner = LangGraphRunner(model_factory=lambda _model: create_llm())
    config = RunnerConfig(model="mock", system_prompt="BASELINE", tools=[])

    messages = runner._build_system_messages(config, AgentContext.empty("s"))

    assert messages[0].content == "BASELINE"
    assert any("Workspace environment" in m.content for m in messages)


def test_system_messages_warn_when_baseline_missing_with_summary():
    runner = LangGraphRunner(model_factory=lambda _model: create_llm())
    config = RunnerConfig(model="mock", system_prompt="", tools=[])
    context = AgentContext.empty("s").set_epoch(
        ContextEpoch(epoch_id="e", baseline_hash="h", system_messages=["SUMMARY"])
    )

    with patch.object(langgraph_runner_module.logger, "warning") as warn:
        messages = runner._build_system_messages(config, context)

    contents = [m.content for m in messages]
    assert "SUMMARY" in contents
    assert any("Workspace environment" in c for c in contents)
    assert warn.called


# ── PLAN-0308 M1 收尾：MCP 工具参数类型映射（冒烟抓出的缺陷） ──────────────────


def test_args_schema_maps_json_types_and_validates_numeric_args():
    """非字符串参数（integer/array/union）不得被校验层拒绝。

    缺陷复现（修复前）：所有字段一律 `str`，pydantic v2 不再隐式把数字转字符串，
    `execute_command {command, timeout: 90}` 校验失败 → LangGraph 吞成 ToolMessage，
    工具从未执行而 run 仍报 success。
    """
    spec = ToolSpec(
        name="execute_command",
        description="Execute a shell command",
        input_schema={
            "type": "object",
            "properties": {
                "command": {"type": "string"},
                "args": {"type": "array", "items": {"type": "string"}, "default": []},
                "timeout": {"type": ["integer", "null"], "minimum": 0},
                "truncate_limit": {"anyOf": [{"type": "integer"}, {"type": "null"}]},
                "flag": {"type": "boolean"},
            },
            "required": ["command"],
        },
    )

    schema = langgraph_runner_module._build_args_schema(spec)
    model = schema(command="sleep 45", timeout=90, args=["x"], flag=True)

    assert model.command == "sleep 45"
    assert model.timeout == 90
    assert model.args == ["x"]
    assert model.flag is True
    assert model.truncate_limit is None


def test_args_schema_keeps_string_fields_strict_for_numbers():
    """字符串字段仍不接受数字（保持原有的失败可见性，不回归成静默强转）。"""
    spec = ToolSpec(
        name="write_file",
        description="write",
        input_schema={
            "type": "object",
            "properties": {"path": {"type": "string"}},
            "required": ["path"],
        },
    )

    with pytest.raises(Exception):
        langgraph_runner_module._build_args_schema(spec)(path=123)


def test_args_schema_accepts_numeric_strings_for_integer_fields():
    """宽松模式：LLM 常把数字发成字符串，integer 字段应接受 "90"。"""
    spec = ToolSpec(
        name="read_file_range",
        description="read",
        input_schema={
            "type": "object",
            "properties": {"offset": {"type": "integer"}},
            "required": ["offset"],
        },
    )

    assert langgraph_runner_module._build_args_schema(spec)(offset="90").offset == 90


# ── PLAN-0342 M1：诊断回灌接线（artifact / 信封 / 去重 / 触发边界） ──────────


def test_lc_tool_adapter_response_format_is_content_and_artifact():
    """契约钉：结构化诊断经 ToolMessage artifact 通道，不进模型 wire。"""
    adapter = LCToolAdapter(FakeTool(), AgentContext.empty("session-diag-format"), None)
    assert adapter.response_format == "content_and_artifact"
    assert LCToolAdapter.model_fields["response_format"].default == "content_and_artifact"


@pytest.mark.asyncio
async def test_lc_tool_adapter_arun_via_framework_yields_tool_message_with_artifact():
    tool = FakeCommandTool(_command_result(1, "src/a.rs:3:1: error: boom", ""))
    adapter = LCToolAdapter(tool, AgentContext.empty("session-diag-framework"), None)

    message = await adapter.arun({"command": "cargo", "args": ["build"]}, tool_call_id="call-format")

    assert isinstance(message, ToolMessage)
    assert message.artifact is not None
    assert message.artifact["diagnostics"]["items"][0]["file"] == "src/a.rs"
    assert "<diagnostics>" in message.content


@pytest.mark.asyncio
async def test_arun_returns_diagnostics_artifact_and_envelope_block():
    tool = FakeCommandTool(_command_result(1, "src/a.rs:3:1: error: boom", ""))
    adapter = LCToolAdapter(tool, AgentContext.empty("session-diag-1"), None)

    text, artifact = await adapter._arun(command="cargo", args=["build"])

    assert isinstance(text, str)
    assert artifact is not None
    bundle = artifact["diagnostics"]
    assert bundle["confidence"] == "high"
    assert bundle["total"] == 1
    item = bundle["items"][0]
    assert (item["file"], item["line"], item["column"]) == ("src/a.rs", 3, 1)
    assert item["severity"] == "error"
    # kind 来自触发命令（command + args 合并后含 cargo/build）。
    assert item["kind"] == "compile"

    # 诊断块必须在不可信信封内部（原文也在信封内）。
    open_idx = text.index("<untrusted-tool-output>")
    block_idx = text.index("<diagnostics>")
    close_idx = text.index("</untrusted-tool-output>")
    assert open_idx < block_idx < close_idx
    assert "- src/a.rs:3:1 [error] error: boom" in text


@pytest.mark.asyncio
async def test_arun_suppresses_consecutive_duplicate_diagnostics():
    tool = FakeCommandTool(_command_result(1, "src/a.rs:3:1: error: boom", ""))
    adapter = LCToolAdapter(tool, AgentContext.empty("session-diag-dup"), None)

    _, first = await adapter._arun(command="cargo", args=["build"])
    text, second = await adapter._arun(command="cargo", args=["build"])

    assert first is not None and len(first["diagnostics"]["items"]) == 1
    assert second is not None
    assert second["diagnostics"]["items"] == []
    assert second["diagnostics"]["total"] == 0
    assert "<diagnostics>" not in text


@pytest.mark.asyncio
async def test_arun_attaches_no_bundle_on_zero_exit():
    tool = FakeCommandTool(_command_result(0, "src/a.rs:3:1: error: stale", ""))
    adapter = LCToolAdapter(tool, AgentContext.empty("session-diag-ok"), None)

    text, artifact = await adapter._arun(command="cargo", args=["build"])

    assert artifact is None
    assert "<diagnostics>" not in text


@pytest.mark.asyncio
async def test_arun_zero_exit_clears_ledger_and_regression_reinjects():
    """PLAN-0342 V4: fail → fail (suppressed) → success (cleared) → fail (new)."""
    tool = FakeCommandTool(_command_result(1, "src/a.rs:3:1: error: boom", ""))
    adapter = LCToolAdapter(tool, AgentContext.empty("session-diag-regress"), None)

    _, first = await adapter._arun(command="cargo", args=["build"])
    _, second = await adapter._arun(command="cargo", args=["build"])
    assert first is not None and len(first["diagnostics"]["items"]) == 1
    assert second is not None and second["diagnostics"]["items"] == []

    clean = LCToolAdapter(
        FakeCommandTool(_command_result(0, "", "")),
        AgentContext.empty("session-diag-regress"),
        None,
    )
    _, clean_artifact = await clean._arun(command="cargo", args=["build"])
    assert clean_artifact is None

    _, third = await adapter._arun(command="cargo", args=["build"])
    assert third is not None
    assert len(third["diagnostics"]["items"]) == 1
    assert third["diagnostics"]["items"][0]["message"] == "error: boom"


@pytest.mark.asyncio
async def test_arun_survives_diagnostics_extraction_failure(monkeypatch):
    """Review fix: an extractor failure must not break the tool loop."""
    tool = FakeCommandTool(_command_result(1, "src/a.rs:3:1: error: boom", ""))
    adapter = LCToolAdapter(tool, AgentContext.empty("session-diag-guard"), None)

    def explode(*args, **kwargs):
        raise RuntimeError("extractor exploded")

    monkeypatch.setattr(langgraph_runner_module, "extract_diagnostics", explode)

    text, artifact = await adapter._arun(command="cargo", args=["build"])

    assert artifact is None
    assert "boom" in text


@pytest.mark.asyncio
async def test_arun_does_not_truncate_non_command_tool_results():
    """PLAN-0342 P2-4: the 48k middle truncation is command-result scoped."""
    giant = json.dumps({"notes": "x" * 60_000})
    adapter = LCToolAdapter(
        FakeCommandTool(giant, name="read_file"),
        AgentContext.empty("session-diag-scope"),
        None,
    )

    text, artifact = await adapter._arun(path="big.txt")

    assert artifact is None
    assert "中段已截断" not in text
    assert giant[:200] in text
    assert giant[-200:] in text


@pytest.mark.asyncio
async def test_arun_attaches_no_bundle_for_non_command_content():
    tool = FakeTool()
    adapter = LCToolAdapter(tool, AgentContext.empty("session-diag-plain"), None)

    text, artifact = await adapter._arun(query="hello")

    assert artifact is None
    assert "result for hello" in text


@pytest.mark.asyncio
async def test_arun_l2_bundle_is_empty_with_low_confidence():
    tool = FakeCommandTool(_command_result(1, "just prose, nothing path-like", ""))
    adapter = LCToolAdapter(tool, AgentContext.empty("session-diag-l2"), None)

    text, artifact = await adapter._arun(command="make")

    assert artifact == {"diagnostics": {"items": [], "total": 0, "confidence": "low"}}
    assert "<diagnostics>" not in text


@pytest.mark.asyncio
async def test_tool_result_event_payload_carries_bundle_only_when_triggered():
    event_store = MagicMock()
    event_store.append = AsyncMock()

    failing = LCToolAdapter(
        FakeCommandTool(_command_result(1, "a.rs:1:1: error: x", "")),
        AgentContext.empty("session-diag-event"),
        event_store,
    )
    await failing._arun(command="make")

    payloads = [
        call.args[0].payload
        for call in event_store.append.await_args_list
        if call.args[0].type == "tool.result"
    ]
    assert len(payloads) == 1
    assert payloads[0]["diagnostics"]["items"][0]["file"] == "a.rs"

    event_store.append.reset_mock()
    succeeding = LCToolAdapter(
        FakeCommandTool(_command_result(0, "a.rs:1:1: error: x", "")),
        AgentContext.empty("session-diag-event"),
        event_store,
    )
    await succeeding._arun(command="make")

    payloads = [
        call.args[0].payload
        for call in event_store.append.await_args_list
        if call.args[0].type == "tool.result"
    ]
    assert len(payloads) == 1
    assert "diagnostics" not in payloads[0]


def test_command_text_joins_command_and_args():
    assert langgraph_runner_module._command_text({"command": "cargo", "args": ["test", "-q"]}) == "cargo test -q"
    assert langgraph_runner_module._command_text({"command": "make"}) == "make"
    assert langgraph_runner_module._command_text({}) is None
    assert langgraph_runner_module._command_text({"command": "   "}) is None
