"""task-52 / D-1901: guidance injection must not shift the provider baseline window.

``GuidanceInjectionModel`` appends transient HumanMessages to the very first model
call of a Run. ``ApiChatModel._body`` froze ``_initial_count = len(messages)`` on that
call, so the injected message was counted as durable baseline: the envelope was never
spliced into the first request body (consumed on CP but silently never sent), and from
the second step on the suffix window started one message too late, dropping this Run's
own ``assistant(tool_calls)`` while keeping its ``tool`` result. A provider rejects that
orphan with 400 "tool must be a response to tool_calls".

Both assertions below are red on the pre-fix shape and green once the baseline is
``len(messages) - len(injected)``.
"""

from __future__ import annotations

import json
from typing import Any
from unittest.mock import AsyncMock

from test_api_request_runtime import TYPES, VALUES, body, grant, recorder, response

from xihe_agent.adapters.api_chat_model import ApiChatModel, native_tools
from xihe_agent.agent_runner import LangGraphRunner
from xihe_agent.agent_runner.guidance import ENVELOPE_PREFIX, GuidanceInjectionModel, injected_baseline_kwargs
from xihe_agent.interfaces.agent_runner import RunnerConfig
from xihe_agent.interfaces.context import AgentContext
from xihe_agent.interfaces.message import TextMessage
from xihe_agent.interfaces.tool import ToolSpec
from xihe_agent.llm.api_request import chat_type

GUIDANCE_ID = "g-1"
GUIDANCE_TEXT = "also read the changelog before answering"


class ScriptedConsumer:
    """The ``GuidanceConsumer`` surface the wrapper uses: collect_new() + consume(id)."""

    def __init__(self, items: list[dict[str, Any]]) -> None:
        self._items = list(items)
        self.consumed: list[str] = []

    async def collect_new(self) -> list[dict[str, Any]]:
        items, self._items = self._items, []
        return items

    async def consume(self, guidance_id: str) -> bool:
        self.consumed.append(guidance_id)
        return True


class ReadTool:
    spec = ToolSpec("read_file", "read fixture", {"type": "object", "properties": {}})

    def __init__(self) -> None:
        self.calls = 0

    async def execute(self, input: Any, context: Any) -> dict[str, Any]:
        self.calls += 1
        return {"content": "tool-result"}


async def run_guidance_tool_loop() -> tuple[ApiChatModel, ScriptedConsumer, list[Any], list[Any]]:
    """One real runner turn: the provider asks for a tool while guidance is pending.

    The OpenAI-compatible apiType is used because it is the shape whose request body
    carries ``assistant.tool_calls`` / ``tool.tool_call_id``; the defect itself is the
    format-independent baseline arithmetic in ``ApiChatModel._body``.
    """
    type_id = TYPES[0]
    tool = ReadTool()
    consumer = ScriptedConsumer([{"id": GUIDANCE_ID, "sequence": 1, "content": GUIDANCE_TEXT}])
    async with recorder(lambda index: response(type_id, index == 1)) as (base, captures):
        inner = ApiChatModel(
            api_type=chat_type(type_id, 1),
            grant=grant(type_id, base),
            body_source=json.dumps(body(type_id, False)),
            values={**VALUES, "tools": native_tools([tool], chat_type(type_id, 1))},
            request_id="request-fixture",
            timeout=3,
        )
        context = AgentContext.empty("session-fixture")
        context.metadata.update(runId="run-fixture")
        store = type("Store", (), {"append": AsyncMock()})()
        runner = LangGraphRunner(
            model_factory=lambda name: GuidanceInjectionModel(consumer=consumer, inner=inner),
            event_store=store,
        )
        events = [
            event
            async for event in runner.stream(
                [TextMessage("human", VALUES["user_input"])],
                RunnerConfig(
                    model="fixture",
                    system_prompt="",
                    tools=[tool],
                    context=context,
                    template_context=True,
                    admitted_prompt=VALUES["user_input"],
                    prune_window_chars=80000,
                ),
            )
        ]
    return inner, consumer, captures, events


def orphan_tool_results(records: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Tool results whose ``tool_call_id`` has no preceding assistant tool_calls turn."""
    open_calls: set[str] = set()
    orphans: list[dict[str, Any]] = []
    for record in records:
        role = record.get("role")
        if role == "assistant":
            open_calls = {str(call.get("id")) for call in record.get("tool_calls") or []}
        elif role == "tool" and str(record.get("tool_call_id")) not in open_calls:
            orphans.append(record)
    return orphans


def test_injected_baseline_kwargs_only_targets_models_that_declare_it() -> None:
    """Compatibility: an inner model without ``injected_count`` keeps the old call shape."""

    def strict(messages: Any) -> None:
        raise AssertionError(messages)

    def permissive(messages: Any, **kwargs: Any) -> None:
        raise AssertionError((messages, kwargs))

    def aware(messages: Any, *, injected_count: int = 0) -> None:
        raise AssertionError((messages, injected_count))

    item = {"id": GUIDANCE_ID}
    assert injected_baseline_kwargs(strict, [item]) == {}
    assert injected_baseline_kwargs(permissive, [item]) == {"injected_count": 1}
    assert injected_baseline_kwargs(aware, [item]) == {"injected_count": 1}
    assert injected_baseline_kwargs(aware, []) == {}


async def test_guidance_injection_keeps_every_tool_result_paired_with_its_assistant_turn() -> None:
    _inner, consumer, captures, events = await run_guidance_tool_loop()

    assert not [event for event in events if event.type == "error"]
    assert consumer.consumed == [GUIDANCE_ID]
    assert len(captures) == 2
    # Assertion 1: no request body may carry a tool result without its tool_calls turn.
    assert {index: orphan_tool_results(payload["messages"]) for index, (_, _, payload) in enumerate(captures)} == {
        0: [],
        1: [],
    }


async def test_consumed_guidance_envelope_reaches_the_provider_and_stays_transient() -> None:
    inner, consumer, captures, _events = await run_guidance_tool_loop()

    assert consumer.consumed == [GUIDANCE_ID]
    # Assertion 2: a consumed guidance id must actually appear on the wire at least once
    # (a consume that is acknowledged but never injected is the silent failure mode).
    assert any(ENVELOPE_PREFIX in json.dumps(payload["messages"]) for _, _, payload in captures)
    assert any(GUIDANCE_TEXT in json.dumps(payload["messages"]) for _, _, payload in captures)
    # Transient by contract: injection shapes one call only, never the durable carrier.
    assert ENVELOPE_PREFIX not in json.dumps(inner.native_records)
