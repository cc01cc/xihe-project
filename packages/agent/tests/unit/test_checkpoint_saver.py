from __future__ import annotations

import base64
from types import SimpleNamespace
from typing import Annotated, TypedDict
from uuid import uuid4

import pytest
from langchain_core.language_models.fake_chat_models import FakeMessagesListChatModel
from langchain_core.messages import AIMessage, BaseMessage, HumanMessage, ToolMessage
from langgraph.checkpoint.base import empty_checkpoint
from langgraph.graph import END, START, StateGraph
from langgraph.graph.message import add_messages

from xihe_agent.agent_runner.checkpoint_saver import CpAgentCheckpointSaver
from xihe_agent.interfaces.tool import (
    ACQUIRE_CREDENTIAL_TOOL_NAME,
    CHECKPOINT_SAFE_OUTPUT_PREFIX,
    CHECKPOINT_SAFE_OUTPUT_SCHEMA_KEY,
    CHECKPOINT_SAFE_OUTPUT_SUFFIX,
    CHECKPOINT_SAFE_PROBE_SCHEMA_VERSION,
    CHECKPOINT_SAFE_PROBE_TOOL_NAME,
    CREDENTIAL_DELIVERED_PLACEHOLDER,
    CREDENTIAL_HANDOFF_REQUIRED_KEY,
    CheckpointSafeToolSchema,
    ToolSpec,
)


def _saver(*, tool_specs: tuple[ToolSpec, ...] = ()) -> CpAgentCheckpointSaver:
    saver = CpAgentCheckpointSaver(
        cp_url="http://cp.invalid",
        service_token="test-token",
        session_id=str(uuid4()),
        user_id=str(uuid4()),
        workspace_id=str(uuid4()),
        tool_specs=tool_specs,
    )
    saver._thread_id = str(uuid4())
    saver._lineage_id = str(uuid4())
    saver._schema_version = 1
    saver._trace_metadata = {
        "lineageId": saver._lineage_id,
        "sourceRunId": None,
        "sessionId": saver._owner["sessionId"],
        "branchId": str(uuid4()),
        "userId": saver._owner["userId"],
        "workspaceId": saver._owner["workspaceId"],
        "stateSchemaVersion": 1,
        "createdAt": "2026-10-14T00:00:00Z",
        "producerVersion": "0.1.0",
    }
    return saver


def _run_immediate(awaitable):
    """Drive a mocked async saver path that must not perform real I/O."""
    try:
        awaitable.send(None)
    except StopIteration as completed:
        return completed.value
    raise AssertionError("test coroutine attempted asynchronous I/O")


def test_metadata_only_keeps_checkpoint_safe_langgraph_fields() -> None:
    assert CpAgentCheckpointSaver._safe_metadata(
        {
            "source": "fork",
            "step": 4,
            "eventSequence": 18,
            "writes": {"messages": "sensitive body"},
            "secretCanary": "must-not-persist",
        }
    ) == {"source": "fork", "step": 4, "eventSequence": 18}
    assert CpAgentCheckpointSaver._safe_metadata({"source": "unknown", "step": True}) == {}


def test_source_run_checkpoint_carries_exact_event_store_cursor(monkeypatch: pytest.MonkeyPatch) -> None:
    saver = _saver()
    saver._source_run_id = str(uuid4())
    saver._event_sequence_provider = lambda: 37
    checkpoint = empty_checkpoint()
    checkpoint["id"] = "checkpoint-cursor"
    checkpoint["channel_values"] = {"messages": [HumanMessage(content="safe input", id="human-cursor")]}
    captured: list[dict] = []
    monkeypatch.setattr(saver, "_request_sync", lambda method, path, *, json=None, **kwargs: captured.append(json))

    saver.put(
        {"configurable": {"thread_id": saver.thread_id, "checkpoint_ns": ""}},
        checkpoint,
        {"source": "input", "step": 0, "eventSequence": 12},
        {},
    )

    assert captured[0]["metadata"] == {"source": "input", "step": 0, "eventSequence": 37}


def test_source_run_checkpoint_fails_closed_without_event_cursor(monkeypatch: pytest.MonkeyPatch) -> None:
    saver = _saver()
    saver._source_run_id = str(uuid4())
    checkpoint = empty_checkpoint()
    checkpoint["id"] = "checkpoint-no-cursor"
    checkpoint["channel_values"] = {"messages": [HumanMessage(content="safe input")]}
    requests: list[dict] = []
    monkeypatch.setattr(saver, "_request_sync", lambda method, path, *, json=None, **kwargs: requests.append(json))

    with pytest.raises(RuntimeError, match="requires an EventStore cursor"):
        saver.put(
            {"configurable": {"thread_id": saver.thread_id, "checkpoint_ns": ""}},
            checkpoint,
            {"source": "input", "step": 0},
            {},
        )
    assert requests == []


def test_continuation_preflight_accepts_completed_safe_tool_message_in_pending_writes(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    saver = _saver()
    call_id = "origin-call-id-not-a-uuid"
    assistant = AIMessage(
        content="",
        tool_calls=[{"name": CHECKPOINT_SAFE_PROBE_TOOL_NAME, "args": {}, "id": call_id, "type": "tool_call"}],
    )
    result = ToolMessage(
        content=(CHECKPOINT_SAFE_OUTPUT_PREFIX + '{"status":"ok"}' + CHECKPOINT_SAFE_OUTPUT_SUFFIX),
        tool_call_id=call_id,
        name=CHECKPOINT_SAFE_PROBE_TOOL_NAME,
        additional_kwargs={CHECKPOINT_SAFE_OUTPUT_SCHEMA_KEY: CHECKPOINT_SAFE_PROBE_SCHEMA_VERSION},
    )
    loaded = SimpleNamespace(
        checkpoint={"id": "checkpoint-safe", "channel_values": {"messages": [assistant]}},
        pending_writes=[("task-1", "messages", result)],
    )

    async def get_tuple(config):
        return loaded

    monkeypatch.setattr(saver, "aget_tuple", get_tuple)
    _run_immediate(
        saver.preflight_completed_tool_calls(
            checkpoint_id="checkpoint-safe",
            completed_tool_call_ids=[call_id],
        )
    )


def test_continuation_preflight_rejects_missing_safe_result_and_unavailable_credential(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    saver = _saver()
    call_id = "origin-call-id"
    assistant = AIMessage(
        content="",
        tool_calls=[{"name": CHECKPOINT_SAFE_PROBE_TOOL_NAME, "args": {}, "id": call_id, "type": "tool_call"}],
    )
    loaded = SimpleNamespace(
        checkpoint={"id": "checkpoint-safe", "channel_values": {"messages": [assistant]}},
        pending_writes=[],
    )

    async def get_tuple(config):
        return loaded

    monkeypatch.setattr(saver, "aget_tuple", get_tuple)
    with pytest.raises(RuntimeError, match="no matching safe checkpoint result"):
        _run_immediate(
            saver.preflight_completed_tool_calls(
                checkpoint_id="checkpoint-safe",
                completed_tool_call_ids=[call_id],
            )
        )

    credential = ToolMessage(
        content=CREDENTIAL_DELIVERED_PLACEHOLDER,
        tool_call_id="credential-origin-call",
        name=ACQUIRE_CREDENTIAL_TOOL_NAME,
        additional_kwargs={CREDENTIAL_HANDOFF_REQUIRED_KEY: True},
    )
    loaded.checkpoint["channel_values"]["messages"].append(credential)
    with pytest.raises(RuntimeError, match="credential handoff is unavailable"):
        _run_immediate(
            saver.preflight_completed_tool_calls(
                checkpoint_id="checkpoint-safe",
                completed_tool_call_ids=[],
            )
        )


def test_acquire_credential_canary_is_redacted_before_checkpoint_serialization(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    saver = _saver()
    canary = "credential-canary-0510-do-not-persist"
    secret_message = ToolMessage(
        content=canary,
        tool_call_id="credential-call",
        name=ACQUIRE_CREDENTIAL_TOOL_NAME,
        additional_kwargs={"credentialValue": canary},
        response_metadata={"credentialValue": canary},
        artifact={"secret": canary},
        id="credential-message-1",
    )
    assistant_message = AIMessage(
        content="Synthetic assistant content",
        additional_kwargs={"providerResponse": canary},
        response_metadata={"headers": {"authorization": canary}, "rawResponse": canary},
        id="assistant-message-1",
    )
    checkpoint = empty_checkpoint()
    checkpoint["id"] = "checkpoint-secret"
    checkpoint["channel_values"] = {"messages": [assistant_message, secret_message]}
    captured: list[dict] = []

    def capture(method: str, path: str, *, json=None, params=None, allow_not_found=False):
        captured.append(json)
        return None

    monkeypatch.setattr(saver, "_request_sync", capture)
    saver.put(
        {"configurable": {"thread_id": saver.thread_id, "checkpoint_ns": ""}},
        checkpoint,
        {"source": "loop", "step": 1},
        {},
    )

    body = captured[0]
    payload = base64.b64decode(body["payloadBase64"], validate=True)
    persisted = saver.serde.loads_typed((body["payloadType"], payload))
    persisted_assistant = persisted["channel_values"]["messages"][0]
    persisted_message = persisted["channel_values"]["messages"][1]
    assert canary.encode() not in payload
    assert persisted_assistant.content == assistant_message.content
    assert persisted_assistant.id == assistant_message.id
    assert persisted_assistant.additional_kwargs == {}
    assert persisted_assistant.response_metadata == {}
    assert persisted_message.content == CREDENTIAL_DELIVERED_PLACEHOLDER
    assert persisted_message.id == secret_message.id
    assert persisted_message.additional_kwargs == {}
    assert persisted_message.response_metadata == {}
    assert persisted_message.artifact is None
    assert checkpoint["channel_values"]["messages"][0].additional_kwargs["providerResponse"] == canary

    saver.put_writes(
        saver._checkpoint_config(saver.thread_id, "", "checkpoint-secret"),
        [("messages", secret_message)],
        task_id="credential-task",
    )
    write_body = captured[1]
    write_payload = base64.b64decode(write_body["writes"][0]["payloadBase64"], validate=True)
    persisted_write = saver.serde.loads_typed((write_body["writes"][0]["payloadType"], write_payload))
    assert canary.encode() not in write_payload
    assert isinstance(persisted_write, ToolMessage)
    assert persisted_write.content == CREDENTIAL_DELIVERED_PLACEHOLDER
    assert persisted_write.id == secret_message.id
    assert persisted_write.additional_kwargs == {}
    assert persisted_write.response_metadata == {}
    assert persisted_write.artifact is None
    assert secret_message.content == canary
    assert assistant_message.additional_kwargs["providerResponse"] == canary


def test_unknown_or_out_of_schema_tool_outputs_fail_closed_before_storage() -> None:
    saver = _saver()
    unknown = ToolMessage(content="possibly sensitive output", tool_call_id="call-1", name="read_file")
    with pytest.raises(RuntimeError, match="no checkpoint-safe schema"):
        saver._value_for_storage(unknown)

    out_of_schema = ToolMessage(
        content=(
            CHECKPOINT_SAFE_OUTPUT_PREFIX
            + '{"status":"ok","secret":"must-not-persist"}'
            + CHECKPOINT_SAFE_OUTPUT_SUFFIX
        ),
        tool_call_id="call-2",
        name=CHECKPOINT_SAFE_PROBE_TOOL_NAME,
        additional_kwargs={CHECKPOINT_SAFE_OUTPUT_SCHEMA_KEY: CHECKPOINT_SAFE_PROBE_SCHEMA_VERSION},
    )
    with pytest.raises(RuntimeError, match="does not match its checkpoint-safe schema"):
        saver._value_for_storage(out_of_schema)

    argument_canary = "provider-tool-argument-canary"
    unsafe_tool_call = AIMessage(
        content="",
        tool_calls=[
            {
                "name": CHECKPOINT_SAFE_PROBE_TOOL_NAME,
                "args": {"secret": argument_canary},
                "id": "call-3",
                "type": "tool_call",
            }
        ],
    )
    with pytest.raises(RuntimeError, match="do not match their checkpoint-safe schema"):
        saver._value_for_storage(unsafe_tool_call)


def test_unsafe_tool_state_keeps_current_langgraph_run_in_memory_and_stales_checkpoint(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    saver = _saver()
    source_run_id = str(uuid4())
    saver._source_run_id = source_run_id
    saver._trace_metadata["sourceRunId"] = source_run_id
    event_cursor = [1]
    saver._event_sequence_provider = lambda: event_cursor[0]
    stored_rows: list[dict] = []
    persisted_writes: list[dict] = []

    def to_row(body: dict) -> dict:
        return {
            "threadId": saver.thread_id,
            "checkpointNs": body["checkpointNs"],
            "checkpointId": body["checkpointId"],
            "parentCheckpointId": body["parentCheckpointId"],
            "lineageId": saver.lineage_id,
            "sourceRunId": source_run_id,
            "sessionId": saver._owner["sessionId"],
            "branchId": saver.trace_metadata["branchId"],
            "userId": saver._owner["userId"],
            "workspaceId": saver._owner["workspaceId"],
            "schemaVersion": saver.schema_version,
            "createdAt": "2026-10-14T00:00:00Z",
            "producerVersion": saver.trace_metadata["producerVersion"],
            "payloadType": body["payloadType"],
            "payloadBase64": body["payloadBase64"],
            "metadata": body["metadata"],
            "pendingWrites": [],
        }

    def request(method: str, path: str, *, json=None, params=None, allow_not_found=False):
        if method == "GET":
            if stored_rows and path.endswith("/checkpoints"):
                return stored_rows[-1:]
            return stored_rows[-1] if stored_rows else None
        if method == "PUT":
            stored_rows.append(to_row(json))
        elif method == "POST":
            persisted_writes.append(json)
        return None

    monkeypatch.setattr(saver, "_request_sync", request)
    initial = empty_checkpoint()
    initial["id"] = uuid4().hex
    initial["channel_values"] = {"messages": [HumanMessage(content="prior safe state")]}
    saver.put(
        {"configurable": {"thread_id": saver.thread_id, "checkpoint_ns": ""}},
        initial,
        {"source": "input", "step": 0},
        {},
    )

    canary = "unsafe-tool-current-run-canary"
    observed_by_model: list[str] = []
    model = FakeMessagesListChatModel(responses=[AIMessage(content="I received the tool result")])

    class AgentState(TypedDict):
        messages: Annotated[list[BaseMessage], add_messages]

    def unsafe_tool_node(_state: AgentState) -> dict:
        # Represents the durable tool.result append that precedes returning
        # its in-memory ToolMessage to LangGraph.
        event_cursor[0] = 2
        return {
            "messages": [
                ToolMessage(
                    content=canary,
                    tool_call_id="originating-call-unsafe",
                    name="unregistered_tool",
                    id="unsafe-tool-result",
                )
            ]
        }

    def following_model_node(state: AgentState) -> dict:
        observed_by_model.append(state["messages"][-1].content)
        return {"messages": [model.invoke(state["messages"])]}

    builder = StateGraph(AgentState)
    builder.add_node("tools", unsafe_tool_node)
    builder.add_node("model", following_model_node)
    builder.add_edge(START, "tools")
    builder.add_edge("tools", "model")
    builder.add_edge("model", END)
    graph = builder.compile(checkpointer=saver)
    result = graph.invoke(
        {
            "messages": [
                AIMessage(
                    content="",
                    tool_calls=[
                        {
                            "name": "unregistered_tool",
                            "args": {},
                            "id": "originating-call-unsafe",
                            "type": "tool_call",
                        }
                    ],
                )
            ]
        },
        config={"configurable": {"thread_id": saver.thread_id, "checkpoint_ns": ""}},
    )

    assert observed_by_model == [canary]
    assert result["messages"][-1].content == "I received the tool result"
    assert len(stored_rows) == 1
    assert persisted_writes == []
    assert stored_rows[0]["metadata"]["eventSequence"] == 1
    assert stored_rows[0]["metadata"]["eventSequence"] != event_cursor[0]
    persisted_payload = base64.b64decode(stored_rows[0]["payloadBase64"], validate=True)
    assert canary.encode() not in persisted_payload
    assert not any(canary.encode() in repr(item).encode() for item in persisted_writes)


def test_async_unsafe_checkpoint_latches_out_all_later_writes(monkeypatch: pytest.MonkeyPatch) -> None:
    saver = _saver()
    requests: list[str] = []

    async def request(method: str, path: str, **kwargs):
        requests.append(method)
        return None

    monkeypatch.setattr(saver, "_arequest", request)
    checkpoint = empty_checkpoint()
    checkpoint["id"] = "checkpoint-unsafe-async"
    checkpoint["channel_values"] = {
        "messages": [
            ToolMessage(
                content="raw unregistered output",
                tool_call_id="origin-call",
                name="unregistered_tool",
            )
        ]
    }
    config = {"configurable": {"thread_id": saver.thread_id, "checkpoint_ns": ""}}

    resumed_config = _run_immediate(saver.aput(config, checkpoint, {"source": "loop", "step": 1}, {}))
    assert resumed_config["configurable"]["checkpoint_id"] == checkpoint["id"]
    _run_immediate(
        saver.aput_writes(
            {**config, "configurable": {**config["configurable"], "checkpoint_id": checkpoint["id"]}},
            [("messages", HumanMessage(content="later safe write"))],
            task_id="later-task",
        )
    )
    assert requests == []


def test_runtime_pregel_v4_checkpoint_without_pending_sends_round_trips(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    saver = _saver()
    stored_rows: list[dict] = []

    def to_row(body: dict) -> dict:
        return {
            "threadId": saver.thread_id,
            "checkpointNs": body["checkpointNs"],
            "checkpointId": body["checkpointId"],
            "parentCheckpointId": body["parentCheckpointId"],
            "lineageId": saver.lineage_id,
            "sourceRunId": saver.trace_metadata["sourceRunId"],
            "sessionId": saver._owner["sessionId"],
            "branchId": saver.trace_metadata["branchId"],
            "userId": saver._owner["userId"],
            "workspaceId": saver._owner["workspaceId"],
            "schemaVersion": saver.schema_version,
            "createdAt": "2026-10-14T00:00:00Z",
            "producerVersion": saver.trace_metadata["producerVersion"],
            "payloadType": body["payloadType"],
            "payloadBase64": body["payloadBase64"],
            "metadata": body["metadata"],
            "pendingWrites": [],
        }

    def request(method: str, path: str, *, json=None, params=None, allow_not_found=False):
        if method == "GET":
            return stored_rows[-1:] if stored_rows else []
        if method == "PUT":
            stored_rows.append(to_row(json))
        return None

    monkeypatch.setattr(saver, "_request_sync", request)

    class AgentState(TypedDict):
        messages: Annotated[list[BaseMessage], add_messages]

    def model_node(state: AgentState) -> dict:
        return {"messages": [AIMessage(content=f"observed {len(state['messages'])} messages")]}

    builder = StateGraph(AgentState)
    builder.add_node("model", model_node)
    builder.add_edge(START, "model")
    builder.add_edge("model", END)
    graph = builder.compile(checkpointer=saver)
    result = graph.invoke(
        {"messages": [HumanMessage(content="runtime checkpoint input", id="runtime-human")]},
        config={"configurable": {"thread_id": saver.thread_id, "checkpoint_ns": ""}},
    )

    assert result["messages"][-1].content == "observed 1 messages"
    assert len(stored_rows) >= 2
    assert all(
        "pending_sends"
        not in saver.serde.loads_typed(
            (
                row["payloadType"],
                base64.b64decode(row["payloadBase64"], validate=True),
            )
        )
        for row in stored_rows
    )
    restored = saver._tuple(stored_rows[-1])
    assert restored.checkpoint["v"] == 4
    assert "pending_sends" not in restored.checkpoint
    restored_message_ids = [
        (type(message).__name__, message.id) for message in restored.checkpoint["channel_values"].get("messages", [])
    ]
    assert any(message_id == "runtime-human" for _, message_id in restored_message_ids)


def test_versioned_tool_spec_schema_projects_only_declared_input_and_output_fields() -> None:
    schema = CheckpointSafeToolSchema(
        version="xihe.read-summary.v1",
        input_schema={
            "type": "object",
            "properties": {"path": {"type": "string", "maxLength": 128}},
            "required": ["path"],
            "additionalProperties": False,
        },
        output_schema={
            "type": "object",
            "properties": {
                "status": {"type": "string", "enum": ["ok"], "maxLength": 8},
                "summary": {"type": "string", "maxLength": 256},
            },
            "required": ["status", "summary"],
            "additionalProperties": False,
        },
    )
    spec = ToolSpec("read_summary", "read a bounded summary", {}, checkpoint_safe_schema=schema)
    saver = _saver(tool_specs=(spec,))
    assistant = AIMessage(
        content="",
        tool_calls=[
            {
                "name": "read_summary",
                "args": {"path": "README.md"},
                "id": "safe-call-1",
                "type": "tool_call",
            }
        ],
    )
    projected_call = saver._value_for_storage(assistant).tool_calls[0]
    assert projected_call["args"] == {"path": "README.md"}

    safe_output = ToolMessage(
        content=(
            CHECKPOINT_SAFE_OUTPUT_PREFIX + '{ "summary" : "bounded", "status" : "ok" }' + CHECKPOINT_SAFE_OUTPUT_SUFFIX
        ),
        tool_call_id="safe-call-1",
        name="read_summary",
        additional_kwargs={CHECKPOINT_SAFE_OUTPUT_SCHEMA_KEY: schema.version},
        status="success",
    )
    projected_output = saver._value_for_storage(safe_output)
    assert projected_output.content == (
        CHECKPOINT_SAFE_OUTPUT_PREFIX + '{"status":"ok","summary":"bounded"}' + CHECKPOINT_SAFE_OUTPUT_SUFFIX
    )
    assert projected_output.additional_kwargs == {CHECKPOINT_SAFE_OUTPUT_SCHEMA_KEY: schema.version}

    unsafe_call = assistant.model_copy(deep=True)
    unsafe_call.tool_calls[0]["args"] = {"path": "README.md", "secret": "must-not-persist"}
    with pytest.raises(RuntimeError, match="do not match their checkpoint-safe schema"):
        saver._value_for_storage(unsafe_call)
    unsafe_output = safe_output.model_copy(
        update={
            "content": CHECKPOINT_SAFE_OUTPUT_PREFIX
            + '{"status":"ok","secret":"hidden"}'
            + CHECKPOINT_SAFE_OUTPUT_SUFFIX
        }
    )
    with pytest.raises(RuntimeError, match="does not match its checkpoint-safe schema"):
        saver._value_for_storage(unsafe_output)
    with pytest.raises(ValueError, match="sensitive field name"):
        CheckpointSafeToolSchema(
            version="xihe.bad-tool.v1",
            input_schema={"type": "object", "properties": {}, "required": [], "additionalProperties": False},
            output_schema={
                "type": "object",
                "properties": {"accessToken": {"type": "string"}},
                "required": ["accessToken"],
                "additionalProperties": False,
            },
        )


def test_checkpoint_safe_tool_output_rejects_duplicate_json_keys_with_canary() -> None:
    saver = _saver()
    canary = "duplicate-checkpoint-json-canary"
    message = ToolMessage(
        content=(
            CHECKPOINT_SAFE_OUTPUT_PREFIX + f'{{"status":"{canary}","status":"ok"}}' + CHECKPOINT_SAFE_OUTPUT_SUFFIX
        ),
        tool_call_id="duplicate-call",
        name=CHECKPOINT_SAFE_PROBE_TOOL_NAME,
        additional_kwargs={CHECKPOINT_SAFE_OUTPUT_SCHEMA_KEY: CHECKPOINT_SAFE_PROBE_SCHEMA_VERSION},
        status="success",
    )

    with pytest.raises(RuntimeError, match="does not match its checkpoint-safe schema") as error:
        saver._value_for_storage(message)

    assert canary not in str(error.value)


def test_checkpoint_tuple_rejects_duplicate_json_keys_in_restored_safe_tool_output() -> None:
    saver = _saver()
    canary = "duplicate-restored-json-canary"
    message = ToolMessage(
        content=(
            CHECKPOINT_SAFE_OUTPUT_PREFIX + f'{{"status":"{canary}","status":"ok"}}' + CHECKPOINT_SAFE_OUTPUT_SUFFIX
        ),
        tool_call_id="duplicate-restored-call",
        name=CHECKPOINT_SAFE_PROBE_TOOL_NAME,
        additional_kwargs={CHECKPOINT_SAFE_OUTPUT_SCHEMA_KEY: CHECKPOINT_SAFE_PROBE_SCHEMA_VERSION},
        status="success",
    )
    checkpoint = empty_checkpoint()
    checkpoint["id"] = "checkpoint-duplicate-json"
    checkpoint["channel_values"] = {"messages": [message]}
    payload_type, payload = saver.serde.dumps_typed(checkpoint)
    row = {
        "threadId": saver.thread_id,
        "checkpointNs": "",
        "checkpointId": "checkpoint-duplicate-json",
        "parentCheckpointId": None,
        "lineageId": saver.lineage_id,
        "sourceRunId": None,
        "sessionId": saver._owner["sessionId"],
        "branchId": saver.trace_metadata["branchId"],
        "userId": saver._owner["userId"],
        "workspaceId": saver._owner["workspaceId"],
        "schemaVersion": 1,
        "createdAt": "2026-10-14T00:00:03Z",
        "producerVersion": saver.trace_metadata["producerVersion"],
        "payloadType": payload_type,
        "payloadBase64": base64.b64encode(payload).decode("ascii"),
        "metadata": {},
        "pendingWrites": [],
    }

    with pytest.raises(RuntimeError, match="does not match its checkpoint-safe schema") as error:
        saver._tuple(row)

    assert canary not in str(error.value)


def test_unknown_values_and_checkpoint_channels_fail_closed() -> None:
    saver = _saver()

    class UnknownCheckpointValue:
        pass

    with pytest.raises(RuntimeError, match="no checkpoint-safe projection"):
        saver._value_for_storage(UnknownCheckpointValue())
    with pytest.raises(RuntimeError, match="no checkpoint-safe projection"):
        saver._value_for_storage(b"opaque payload")

    checkpoint = empty_checkpoint()
    checkpoint["channel_values"] = {"messages": [HumanMessage(content="safe")], "debug": "secret"}
    with pytest.raises(RuntimeError, match="unsupported channel"):
        saver._checkpoint_for_storage(checkpoint)

    checkpoint["channel_values"] = {"messages": [UnknownCheckpointValue()]}
    with pytest.raises(RuntimeError, match="no checkpoint-safe projection"):
        saver._checkpoint_for_storage(checkpoint)

    checkpoint["channel_values"] = {"messages": [HumanMessage(content="safe")]}
    checkpoint["pending_sends"] = [UnknownCheckpointValue()]
    with pytest.raises(RuntimeError, match="pending sends"):
        saver._checkpoint_for_storage(checkpoint)


def test_checkpoint_projection_accepts_langgraph_interrupt_node() -> None:
    """PLAN-0510 A类修复：续跑恢复被中断的任务时，LangGraph 会在 versions_seen 里写入内部
    伪节点 __interrupt__；白名单必须接受它，否则续跑写 checkpoint 直接报 unsupported node。"""
    saver = _saver()
    checkpoint = empty_checkpoint()
    checkpoint["channel_values"] = {"messages": [HumanMessage(content="safe")]}
    checkpoint["versions_seen"] = {"model": {"messages": 1}, "__interrupt__": {"messages": 1}}

    projected = saver._checkpoint_for_storage(checkpoint)

    assert set(projected["versions_seen"]) == {"model", "__interrupt__"}


def test_attach_accepts_existing_lineage_and_uses_cp_provenance() -> None:
    saver = _saver()
    producer_version = "0.9.1"
    source_run_id = str(uuid4())
    result = {
        "lineageId": str(uuid4()),
        "threadId": str(uuid4()),
        "sessionId": saver._owner["sessionId"],
        "sourceRunId": source_run_id,
        "branchId": str(uuid4()),
        "userId": saver._owner["userId"],
        "workspaceId": saver._owner["workspaceId"],
        "schemaVersion": 1,
        "createdAt": "2026-10-14T00:00:00Z",
        "producerVersion": producer_version,
    }

    saver._accept_lineage(
        result,
        expected_thread_id=result["threadId"],
        expected_source_run_id=source_run_id,
        expected_probe_id=None,
        check_source_run_id=True,
        check_producer_version=False,
    )

    assert saver.thread_id == result["threadId"]
    assert saver.lineage_id == result["lineageId"]
    assert saver.trace_metadata["sourceRunId"] == result["sourceRunId"]
    assert saver.trace_metadata["producerVersion"] == producer_version
    with pytest.raises(RuntimeError, match="lineage scope mismatch"):
        saver._accept_lineage(
            result,
            expected_thread_id=result["threadId"],
            expected_source_run_id=str(uuid4()),
            expected_probe_id=None,
            check_source_run_id=True,
            check_producer_version=False,
        )


def test_async_put_writes_accepts_only_checkpoint_safe_message_channel(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    saver = _saver()
    captured: dict = {}

    async def capture(method: str, path: str, *, json=None, params=None, allow_not_found=False):
        captured.update(method=method, path=path, body=json)
        return None

    monkeypatch.setattr(saver, "_arequest", capture)
    config = {
        "configurable": {
            "thread_id": saver.thread_id,
            "checkpoint_ns": "",
            "checkpoint_id": "checkpoint-1",
        }
    }

    _run_immediate(
        saver.aput_writes(
            config,
            [("messages", HumanMessage(content="safe pending write", id="pending-message-1"))],
            task_id="task-1",
            task_path="",
        )
    )

    writes = captured["body"]["writes"]
    assert [item["channel"] for item in writes] == ["messages"]
    assert [item["writeIndex"] for item in writes] == [0]
    assert captured["body"]["taskPath"] == ""

    with pytest.raises(RuntimeError, match="Pending write channel"):
        _run_immediate(
            saver.aput_writes(config, [("__error__", HumanMessage(content="unsupported"))], task_id="task-2")
        )
    with pytest.raises(RuntimeError, match="no checkpoint-safe projection"):
        _run_immediate(saver.aput_writes(config, [("messages", "unprojected tool output")], task_id="task-3"))


def test_framework_scheduling_channel_is_skipped_without_failing_the_write(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """PLAN-0510 A+（用户 2026-10-16 裁定）：LangGraph 内部调度通道 __pregel_tasks（值为 Send，
    即"下一步派哪些任务"）不写入 checkpoint——与设计里已置空的 `pending_sends` 同类，恢复时由
    框架按图状态重算；同时不得触发 unsafe 抑制，其余安全写入照常持久化。"""
    saver = _saver()
    captured: dict = {}

    async def capture(method: str, path: str, *, json=None, params=None, allow_not_found=False):
        captured.update(method=method, body=json)
        return None

    monkeypatch.setattr(saver, "_arequest", capture)
    config = {
        "configurable": {
            "thread_id": saver.thread_id,
            "checkpoint_ns": "",
            "checkpoint_id": "checkpoint-1",
        }
    }

    class _Send:
        """代表框架的 Send：node + 该任务输入，不属于任何 checkpoint-safe 形状。"""

        def __repr__(self) -> str:
            return "Send(node='tools')"

    _run_immediate(
        saver.aput_writes(
            config,
            [
                ("__pregel_tasks", _Send()),
                ("messages", HumanMessage(content="safe after skip", id="pending-message-2")),
            ],
            task_id="task-framework",
        )
    )

    writes = captured["body"]["writes"]
    assert [item["channel"] for item in writes] == ["messages"]
    assert saver._unsafe_state_seen.is_set() is False


def test_list_without_limit_yields_bounded_pages_in_latest_first_order(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    saver = _saver()
    first_page = [{"checkpointId": f"{index:032x}"} for index in (3, 2)]
    second_page = [{"checkpointId": f"{1:032x}"}]
    calls: list[dict] = []

    def request(method: str, path: str, *, json=None, params=None, allow_not_found=False):
        calls.append(dict(method=method, path=path, params=params))
        return first_page if len(calls) == 1 else second_page[:1]

    monkeypatch.setattr(saver, "_request_sync", request)
    monkeypatch.setattr(saver, "_tuple", lambda row: row["checkpointId"])
    config = {"configurable": {"thread_id": saver.thread_id, "checkpoint_ns": ""}}
    rows = list(saver.list(config))

    assert rows == [row["checkpointId"] for row in first_page + second_page]
    assert len(calls) == 2
    assert calls[0]["params"]["limit"] == 2
    assert calls[1]["params"]["limit"] == 2
    assert calls[1]["params"]["beforeCheckpointId"] == first_page[-1]["checkpointId"]


def test_list_explicit_limit_stops_at_requested_count_across_bounded_pages(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    saver = _saver()
    first_page = [{"checkpointId": f"{index:032x}"} for index in (5, 4)]
    second_page = [{"checkpointId": f"{index:032x}"} for index in (3, 2)]
    calls: list[dict] = []

    def request(method: str, path: str, *, json=None, params=None, allow_not_found=False):
        calls.append(dict(method=method, path=path, params=params))
        return first_page if len(calls) == 1 else second_page[:1]

    monkeypatch.setattr(saver, "_request_sync", request)
    monkeypatch.setattr(saver, "_tuple", lambda row: row["checkpointId"])
    config = {"configurable": {"thread_id": saver.thread_id, "checkpoint_ns": ""}}
    rows = list(saver.list(config, limit=3))

    assert rows == [f"{value:032x}" for value in (5, 4, 3)]
    assert [call["params"]["limit"] for call in calls] == [2, 1]
    assert calls[1]["params"]["beforeCheckpointId"] == first_page[-1]["checkpointId"]


@pytest.mark.asyncio
async def test_async_list_fetches_one_bounded_page(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    saver = _saver()
    first_page = [{"checkpointId": f"{index:032x}"} for index in (2, 1)]
    second_page = [{"checkpointId": "0" * 32}]
    calls: list[dict] = []

    async def request(method: str, path: str, *, json=None, params=None, allow_not_found=False):
        calls.append(dict(method=method, path=path, params=params))
        return first_page if len(calls) == 1 else second_page

    monkeypatch.setattr(saver, "_arequest", request)
    rows = await saver._list_async(checkpoint_ns="")

    assert len(rows) == 2
    assert len(calls) == 1
    assert calls[0]["params"]["limit"] == 2


def test_checkpoint_tuple_round_trip_uses_langgraph_typed_serializer() -> None:
    saver = _saver()
    checkpoint = empty_checkpoint()
    checkpoint["id"] = "checkpoint-1"
    checkpoint["channel_values"] = {"messages": [HumanMessage(content="synthetic", id="human-1")]}
    payload_type, payload = saver.serde.dumps_typed(checkpoint)
    pending_message = ToolMessage(
        content=CHECKPOINT_SAFE_OUTPUT_PREFIX + '{"status":"ok"}' + CHECKPOINT_SAFE_OUTPUT_SUFFIX,
        tool_call_id="probe-call",
        name=CHECKPOINT_SAFE_PROBE_TOOL_NAME,
        additional_kwargs={CHECKPOINT_SAFE_OUTPUT_SCHEMA_KEY: CHECKPOINT_SAFE_PROBE_SCHEMA_VERSION},
        status="success",
    )
    write_type, write_payload = saver.serde.dumps_typed(pending_message)

    restored = saver._tuple(
        {
            "threadId": saver.thread_id,
            "checkpointNs": "",
            "checkpointId": "checkpoint-1",
            "parentCheckpointId": None,
            "lineageId": saver.lineage_id,
            "sourceRunId": None,
            "sessionId": saver._owner["sessionId"],
            "branchId": saver.trace_metadata["branchId"],
            "userId": saver._owner["userId"],
            "workspaceId": saver._owner["workspaceId"],
            "schemaVersion": 1,
            "createdAt": "2026-10-14T00:00:01Z",
            "producerVersion": saver.trace_metadata["producerVersion"],
            "payloadType": payload_type,
            "payloadBase64": base64.b64encode(payload).decode("ascii"),
            "metadata": {
                "source": "input",
                "step": 0,
                "writes": {"x": "omitted"},
                "lineageId": "untrusted-agent-value",
                "branchId": "untrusted-agent-value",
            },
            "pendingWrites": [
                {
                    "taskId": "task-1",
                    "channel": "messages",
                    "payloadType": write_type,
                    "payloadBase64": base64.b64encode(write_payload).decode("ascii"),
                    "writeIndex": 0,
                }
            ],
        }
    )

    assert restored.checkpoint["channel_values"] == {"messages": [HumanMessage(content="synthetic", id="human-1")]}
    assert restored.metadata == {
        "source": "input",
        "step": 0,
        "lineageId": saver.lineage_id,
        "sourceRunId": None,
        "checkpointId": "checkpoint-1",
        "sessionId": saver._owner["sessionId"],
        "branchId": saver.trace_metadata["branchId"],
        "userId": saver._owner["userId"],
        "workspaceId": saver._owner["workspaceId"],
        "stateSchemaVersion": saver.schema_version,
        "createdAt": "2026-10-14T00:00:01Z",
        "producerVersion": saver.trace_metadata["producerVersion"],
    }
    assert restored.pending_writes == [("task-1", "messages", pending_message)]


def test_checkpoint_tuple_revalidates_schema_and_reprojects_credential_state() -> None:
    saver = _saver()
    canary = "restore-credential-canary"
    message = ToolMessage(
        content=CREDENTIAL_DELIVERED_PLACEHOLDER,
        tool_call_id="current-call",
        name=ACQUIRE_CREDENTIAL_TOOL_NAME,
        additional_kwargs={CREDENTIAL_HANDOFF_REQUIRED_KEY: True},
        response_metadata={"secret": canary},
        artifact={"secret": canary},
        id="credential-message",
    )
    checkpoint = empty_checkpoint()
    checkpoint["id"] = "checkpoint-restore"
    checkpoint["channel_values"] = {
        "messages": [
            AIMessage(
                content="",
                tool_calls=[{"name": ACQUIRE_CREDENTIAL_TOOL_NAME, "args": {}, "id": "current-call"}],
                id="credential-call",
            ),
            message,
        ]
    }
    payload_type, payload = saver.serde.dumps_typed(checkpoint)
    row = {
        "threadId": saver.thread_id,
        "checkpointNs": "",
        "checkpointId": "checkpoint-restore",
        "parentCheckpointId": None,
        "lineageId": saver.lineage_id,
        "sourceRunId": None,
        "sessionId": saver._owner["sessionId"],
        "branchId": saver.trace_metadata["branchId"],
        "userId": saver._owner["userId"],
        "workspaceId": saver._owner["workspaceId"],
        "schemaVersion": 1,
        "createdAt": "2026-10-14T00:00:02Z",
        "producerVersion": saver.trace_metadata["producerVersion"],
        "payloadType": payload_type,
        "payloadBase64": base64.b64encode(payload).decode("ascii"),
        "metadata": {},
        "pendingWrites": [],
    }

    restored = saver._tuple(row)
    restored_message = restored.checkpoint["channel_values"]["messages"][1]
    assert restored_message.content == CREDENTIAL_DELIVERED_PLACEHOLDER
    assert restored_message.tool_call_id == "current-call"
    assert restored_message.additional_kwargs == {CREDENTIAL_HANDOFF_REQUIRED_KEY: True}
    assert restored_message.response_metadata == {}
    assert restored_message.artifact is None
    assert canary not in repr(restored)

    for invalid_version in (2, True):
        invalid_row = {**row, "schemaVersion": invalid_version}
        with pytest.raises(RuntimeError, match="lineage metadata mismatch"):
            saver._tuple(invalid_row)


def test_checkpoint_tuple_rejects_unsafe_state_and_pending_write_on_restore() -> None:
    saver = _saver()
    checkpoint = empty_checkpoint()
    checkpoint["id"] = "checkpoint-unsafe"
    checkpoint["channel_values"] = {
        "messages": [HumanMessage(content="safe")],
        "debug": "not allowed",
    }
    payload_type, payload = saver.serde.dumps_typed(checkpoint)
    write_type, write_payload = saver.serde.dumps_typed("unsafe pending")
    row = {
        "threadId": saver.thread_id,
        "checkpointNs": "",
        "checkpointId": "checkpoint-unsafe",
        "parentCheckpointId": None,
        "lineageId": saver.lineage_id,
        "sourceRunId": None,
        "sessionId": saver._owner["sessionId"],
        "branchId": saver.trace_metadata["branchId"],
        "userId": saver._owner["userId"],
        "workspaceId": saver._owner["workspaceId"],
        "schemaVersion": 1,
        "createdAt": "2026-10-14T00:00:03Z",
        "producerVersion": saver.trace_metadata["producerVersion"],
        "payloadType": payload_type,
        "payloadBase64": base64.b64encode(payload).decode("ascii"),
        "metadata": {},
        "pendingWrites": [],
    }
    with pytest.raises(RuntimeError, match="unsupported channel"):
        saver._tuple(row)

    safe = empty_checkpoint()
    safe["id"] = "checkpoint-unsafe"
    safe["channel_values"] = {"messages": [HumanMessage(content="safe")]}
    safe_type, safe_payload = saver.serde.dumps_typed(safe)
    row["payloadType"] = safe_type
    row["payloadBase64"] = base64.b64encode(safe_payload).decode("ascii")
    row["pendingWrites"] = [
        {
            "taskId": "task-1",
            "channel": "unsafe",
            "payloadType": write_type,
            "payloadBase64": base64.b64encode(write_payload).decode("ascii"),
            "writeIndex": 0,
        }
    ]
    with pytest.raises(RuntimeError, match="no checkpoint-safe projection"):
        saver._tuple(row)


def test_config_rejects_a_thread_outside_the_bound_lineage() -> None:
    saver = _saver()
    with pytest.raises(RuntimeError, match="thread scope mismatch"):
        saver._config_parts({"configurable": {"thread_id": str(uuid4())}})
