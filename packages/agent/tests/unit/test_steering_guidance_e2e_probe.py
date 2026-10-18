"""PLAN-0529 integration probe: real LangGraphRunner + Guidance pre-injection.

Drives the REAL `LangGraphRunner` -> `build_react_graph` (locked LangGraph) with
a scripted tool-calling model wrapped by `GuidanceInjectionModel`, a fake
consumer, and counting tools. Asserts the frozen consumption point (the next
model call sees injected guidance AFTER the whole tool batch completed), the
injection envelope, consume timing, and that no tool side effect is replayed.
"""

import json
from typing import Any

import pytest
from langchain_core.messages import AIMessage, AIMessageChunk, HumanMessage
from langchain_core.outputs import ChatGeneration, ChatGenerationChunk, ChatResult

from xihe_agent.agent_runner.guidance import GuidanceConsumer, GuidanceInjectionModel
from xihe_agent.agent_runner.langgraph_runner import LangGraphRunner
from xihe_agent.interfaces.agent_runner import RunnerConfig
from xihe_agent.interfaces.message import TextMessage
from xihe_agent.interfaces.tool import ToolSpec
from xihe_agent.llm.base import MockChatModel

_SCRIPT: list[AIMessage] = []
_CALL_INDEX = {"i": 0}
_EXECUTIONS: list[tuple[str, int]] = []
_PROMPTS_SEEN: list[list[str]] = []


class ScriptedToolCallModel:
    """Minimal scripted chat model: records the messages it is invoked with."""

    def bind_tools(self, tools: Any, **kwargs: Any) -> "ScriptedToolCallModel":
        return self

    def _next(self) -> AIMessage:
        index = min(_CALL_INDEX["i"], len(_SCRIPT) - 1)
        _CALL_INDEX["i"] += 1
        return _SCRIPT[index]

    def _record(self, messages: list[Any]) -> None:
        texts = []
        for message in messages:
            if isinstance(message, HumanMessage):
                texts.append(str(message.content))
        _PROMPTS_SEEN.append(texts)

    async def _agenerate(self, messages: list[Any], stop: Any = None,
                         run_manager: Any = None, **kwargs: Any) -> ChatResult:
        self._record(messages)
        return ChatResult(generations=[ChatGeneration(message=self._next())])

    async def _astream(self, messages: list[Any], stop: Any = None,
                       run_manager: Any = None, **kwargs: Any) -> Any:
        self._record(messages)
        message = self._next()
        chunks = [
            {"name": call["name"], "args": json.dumps(call["args"]), "id": call["id"], "index": i}
            for i, call in enumerate(message.tool_calls or [])
        ]
        yield ChatGenerationChunk(message=AIMessageChunk(content=message.content, tool_call_chunks=chunks))


class RecordingConsumer(GuidanceConsumer):
    """GuidanceConsumer with the HTTP client replaced by scripted responses."""

    def __init__(self, script: list[tuple[int, list[dict[str, Any]]]]) -> None:
        super().__init__(base_url="http://cp.test", service_token="svc", run_id="run-1")
        self._script = script
        self.consumed: list[str] = []

    async def fetch_pending(self) -> list[dict[str, Any]]:
        index = min(_CALL_INDEX["i"], len(self._script) - 1)
        return self._script[index][1]

    async def consume(self, guidance_id: str) -> bool:
        self.consumed.append(guidance_id)
        self.injected_ids.add(guidance_id)
        return True


class CountingTool:
    def __init__(self) -> None:
        self._spec = ToolSpec(
            name="probe_tool",
            description="probe tool",
            input_schema={
                "type": "object",
                "properties": {"n": {"type": "string"}},
                "required": ["n"],
            },
        )

    @property
    def spec(self) -> ToolSpec:
        return self._spec

    async def execute(self, input: dict, context: dict) -> dict:  # noqa: A002
        _EXECUTIONS.append((str(input.get("n")), _CALL_INDEX["i"]))
        return {"content": f"ok:{input.get('n')}"}


def _reset(script: list[AIMessage]) -> None:
    global _SCRIPT
    _SCRIPT = script
    _CALL_INDEX["i"] = 0
    _EXECUTIONS.clear()
    _PROMPTS_SEEN.clear()


def _guidance(id_: str, seq: int, content: str) -> dict[str, Any]:
    return {"id": id_, "sequence": seq, "sourceKind": "user", "content": content}


@pytest.mark.asyncio
async def test_guidance_injected_at_batch_boundary_before_next_planning() -> None:
    # Guidance arrives after the run started (a user steers mid-run): call 1
    # (the first planning step) sees nothing; call 2 — the first boundary after
    # the whole tool batch completed — sees the envelope.
    _reset([
        AIMessage(content="", tool_calls=[
            {"name": "probe_tool", "args": {"n": "a"}, "id": "call_a"},
            {"name": "probe_tool", "args": {"n": "b"}, "id": "call_b"},
        ]),
        AIMessage(content="final"),
    ])
    consumer = RecordingConsumer([(0, []), (1, [_guidance("g1", 1, "prefer the smaller change")]), (2, [])])

    runner = LangGraphRunner(model_factory=lambda _model: GuidanceInjectionModel(
        consumer=consumer, inner=ScriptedToolCallModel()))
    config = RunnerConfig(model="mock", system_prompt="probe", tools=[CountingTool()])
    events = [event async for event in runner.stream([TextMessage(role="human", content="go")], config)]

    assert sorted(name for name, _ in _EXECUTIONS) == ["a", "b"]
    assert all(model_index == 1 for _, model_index in _EXECUTIONS), "batch completed before call 2"
    assert _CALL_INDEX["i"] == 2

    # Call 1 (the first planning step) saw no guidance envelope.
    assert not any("[guidance]" in text for text in _PROMPTS_SEEN[0])
    # Call 2 (after the batch) saw the envelope, after the tool results.
    call2 = "\n".join(_PROMPTS_SEEN[1])
    assert "[guidance]" in call2
    assert "source=user" in call2
    assert "prefer the smaller change" in call2
    assert consumer.consumed == ["g1"], "consume follows the injection"
    assert events and any(event.type == "done" for event in events)


@pytest.mark.asyncio
async def test_multiple_guidance_items_follow_cp_sequence_order() -> None:
    _reset([AIMessage(content="final")])
    consumer = RecordingConsumer([(
        0,
        [_guidance("g-b", 2, "second"), _guidance("g-a", 1, "first")],
    )])

    runner = LangGraphRunner(model_factory=lambda _model: GuidanceInjectionModel(
        consumer=consumer, inner=ScriptedToolCallModel()))
    config = RunnerConfig(model="mock", system_prompt="probe", tools=[CountingTool()])
    async for _ in runner.stream([TextMessage(role="human", content="go")], config):
        break

    call1 = "\n".join(_PROMPTS_SEEN[0])
    assert call1.index("first") < call1.index("second"), "CP sequence order is preserved"
    assert set(consumer.consumed) == {"g-a", "g-b"}


@pytest.mark.asyncio
async def test_consumer_absence_keeps_runner_behavior_unchanged() -> None:
    # No consumer wired (registry workers, unit calls): the runner must behave
    # exactly as before PLAN-0529. MockChatModel is a real BaseChatModel.
    runner = LangGraphRunner(model_factory=lambda _model: MockChatModel())
    config = RunnerConfig(model="mock", system_prompt="probe", tools=[CountingTool()])
    events = []
    async for event in runner.stream([TextMessage(role="human", content="go")], config):
        events.append(event)
        if event.type in {"done", "error"}:
            break
    assert any(event.type == "done" for event in events), [e.type for e in events]
    assert not any("[guidance]" in str(event.data) for event in events)
