"""PLAN-0381 M3（T3.1/T3.2）：五类状态矩阵与保配对回归。

契约：plans/PLAN-0381-XH-context-history-tool-output-bounds/evidence/m3-contract.md
§1 状态矩阵（五场景 × status 来源）+ §1.1 failed 写路径 + §2 保配对规则。
"""

from datetime import UTC, datetime
from typing import Any
from unittest.mock import AsyncMock, MagicMock

import pytest
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage

import xihe_agent.agent_runner.langgraph_runner as langgraph_runner_module
from xihe_agent.adapters.approval_tool import ApprovalExpiredError
from xihe_agent.agent_runner.tool_adapter import (
    EVENT_WRITER_V2_ENV,
    LCToolAdapter,
)
from xihe_agent.context.crash_recovery import CrashRecovery
from xihe_agent.interfaces.context import AgentContext
from xihe_agent.interfaces.event import Event
from xihe_agent.interfaces.message import TextMessage, ToolCallRef
from xihe_agent.interfaces.tool import ToolSpec


def _spec(name: str = "execute_command") -> ToolSpec:
    return ToolSpec(
        name=name,
        description="d",
        input_schema={"type": "object", "properties": {"command": {"type": "string"}}},
    )


class _OkTool:
    spec = _spec()

    async def execute(self, input: dict, context: Any) -> dict:
        return {"content": "file content"}


class _FailingTool:
    spec = _spec()

    async def execute(self, input: dict, context: Any) -> dict:
        raise ValueError("boom from tool")


class _ApprovalTerminalTool:
    spec = _spec(name="approval")

    async def execute(self, input: dict, context: Any) -> dict:
        raise ApprovalExpiredError("gate expired")


def _adapter(tool: object, ctx: AgentContext, event_store: MagicMock) -> LCToolAdapter:
    return LCToolAdapter(tool, ctx, event_store)  # type: ignore[arg-type]


def _captured(event_store: MagicMock) -> list[Event]:
    return [call.args[0] for call in event_store.append.await_args_list]


def _fresh_store() -> MagicMock:
    store = MagicMock()
    store.append = AsyncMock()
    return store


class _FakeEventStore:
    """Minimal EventStore duck-type for CrashRecovery."""

    def __init__(self, events: list[Event]) -> None:
        self._events = events

    async def read(self, session_id: str, after_sequence: int = 0):  # noqa: ANN201
        for event in self._events:
            if event.sequence > after_sequence:
                yield event

    async def get_latest_sequence(self, session_id: str) -> int:
        return max((event.sequence for event in self._events), default=0)


def _assert_no_unanswered_calls(messages: list[Any]) -> None:
    """映射产物里每个 assistant tool_call 都必须有对应 ToolMessage（协议有效，
    历史裁剪不得留下『待执行调用』——m3-contract §2.3）。"""
    pending: set[str] = set()
    answered: set[str] = set()
    for message in messages:
        if isinstance(message, AIMessage):
            for call in message.tool_calls or []:
                pending.add(call["id"])
        elif isinstance(message, ToolMessage):
            answered.add(message.tool_call_id)
            pending.discard(message.tool_call_id)
        elif isinstance(message, HumanMessage):
            assert not pending, f"human message with unanswered tool calls: {pending}"
    assert not pending, f"unanswered tool calls leaked to the model: {pending}"


# --- T3.2 行 1/5：同轮成功 vs 工具失败（gate OFF 缺省语义）------------------


@pytest.mark.asyncio
async def test_same_round_success_keeps_legacy_shape_and_defaults_to_completed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv(EVENT_WRITER_V2_ENV, raising=False)
    store = _fresh_store()
    await _adapter(_OkTool(), AgentContext.empty("s1"), store)._arun(command="ls")

    events = _captured(store)
    assert [e.type for e in events] == ["tool.called", "tool.result"]
    # m3-contract §1.1：gate OFF completed 保持 pre-gate 字段集（无 status 键）。
    assert "status" not in events[1].payload
    assert events[1].payload["result"] == "file content"

    ctx = AgentContext.from_events("s1", events)
    assert ctx.messages[1].status == "completed"  # reader 缺省
    mapped = langgraph_runner_module.to_langchain_messages(ctx.messages)
    assert isinstance(mapped[1], ToolMessage)
    assert mapped[1].status == "success"
    _assert_no_unanswered_calls(mapped)


@pytest.mark.asyncio
async def test_failed_tool_closes_pair_with_explicit_failed_status(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv(EVENT_WRITER_V2_ENV, raising=False)
    store = _fresh_store()
    adapter = _adapter(_FailingTool(), AgentContext.empty("s2"), store)

    with pytest.raises(ValueError, match="boom from tool"):
        await adapter._arun(command="ls")

    events = _captured(store)
    # T3.2 失败必须闭合 durable 事件对——缺果声明会被下一轮回放成
    # 「run interrupted」，那是对失败的伪造。
    assert [e.type for e in events] == ["tool.called", "tool.result"]
    result = events[1].payload
    assert result["status"] == "failed", "gate OFF 非 completed 必须显式写 status"
    assert "ValueError" in result["result"] and "boom from tool" in result["result"]
    assert list(result)[:4] == ["call_id", "tool_name", "result", "status"]

    # 失败状态贯穿：事件 → 上下文 → provider 映射
    ctx = AgentContext.from_events("s2", events)
    assert ctx.messages[1].status == "failed"
    mapped = langgraph_runner_module.to_langchain_messages(ctx.messages)
    assert isinstance(mapped[1], ToolMessage)
    assert mapped[1].status == "error"
    assert "boom from tool" in str(mapped[1].content)
    _assert_no_unanswered_calls(mapped)


@pytest.mark.asyncio
async def test_failed_tool_with_gate_on_writes_v2_status(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv(EVENT_WRITER_V2_ENV, "1")
    store = _fresh_store()
    with pytest.raises(ValueError):
        await _adapter(_FailingTool(), AgentContext.empty("s3"), store)._arun(command="ls")

    result = next(e for e in _captured(store) if e.type == "tool.result").payload
    assert result["schemaVersion"] == 2
    assert result["status"] == "failed"
    assert isinstance(result["result"], dict)
    assert "boom from tool" in result["result"]["preview"]
    assert result["result"]["truncated"] is False


@pytest.mark.asyncio
async def test_approval_terminal_error_writes_no_failed_result() -> None:
    # m3-contract §1.1：审批终态是控制流，不落 failed tool.result（已知边界）。
    store = _fresh_store()
    with pytest.raises(ApprovalExpiredError):
        await _adapter(_ApprovalTerminalTool(), AgentContext.empty("s4"), store)._arun()

    assert [e.type for e in _captured(store)] == ["tool.called"]


# --- T3.2 行 2/3：下一轮恢复 vs Agent 重启恢复 ------------------------------


@pytest.mark.asyncio
async def test_next_round_replay_preserves_pair_and_failed_status() -> None:
    events = [
        Event(
            aggregate_id="s5",
            sequence=1,
            type="tool.called",
            payload={"call_id": "c1", "tool_name": "t"},
            created_at=datetime.now(UTC),
        ),
        Event(
            aggregate_id="s5",
            sequence=2,
            type="tool.result",
            payload={
                "call_id": "c1",
                "tool_name": "t",
                "result": "Tool execution failed: RuntimeError: gone",
                "status": "failed",
            },
            created_at=datetime.now(UTC),
        ),
        Event(
            aggregate_id="s5",
            sequence=3,
            type="prompt.admitted",
            payload={"content": "next round"},
            created_at=datetime.now(UTC),
        ),
    ]
    ctx = AgentContext.from_events("s5", events)
    mapped = langgraph_runner_module.to_langchain_messages(ctx.messages)

    _assert_no_unanswered_calls(mapped)
    assert isinstance(mapped[0], AIMessage) and mapped[0].tool_calls[0]["id"] == "c1"
    assert isinstance(mapped[1], ToolMessage)
    assert mapped[1].tool_call_id == "c1"
    assert mapped[1].status == "error"
    assert isinstance(mapped[2], HumanMessage)


@pytest.mark.asyncio
async def test_agent_restart_recovery_rebuilds_same_history() -> None:
    events = [
        Event(
            aggregate_id="s6",
            sequence=1,
            type="tool.called",
            payload={"call_id": "c1", "tool_name": "t", "tool_input": {"command": "ls"}},
            created_at=datetime.now(UTC),
        ),
        Event(
            aggregate_id="s6",
            sequence=2,
            type="tool.result",
            payload={"call_id": "c1", "tool_name": "t", "result": "ok"},
            created_at=datetime.now(UTC),
        ),
    ]
    recovered = await CrashRecovery(_FakeEventStore(events)).recover("s6")
    direct = AgentContext.from_events("s6", events)

    assert recovered.to_snapshot()["messages"] == direct.to_snapshot()["messages"]
    assert recovered.latest_sequence == 2
    mapped = langgraph_runner_module.to_langchain_messages(recovered.messages)
    _assert_no_unanswered_calls(mapped)
    assert isinstance(mapped[1], ToolMessage) and mapped[1].status == "success"


# --- T3.2 行 4：artifact 过期不改写历史 -------------------------------------


def test_artifact_expiry_never_rewrites_history(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(EVENT_WRITER_V2_ENV, "1")
    events = [
        Event(
            aggregate_id="s7",
            sequence=1,
            type="tool.called",
            payload={"toolCallId": "c1", "toolName": "execute_command", "arguments": {"command": "x"}},
            created_at=datetime.now(UTC),
        ),
        Event(
            aggregate_id="s7",
            sequence=2,
            type="tool.result",
            payload={
                "toolCallId": "c1",
                "toolName": "execute_command",
                "status": "completed",
                "result": {
                    "preview": "out",
                    "truncated": True,
                    "artifactRef": "art-1",
                    "sizeBytes": 9000,
                    "status": "available",
                },
            },
            created_at=datetime.now(UTC),
        ),
    ]
    ctx = AgentContext.from_events("s7", events)
    snapshot = ctx.to_snapshot()
    restored = AgentContext.from_snapshot(snapshot)

    # TTL 到期不改写历史：completed/available/ref 均为写入时事实，重放不漂移。
    tool_message = restored.messages[1]
    assert tool_message.status == "completed"
    assert getattr(tool_message, "artifact_ref") == "art-1"
    assert getattr(tool_message, "truncated") is True
    assert getattr(tool_message, "size_bytes") == 9000
    # 不可读性只经读路径显式到达（M2 Runtime available:false），历史无 expired 伪写。
    assert tool_message.status != "expired"


# --- T3.1：裁剪不产生待执行调用 / 掩码保持配对 ------------------------------


def test_masked_tool_result_still_pairs_and_never_becomes_pending() -> None:
    history = [
        TextMessage(
            role="ai",
            content="",
            tool_calls=(ToolCallRef(call_id="c1", tool_name="t", arguments={"a": 1}),),
        ),
        TextMessage(
            role="tool",
            # PLAN-0341 掩码（内容换占位、配对字段存活）
            content="[old tool result cleared]",
            tool_call_id="c1",
            tool_name="t",
            status="completed",
            artifact_ref="art-1",
            truncated=True,
        ),
    ]
    mapped = langgraph_runner_module.to_langchain_messages(history)

    _assert_no_unanswered_calls(mapped)
    assert len(mapped) == 2
    assert isinstance(mapped[1], ToolMessage)
    assert mapped[1].content == "[old tool result cleared]"
    assert mapped[1].status == "success"
    # 不降级为 system 文本事实、不出现缺果合成标记（配对未被掩码打断）。
    assert not any(m.type == "system" for m in mapped)
    assert "missing tool result" not in str(mapped[1].content)


def test_compaction_split_declaration_gets_explicit_marker_not_open_call() -> None:
    # 声明在、结果被裁：必须给出显式缺果标记（status=error），且不留未答 tool_call。
    history = [
        TextMessage(
            role="ai",
            content="",
            tool_calls=(ToolCallRef(call_id="c1", tool_name="t", arguments={}),),
        ),
        TextMessage(role="human", content="continue"),
    ]
    mapped = langgraph_runner_module.to_langchain_messages(history)

    _assert_no_unanswered_calls(mapped)
    marker = mapped[1]
    assert isinstance(marker, ToolMessage)
    assert marker.tool_call_id == "c1"
    assert marker.status == "error"
    assert "[missing tool result" in str(marker.content)
    assert isinstance(mapped[2], HumanMessage)
