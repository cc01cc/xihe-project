"""PLAN-0381 M1: tool history pairing, writer gate, provider mapping.

Frozen cross-language contract:
plans/PLAN-0381-XH-context-history-tool-output-bounds/evidence/m1-contract.md
"""

from datetime import UTC, datetime
from unittest.mock import AsyncMock, MagicMock

import pytest
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage

import xihe_agent.agent_runner.langgraph_runner as langgraph_runner_module
import xihe_agent.agent_runner.tool_adapter as tool_adapter_module
from xihe_agent.agent_runner import LangGraphRunner
from xihe_agent.interfaces.agent_runner import RunnerConfig
from xihe_agent.interfaces.context import (
    ARG_LIMIT,
    AgentContext,
    bound_tool_arguments,
    parse_tool_result,
)
from xihe_agent.interfaces.event import Event
from xihe_agent.interfaces.message import TextMessage, ToolCallRef
from xihe_agent.interfaces.tool import ToolSpec
from xihe_agent.llm.base import create_llm

LCToolAdapter = tool_adapter_module.LCToolAdapter
EVENT_WRITER_V2_ENV = tool_adapter_module.EVENT_WRITER_V2_ENV
MISSING_TOOL_RESULT_CONTENT = langgraph_runner_module.MISSING_TOOL_RESULT_CONTENT


def _event(seq: int, event_type: str, payload: dict) -> Event:
    return Event(
        aggregate_id="session-1",
        sequence=seq,
        type=event_type,
        payload=payload,
        created_at=datetime.now(UTC),
    )


class _RecordingTool:
    """BaseAgentTool fake that counts executions (V2: no history re-run)."""

    def __init__(self) -> None:
        self._spec = ToolSpec(
            name="read_file",
            description="read",
            input_schema={"type": "object", "properties": {"path": {"type": "string"}}},
        )
        self.execute_calls: list[dict] = []

    @property
    def spec(self) -> ToolSpec:
        return self._spec

    async def execute(self, input: dict, context: dict) -> dict:
        self.execute_calls.append(dict(input))
        return {"content": "file content"}


# --- T1.1: apply_event reconstruction ------------------------------------

def test_apply_tool_called_v2_payload_creates_declaration():
    ctx = AgentContext.empty("session-1")
    ctx.metadata["runId"] = "run-1"
    ctx.apply_event(
        _event(
            1,
            "tool.called",
            {
                "schemaVersion": 2,
                "toolCallId": "c1",
                "toolName": "read_file",
                "arguments": {"path": "a.txt"},
                "runId": "run-1",
            },
        )
    )
    assert len(ctx.messages) == 1
    message = ctx.messages[0]
    assert message.role == "ai"
    assert [(ref.call_id, ref.tool_name) for ref in message.tool_calls] == [("c1", "read_file")]
    assert message.tool_calls[0].arguments == {"path": "a.txt"}
    # runtime_state keeps its legacy key shape (contract §2 dual-read)
    assert ctx.runtime_state["tool_calls"][0]["call_id"] == "c1"
    assert ctx.runtime_state["tool_calls"][0]["tool_input"] == {"path": "a.txt"}


def test_apply_tool_called_legacy_payload_dual_read():
    ctx = AgentContext.empty("session-1")
    ctx.apply_event(
        _event(1, "tool.called", {"call_id": "c9", "tool_name": "read_file", "tool_input": {"path": "b"}})
    )
    message = ctx.messages[0]
    assert message.role == "ai"
    assert message.tool_calls[0].call_id == "c9"
    assert message.tool_calls[0].arguments == {"path": "b"}


def test_adjacent_tool_called_merge_into_single_ai_message():
    ctx = AgentContext.empty("session-1")
    for index, call_id in enumerate(("c1", "c2"), start=1):
        ctx.apply_event(
            _event(index, "tool.called", {"toolCallId": call_id, "toolName": "read_file", "arguments": {}})
        )
    assert len(ctx.messages) == 1
    assert [ref.call_id for ref in ctx.messages[0].tool_calls] == ["c1", "c2"]


def test_tool_called_after_result_starts_new_declaration():
    ctx = AgentContext.empty("session-1")
    ctx.apply_event(_event(1, "tool.called", {"call_id": "c1", "tool_name": "read_file", "tool_input": {}}))
    ctx.apply_event(_event(2, "tool.result", {"call_id": "c1", "tool_name": "read_file", "result": "ok"}))
    ctx.apply_event(_event(3, "tool.called", {"call_id": "c2", "tool_name": "read_file", "tool_input": {}}))
    assert [m.role for m in ctx.messages] == ["ai", "tool", "ai"]
    assert [ref.call_id for ref in ctx.messages[2].tool_calls] == ["c2"]


def test_unpaired_tool_called_degrades_to_text_fact():
    ctx = AgentContext.empty("session-1")
    ctx.apply_event(_event(1, "tool.called", {"tool_name": "read_file", "tool_input": {"path": "x"}}))
    message = ctx.messages[0]
    assert message.role == "ai"
    assert message.degraded is True
    assert message.tool_calls == ()
    assert message.content.startswith("[unpaired tool call: read_file]")


def test_apply_tool_result_content_shapes():
    cases = [
        ("string", "hello", "hello", False),
        ("empty string", "", "", False),
        ("object with content", {"content": "c"}, "c", False),
        ("m2 preview shape", {"preview": "p", "truncated": True, "artifactRef": "ref-1"}, "p", False),
        ("object without content", {"foo": 1}, '{"foo":1}', True),
        ("array", [1, 2], "[1,2]", True),
        ("missing result", None, "", False),
    ]
    for label, result, expected, expect_legacy in cases:
        ctx = AgentContext.empty("session-1")
        payload = {"call_id": "c1", "tool_name": "read_file"}
        if result is not None:
            payload["result"] = result
        ctx.apply_event(_event(1, "tool.result", payload))
        message = ctx.messages[0]
        assert message.role == "tool", label
        assert message.content == expected, label
        assert message.legacy_normalized is expect_legacy, label


def test_apply_tool_result_pairing_fields_and_degraded():
    ctx = AgentContext.empty("session-1")
    ctx.apply_event(_event(1, "tool.result", {"call_id": "c1", "tool_name": "read_file", "result": "ok"}))
    paired = ctx.messages[0]
    assert paired.tool_call_id == "c1"
    assert paired.tool_name == "read_file"
    assert paired.status == "completed"
    assert paired.degraded is False

    ctx.apply_event(_event(2, "tool.result", {"tool_name": "read_file", "result": "legacy"}))
    legacy = ctx.messages[1]
    assert legacy.tool_call_id == ""
    assert legacy.degraded is True
    assert legacy.status == "completed"


def test_apply_tool_result_m2_preview_whitelist():
    ctx = AgentContext.empty("session-1")
    ctx.apply_event(
        _event(
            1,
            "tool.result",
            {
                "toolCallId": "c1",
                "toolName": "read_file",
                "status": "failed",
                "result": {
                    "preview": "bounded",
                    "truncated": True,
                    "artifactRef": "art-1",
                    "sizeBytes": 9000,
                    "errorCode": "E1",
                },
            },
        )
    )
    message = ctx.messages[0]
    assert message.content == "bounded"
    assert message.status == "failed"
    assert message.truncated is True
    assert message.artifact_ref == "art-1"
    assert message.size_bytes == 9000
    assert message.error_code == "E1"
    assert message.tool_call_id == "c1"


# --- snapshot round-trip --------------------------------------------------

def test_snapshot_roundtrip_preserves_pairing_fields():
    ctx = AgentContext.empty("session-1")
    ctx.messages = [
        TextMessage(role="human", content="hi"),
        TextMessage(
            role="ai",
            content="",
            tool_calls=(ToolCallRef(call_id="c1", tool_name="read_file", arguments={"path": "a"}),),
        ),
        TextMessage(
            role="tool",
            content="file content",
            tool_call_id="c1",
            tool_name="read_file",
            status="completed",
        ),
    ]
    restored = AgentContext.from_snapshot(ctx.to_snapshot())
    assert restored.messages[0] == TextMessage(role="human", content="hi")
    assert restored.messages[1].tool_calls[0].call_id == "c1"
    assert restored.messages[1].tool_calls[0].arguments == {"path": "a"}
    assert restored.messages[2].tool_call_id == "c1"
    assert restored.messages[2].status == "completed"
    assert restored.messages[2].degraded is False


def test_snapshot_plain_message_stays_two_key():
    ctx = AgentContext.empty("session-1")
    ctx.messages = [TextMessage(role="human", content="hello")]
    assert ctx.to_snapshot()["messages"] == [{"role": "human", "content": "hello"}]


def test_snapshot_read_marks_tool_without_id_degraded():
    ctx = AgentContext.from_snapshot(
        {
            "aggregate_id": "s",
            "messages": [{"role": "tool", "content": "legacy", "tool_name": "read_file"}],
        }
    )
    assert ctx.messages[0].degraded is True


def test_tool_result_event_written_by_gate_default_is_legacy(monkeypatch):
    """Gate OFF (default): payload field set and order match pre-gate writer."""
    monkeypatch.delenv(EVENT_WRITER_V2_ENV, raising=False)
    assert tool_adapter_module.event_writer_v2_enabled() is False
    payload = tool_adapter_module._tool_event_payload(
        call_id="c1",
        tool_name="read_file",
        run_id="run-1",
        arguments={"path": "a"},
        result=None,
        include_status=False,
    )
    assert list(payload) == ["call_id", "tool_name", "tool_input"]
    assert payload["call_id"] == "c1"
    assert "schemaVersion" not in payload


# --- T1.5: bounded helpers -----------------------------------------------

def test_bound_tool_arguments_passthrough_and_marker():
    small = {"path": "a"}
    assert bound_tool_arguments(small) is small
    assert bound_tool_arguments(None) == {}

    huge = {"content": "x" * (ARG_LIMIT + 100)}
    marker = bound_tool_arguments(huge)
    assert marker["__xihe_truncated__"] is True
    assert marker["__chars__"] > ARG_LIMIT
    import json

    assert len(json.dumps(marker, ensure_ascii=False)) <= ARG_LIMIT + 128

    assert bound_tool_arguments("raw-string") == {"_raw": "raw-string"}


def test_parse_tool_result_bounded_json_preview():
    parsed = parse_tool_result({"blob": "y" * 10000})
    assert parsed.legacy_normalized is True
    assert parsed.truncated is True
    assert parsed.content.endswith("...[truncated]")
    assert len(parsed.content) <= 4096


# --- T1.4: provider mapping (contract §7) --------------------------------

def _paired_history() -> list[TextMessage]:
    return [
        TextMessage(role="human", content="read a"),
        TextMessage(
            role="ai",
            content="",
            tool_calls=(ToolCallRef(call_id="c1", tool_name="read_file", arguments={"path": "a"}),),
        ),
        TextMessage(role="tool", content="file content", tool_call_id="c1", tool_name="read_file", status="completed"),
        TextMessage(role="ai", content="done"),
    ]


def test_mapping_pairs_declaration_and_result():
    mapped = langgraph_runner_module.to_langchain_messages(_paired_history())
    assert isinstance(mapped[0], HumanMessage)
    assert isinstance(mapped[1], AIMessage)
    # LangChain normalizes entries (adds type="tool_call") — assert our fields.
    assert mapped[1].tool_calls[0]["name"] == "read_file"
    assert mapped[1].tool_calls[0]["args"] == {"path": "a"}
    assert mapped[1].tool_calls[0]["id"] == "c1"
    assert isinstance(mapped[2], ToolMessage)
    assert mapped[2].tool_call_id == "c1"
    assert mapped[2].name == "read_file"
    assert mapped[2].status == "success"
    assert isinstance(mapped[3], AIMessage)
    assert mapped[3].content == "done"


def test_mapping_degrades_unpaired_result_to_system_fact():
    history = [
        TextMessage(role="human", content="hi"),
        TextMessage(role="tool", content="orphan", tool_name="read_file"),
    ]
    mapped = langgraph_runner_module.to_langchain_messages(history)
    fact = [m for m in mapped if isinstance(m, SystemMessage)]
    assert len(fact) == 1
    assert fact[0].content == "[unpaired tool result: read_file] orphan"


def test_mapping_degrades_result_without_matching_declaration():
    history = [
        TextMessage(role="human", content="hi"),
        TextMessage(role="tool", content="r", tool_call_id="stranger", tool_name="read_file"),
    ]
    mapped = langgraph_runner_module.to_langchain_messages(history)
    assert isinstance(mapped[1], SystemMessage)
    assert mapped[1].content.startswith("[unpaired tool result: read_file]")


def test_mapping_synthesizes_missing_result_before_next_message():
    history = [
        TextMessage(role="human", content="q1"),
        TextMessage(
            role="ai",
            content="",
            tool_calls=(ToolCallRef(call_id="c1", tool_name="read_file", arguments={}),),
        ),
        TextMessage(role="human", content="q2"),
    ]
    mapped = langgraph_runner_module.to_langchain_messages(history)
    assert isinstance(mapped[1], AIMessage)
    assert isinstance(mapped[2], ToolMessage)
    assert mapped[2].tool_call_id == "c1"
    assert mapped[2].content == MISSING_TOOL_RESULT_CONTENT
    assert mapped[2].status == "error"
    assert isinstance(mapped[3], HumanMessage)


def test_mapping_flushes_missing_result_at_sequence_end():
    history = [
        TextMessage(
            role="ai",
            content="",
            tool_calls=(ToolCallRef(call_id="c1", tool_name="read_file", arguments={}),),
        )
    ]
    mapped = langgraph_runner_module.to_langchain_messages(history)
    assert isinstance(mapped[1], ToolMessage)
    assert mapped[1].tool_call_id == "c1"
    assert mapped[1].content == MISSING_TOOL_RESULT_CONTENT


def test_mapping_status_domain_mapping():
    history = [
        TextMessage(
            role="ai",
            content="",
            tool_calls=(ToolCallRef(call_id="c1", tool_name="t", arguments={}),),
        ),
        TextMessage(role="tool", content="x", tool_call_id="c1", status="failed"),
        TextMessage(
            role="ai",
            content="",
            tool_calls=(ToolCallRef(call_id="c2", tool_name="t", arguments={}),),
        ),
        TextMessage(role="tool", content="y", tool_call_id="c2"),
    ]
    mapped = langgraph_runner_module.to_langchain_messages(history)
    assert mapped[1].status == "error"
    assert mapped[3].status == "success"  # legacy status "" → completed semantics


def test_mapping_rebounds_defensive_arguments():
    oversized = {"content": "z" * (ARG_LIMIT + 50)}
    history = [
        TextMessage(
            role="ai",
            content="",
            tool_calls=(ToolCallRef(call_id="c1", tool_name="t", arguments=oversized),),
        ),
        TextMessage(role="tool", content="ok", tool_call_id="c1"),
    ]
    mapped = langgraph_runner_module.to_langchain_messages(history)
    args = mapped[0].tool_calls[0]["args"]
    assert args.get("__xihe_truncated__") is True


# --- writer gate payloads (T1.2) -----------------------------------------

def _adapter(ctx: AgentContext, event_store: MagicMock) -> LCToolAdapter:
    return LCToolAdapter(_RecordingTool(), ctx, event_store)


@pytest.mark.asyncio
async def test_writer_gate_off_emits_legacy_payload(monkeypatch):
    monkeypatch.delenv(EVENT_WRITER_V2_ENV, raising=False)
    event_store = MagicMock()
    event_store.append = AsyncMock()
    adapter = _adapter(AgentContext.empty("session-1"), event_store)

    await adapter._arun(path="a.txt")

    events = [call.args[0] for call in event_store.append.await_args_list]
    called = next(e for e in events if e.type == "tool.called")
    result = next(e for e in events if e.type == "tool.result")
    assert list(called.payload) == ["call_id", "tool_name", "tool_input"]
    assert list(result.payload)[:3] == ["call_id", "tool_name", "result"]
    assert "schemaVersion" not in called.payload
    assert "status" not in result.payload
    # PLAN-0381 T2.3：legacy 形状仍是字符串（旧 reader `asText` 直读），内容
    # 已是有界 preview（低水位 = 原文）。
    assert result.payload["result"] == "file content"


@pytest.mark.asyncio
async def test_writer_gate_on_emits_v2_payload(monkeypatch):
    monkeypatch.setenv(EVENT_WRITER_V2_ENV, "1")
    event_store = MagicMock()
    event_store.append = AsyncMock()
    ctx = AgentContext.empty("session-1")
    ctx.metadata["runId"] = "run-9"
    adapter = _adapter(ctx, event_store)

    await adapter._arun(path="a.txt")

    events = [call.args[0] for call in event_store.append.await_args_list]
    called = next(e for e in events if e.type == "tool.called")
    result = next(e for e in events if e.type == "tool.result")
    assert called.payload["schemaVersion"] == 2
    assert called.payload["toolCallId"]
    assert called.payload["toolName"] == "read_file"
    assert called.payload["arguments"] == {"path": "a.txt"}
    assert called.payload["runId"] == "run-9"
    assert "call_id" not in called.payload
    assert result.payload["schemaVersion"] == 2
    assert result.payload["status"] == "completed"
    # PLAN-0381 T2.3 gate ON：result 对象化（preview/truncated/sizeBytes 白名单
    # 形状，M1 reader 规则 4 读取）。
    assert result.payload["result"] == {
        "preview": "file content",
        "truncated": False,
        "sizeBytes": 12,
    }
    assert "call_id" not in result.payload


@pytest.mark.asyncio
async def test_writer_gate_on_bounds_huge_arguments(monkeypatch):
    monkeypatch.setenv(EVENT_WRITER_V2_ENV, "1")
    event_store = MagicMock()
    event_store.append = AsyncMock()
    adapter = _adapter(AgentContext.empty("session-1"), event_store)

    await adapter._arun(path="x" * (ARG_LIMIT + 100))

    called = next(
        call.args[0] for call in event_store.append.await_args_list if call.args[0].type == "tool.called"
    )
    assert called.payload["arguments"]["__xihe_truncated__"] is True


# --- V2: restored history never re-executes (runner stream) ---------------

@pytest.mark.asyncio
async def test_restored_tool_history_does_not_reexecute_tools():
    tool = _RecordingTool()
    context = AgentContext.empty("session-1")
    context.messages = _paired_history()
    runner = LangGraphRunner(model_factory=lambda _model: create_llm())
    config = RunnerConfig(model="mock", system_prompt="test", tools=[tool], context=context)

    events = []
    async for event in runner.stream([], config):
        events.append(event)

    assert any(e.type == "token" for e in events)
    assert tool.execute_calls == [], "historical tool pairs must map to messages, never re-run"
