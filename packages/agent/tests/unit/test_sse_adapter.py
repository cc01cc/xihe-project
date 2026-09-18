import json
from collections.abc import AsyncIterator
from typing import Any

import pytest
from langchain_core.messages import AIMessage, ToolMessage

from xihe_agent.adapters.sse_adapter import LangGraphEventAdapter, translate_events


class FakeChunk:
    def __init__(self, content: str):
        self.content = content


async def async_iter(items: list[dict[str, Any]]) -> AsyncIterator[dict[str, Any]]:
    for item in items:
        yield item


@pytest.mark.asyncio
async def test_translate_token_event():
    events = [
        {
            "event": "on_chat_model_stream",
            "name": "ChatModel",
            "data": {"chunk": FakeChunk("你好")},
            "run_id": "run-1",
        }
    ]
    results = []
    async for sse in translate_events(async_iter(events)):
        results.append(sse)

    assert len(results) == 1
    assert results[0].startswith("event: token\n")
    payload = json.loads(results[0].removeprefix("event: token\ndata: ").strip())
    assert payload["content"] == "你好"
    assert payload["type"] == "token"
    assert payload["run_id"] == "run-1"


@pytest.mark.asyncio
async def test_translate_token_ignores_empty_chunk():
    events = [
        {
            "event": "on_chat_model_stream",
            "name": "ChatModel",
            "data": {"chunk": FakeChunk("")},
            "run_id": "run-1",
        }
    ]
    results = []
    async for sse in translate_events(async_iter(events)):
        results.append(sse)
    assert len(results) == 0


@pytest.mark.asyncio
async def test_translate_tool_start():
    events = [
        {
            "event": "on_tool_start",
            "name": "read_file",
            "data": {"input": {"path": "test.txt"}},
            "run_id": "run-2",
        }
    ]
    results = []
    async for sse in translate_events(async_iter(events)):
        results.append(sse)

    assert len(results) == 1
    payload = json.loads(results[0].removeprefix("event: tool_call\ndata: ").strip())
    assert payload["tool"] == "read_file"
    assert payload["arguments"] == {"path": "test.txt"}
    assert payload["type"] == "tool_call"
    assert payload["run_id"] == "run-2"
    # PLAN-0317 T2.8④：显式携带 toolCallId（回退工具级 run_id）。
    assert payload["toolCallId"] == "run-2"


@pytest.mark.asyncio
async def test_translate_tool_end_with_tool_message():
    events = [
        {
            "event": "on_tool_end",
            "name": "read_file",
            "data": {"output": ToolMessage(content="file content", tool_call_id="call-1")},
            "run_id": "run-3",
        }
    ]
    results = []
    async for sse in translate_events(async_iter(events)):
        results.append(sse)

    assert len(results) == 1
    payload = json.loads(results[0].removeprefix("event: tool_result\ndata: ").strip())
    assert payload["tool"] == "read_file"
    assert payload["result"] == "file content"
    assert payload["type"] == "tool_result"
    assert payload["run_id"] == "run-3"
    # PLAN-0317 T2.8④：结果事件用 ToolMessage 的真实 tool_call_id。
    assert payload["toolCallId"] == "call-1"


@pytest.mark.asyncio
async def test_translate_stream_and_end_does_not_duplicate_content():
    events = [
        {
            "event": "on_chat_model_stream",
            "name": "ChatModel",
            "data": {"chunk": FakeChunk("Hel")},
            "run_id": "run-stream",
        },
        {
            "event": "on_chat_model_stream",
            "name": "ChatModel",
            "data": {"chunk": FakeChunk("lo")},
            "run_id": "run-stream",
        },
        {
            "event": "on_chat_model_end",
            "name": "ChatModel",
            "data": {"output": AIMessage(content="Hello")},
            "run_id": "run-stream",
        },
    ]

    results = []
    async for sse in translate_events(async_iter(events)):
        results.append(sse)

    assert len(results) == 2
    payloads = [json.loads(item.removeprefix("event: token\ndata: ").strip()) for item in results]
    assert [payload["content"] for payload in payloads] == ["Hel", "lo"]


@pytest.mark.asyncio
async def test_translate_end_falls_back_once_without_stream_chunk():
    events = [
        {
            "event": "on_chat_model_end",
            "name": "ChatModel",
            "data": {"output": AIMessage(content="complete")},
            "run_id": "run-fallback",
        }
    ]

    results = []
    async for sse in translate_events(async_iter(events)):
        results.append(sse)

    assert len(results) == 1
    payload = json.loads(results[0].removeprefix("event: token\ndata: ").strip())
    assert payload["content"] == "complete"


def test_streamed_state_is_isolated_by_run_id():
    adapter = LangGraphEventAdapter()
    streamed = adapter.translate(
        {
            "event": "on_chat_model_stream",
            "data": {"chunk": FakeChunk("streamed")},
            "run_id": "run-1",
        }
    )
    fallback = adapter.translate(
        {
            "event": "on_chat_model_end",
            "data": {"output": AIMessage(content="fallback")},
            "run_id": "run-2",
        }
    )
    streamed_end = adapter.translate(
        {
            "event": "on_chat_model_end",
            "data": {"output": AIMessage(content="streamed")},
            "run_id": "run-1",
        }
    )

    assert streamed is not None
    # PLAN-294 M1: translate() returns a list for on_chat_model_end (usage
    # event first when the output carries usage_metadata, then the token
    # fallback); a streamed end without usage yields nothing (None, as before).
    assert isinstance(fallback, list) and len(fallback) == 1
    assert fallback[0].data["content"] == "fallback"
    assert streamed_end is None


@pytest.mark.asyncio
async def test_translate_tool_end_with_raw_output():
    events = [
        {
            "event": "on_tool_end",
            "name": "list_dir",
            "data": {"output": "src\ntests\n"},
            "run_id": "run-4",
        }
    ]
    results = []
    async for sse in translate_events(async_iter(events)):
        results.append(sse)

    assert len(results) == 1
    payload = json.loads(results[0].removeprefix("event: tool_result\ndata: ").strip())
    assert payload["tool"] == "list_dir"
    assert "src" in payload["result"]


@pytest.mark.asyncio
async def test_adapter_translate_returns_agent_event():
    adapter = LangGraphEventAdapter()
    event = {
        "event": "on_tool_start",
        "name": "read_file",
        "data": {"input": {"path": "test.txt"}},
        "run_id": "run-8",
    }
    result = adapter.translate(event)
    assert result is not None
    assert result.type == "tool_call"
    assert result.data["tool"] == "read_file"
    assert result.data["run_id"] == "run-8"


@pytest.mark.asyncio
async def test_translate_chain_end():
    events = [
        {
            "event": "on_chain_end",
            "name": "LangGraph",
            "data": {},
            "run_id": "run-5",
        }
    ]
    results = []
    async for sse in translate_events(async_iter(events)):
        results.append(sse)

    assert len(results) == 1
    assert results[0].startswith("event: done\n")
    payload = json.loads(results[0].removeprefix("event: done\ndata: ").strip())
    assert payload["type"] == "done"
    assert payload["run_id"] == "run-5"


@pytest.mark.asyncio
async def test_translate_llm_error():
    events = [
        {
            "event": "on_llm_error",
            "name": "ChatModel",
            "data": {"error": "Rate limit exceeded"},
            "run_id": "run-6",
        }
    ]
    results = []
    async for sse in translate_events(async_iter(events)):
        results.append(sse)

    assert len(results) == 1
    assert results[0].startswith("event: error\n")
    payload = json.loads(results[0].removeprefix("event: error\ndata: ").strip())
    assert "Rate limit exceeded" in payload["error"]
    assert payload["type"] == "error"


@pytest.mark.asyncio
async def test_unknown_event_passthrough():
    events = [
        {
            "event": "on_custom_event",
            "name": "Custom",
            "data": {"key": "value"},
            "run_id": "run-7",
        },
        {
            "event": "on_chain_start",
            "name": "SomeChain",
            "data": {},
            "run_id": "run-8",
        },
    ]
    results = []
    async for sse in translate_events(async_iter(events)):
        results.append(sse)
    assert len(results) == 0


# ── PLAN-0326 决策 #9：事件 origin 判别 + 审批原语孤儿事件抑制 ──────────────────


def _parse(result: str) -> dict[str, Any]:
    prefix = result.split("\ndata: ", 1)[0]
    return json.loads(result.removeprefix(prefix + "\ndata: ").strip())


@pytest.mark.asyncio
async def test_tool_events_default_origin_mcp():
    adapter = LangGraphEventAdapter()
    events = [
        {"event": "on_tool_start", "name": "read_file", "data": {"input": {}}, "run_id": "run-9"},
        {
            "event": "on_tool_end",
            "name": "read_file",
            "data": {"output": ToolMessage(content="ok", tool_call_id="call-9")},
            "run_id": "run-9",
        },
    ]
    translated = [e for raw in events for e in _as_list(adapter.translate(raw))]
    assert [e.data["origin"] for e in translated] == ["mcp", "mcp"]


@pytest.mark.asyncio
async def test_tool_events_local_origin_for_custom_tools():
    adapter = LangGraphEventAdapter(local_tool_names={"request_approval", "generate_image"})
    events = [
        {"event": "on_tool_start", "name": "generate_image", "data": {"input": {}}, "run_id": "run-10"},
        {
            "event": "on_tool_end",
            "name": "generate_image",
            "data": {"output": ToolMessage(content="img", tool_call_id="call-10")},
            "run_id": "run-10",
        },
    ]
    translated = [e for raw in events for e in _as_list(adapter.translate(raw))]
    assert [e.data["origin"] for e in translated] == ["local", "local"]


@pytest.mark.asyncio
async def test_request_approval_tool_result_suppressed():
    adapter = LangGraphEventAdapter(local_tool_names={"request_approval", "generate_image"})
    events = [
        {
            "event": "on_tool_end",
            "name": "request_approval",
            "data": {"output": ToolMessage(content="approved", tool_call_id="call-a")},
            "run_id": "run-11",
        },
    ]
    assert [e for raw in events for e in _as_list(adapter.translate(raw))] == []


@pytest.mark.asyncio
async def test_request_approval_tool_call_also_suppressed():
    adapter = LangGraphEventAdapter(local_tool_names={"request_approval", "generate_image"})
    events = [
        {"event": "on_tool_start", "name": "request_approval", "data": {"input": {}}, "run_id": "run-12"},
    ]
    assert [e for raw in events for e in _as_list(adapter.translate(raw))] == []


def _as_list(value):
    if value is None:
        return []
    return value if isinstance(value, list) else [value]


# ── PLAN-0342 T1.2：诊断从 ToolMessage artifact 复制到 SSE tool_result ────────

DIAGNOSTICS_BUNDLE = {
    "items": [
        {
            "file": "src/a.rs",
            "line": 3,
            "column": 1,
            "severity": "error",
            "kind": "compile",
            "message": "boom",
            "confidence": "high",
        }
    ],
    "total": 1,
    "confidence": "high",
}


@pytest.mark.asyncio
async def test_tool_end_copies_diagnostics_artifact_into_event_data():
    events = [
        {
            "event": "on_tool_end",
            "name": "execute_command",
            "data": {
                "output": ToolMessage(
                    content="raw output",
                    tool_call_id="call-diag",
                    artifact={"diagnostics": DIAGNOSTICS_BUNDLE},
                )
            },
            "run_id": "run-20",
        }
    ]
    results = []
    async for sse in translate_events(async_iter(events)):
        results.append(sse)

    assert len(results) == 1
    payload = _parse(results[0])
    assert payload["result"] == "raw output"
    assert payload["toolCallId"] == "call-diag"
    assert payload["diagnostics"] == DIAGNOSTICS_BUNDLE


@pytest.mark.asyncio
async def test_tool_end_without_artifact_has_no_diagnostics_key():
    events = [
        {
            "event": "on_tool_end",
            "name": "read_file",
            "data": {"output": ToolMessage(content="file", tool_call_id="call-plain")},
            "run_id": "run-21",
        }
    ]
    results = []
    async for sse in translate_events(async_iter(events)):
        results.append(sse)

    payload = _parse(results[0])
    assert "diagnostics" not in payload


@pytest.mark.asyncio
async def test_tool_end_ignores_non_dict_or_empty_diagnostics_artifact():
    events = [
        {
            "event": "on_tool_end",
            "name": "read_file",
            "data": {"output": ToolMessage(content="a", tool_call_id="call-a", artifact="not-a-dict")},
            "run_id": "run-22",
        },
        {
            "event": "on_tool_end",
            "name": "read_file",
            "data": {"output": ToolMessage(content="b", tool_call_id="call-b", artifact={"diagnostics": None})},
            "run_id": "run-23",
        },
        {
            "event": "on_tool_end",
            "name": "read_file",
            "data": {"output": ToolMessage(content="c", tool_call_id="call-c", artifact={"diagnostics": {}})},
            "run_id": "run-24",
        },
    ]
    results = []
    async for sse in translate_events(async_iter(events)):
        results.append(sse)

    assert len(results) == 3
    for result in results:
        assert "diagnostics" not in _parse(result)
