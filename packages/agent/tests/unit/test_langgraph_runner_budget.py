"""PLAN-0492 T1.5 (L0): run budget counting, exhaustion and pause semantics.

Covers the four frozen assertions:
1. an enabled dimension reaching its limit stops the loop and emits a
   ``RUN_BUDGET_EXHAUSTED`` trigger carrying the dimension;
2. staying within limits emits no trigger (no false positives);
3. counting is unconditional (failures/retries produce their own
   ``llm_usage`` events, so they consume budget by construction);
4. approval/human waits neither consume the elapsed clock nor add turns.
"""

import asyncio
import time

import pytest
from langchain_core.messages import AIMessage

import xihe_agent.agent_runner.langgraph_runner as langgraph_runner_module
from xihe_agent.adapters.approval_tool import APPROVAL_EVENT_SINK_KEY
from xihe_agent.agent_runner import LangGraphRunner
from xihe_agent.agent_runner.langgraph_runner import _exceeded_budget_dimension
from xihe_agent.interfaces.agent_runner import RunBudget, RunnerConfig
from xihe_agent.interfaces.context import AgentContext
from xihe_agent.interfaces.message import TextMessage


def _llm_usage_event(run_id: str, total_tokens: int = 2) -> dict:
    """One LLM call ending with provider usage → exactly one ``llm_usage`` event."""
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


def _trigger_dimensions(events: list) -> list[str]:
    return [
        str(e.data.get("dimension"))
        for e in events
        if e.type == "error" and e.data.get("code") == "RUN_BUDGET_EXHAUSTED"
    ]


def test_exceeded_budget_dimension_semantics():
    """Zero = dimension disabled; limits are inclusive (reaching them stops)."""
    assert _exceeded_budget_dimension(RunBudget(), llm_calls=99, total_tokens=10**9, elapsed_seconds=10**6) == ""
    assert (
        _exceeded_budget_dimension(
            RunBudget(max_turns=25), llm_calls=24, total_tokens=0, elapsed_seconds=0.0
        )
        == ""
    )
    assert (
        _exceeded_budget_dimension(
            RunBudget(max_turns=25), llm_calls=25, total_tokens=0, elapsed_seconds=0.0
        )
        == "turns"
    )
    assert (
        _exceeded_budget_dimension(
            RunBudget(max_elapsed_seconds=600), llm_calls=0, total_tokens=0, elapsed_seconds=600.0
        )
        == "elapsed"
    )
    assert (
        _exceeded_budget_dimension(
            RunBudget(max_tokens=100), llm_calls=0, total_tokens=100, elapsed_seconds=0.0
        )
        == "tokens"
    )


@pytest.mark.asyncio
async def test_turns_budget_stops_loop_and_emits_trigger(monkeypatch):
    """Assertion 1: reaching the turn limit stops consumption and reports the dimension."""
    consumed: list[str] = []

    class FakeAgent:
        async def astream_events(self, _inputs, version, **kwargs):
            for i in range(5):
                consumed.append(f"m{i}")
                yield _llm_usage_event(f"m{i}")

    monkeypatch.setattr(langgraph_runner_module, "build_react_graph", lambda _model, tools, **_kwargs: FakeAgent())
    runner = LangGraphRunner(model_factory=lambda _model: object())
    config = RunnerConfig(
        model="fake",
        system_prompt="",
        tools=[],
        context=AgentContext.empty("session-budget-turns"),
        budget=RunBudget(max_turns=2),
    )

    events = await _collect(runner, config)

    assert _trigger_dimensions(events) == ["turns"]
    # The loop stopped at the limit: only the first two LLM calls were consumed.
    assert consumed == ["m0", "m1"]
    assert len([e for e in events if e.type == "llm_usage"]) == 2


@pytest.mark.asyncio
async def test_budget_within_limits_emits_no_trigger(monkeypatch):
    """Assertion 2: no false positives when every dimension stays under its limit."""

    class FakeAgent:
        async def astream_events(self, _inputs, version, **kwargs):
            yield _llm_usage_event("m0")
            yield _llm_usage_event("m1")

    monkeypatch.setattr(langgraph_runner_module, "build_react_graph", lambda _model, tools, **_kwargs: FakeAgent())
    runner = LangGraphRunner(model_factory=lambda _model: object())
    config = RunnerConfig(
        model="fake",
        system_prompt="",
        tools=[],
        context=AgentContext.empty("session-budget-ok"),
        budget=RunBudget(max_turns=5, max_elapsed_seconds=600, max_tokens=0),
    )

    events = await _collect(runner, config)

    assert _trigger_dimensions(events) == []
    assert len([e for e in events if e.type == "llm_usage"]) == 2


@pytest.mark.asyncio
async def test_tokens_dimension_counts_every_llm_usage(monkeypatch):
    """Assertions 1+3: token counting is unconditional — no success filter exists."""

    class FakeAgent:
        async def astream_events(self, _inputs, version, **kwargs):
            yield _llm_usage_event("m0", total_tokens=2)
            # A non-LLM event between calls must not reset or filter the counter.
            yield {"event": "on_chain_end", "name": "LangGraph", "data": {}, "run_id": "graph"}
            yield _llm_usage_event("m1", total_tokens=2)

    monkeypatch.setattr(langgraph_runner_module, "build_react_graph", lambda _model, tools, **_kwargs: FakeAgent())
    runner = LangGraphRunner(model_factory=lambda _model: object())
    config = RunnerConfig(
        model="fake",
        system_prompt="",
        tools=[],
        context=AgentContext.empty("session-budget-tokens"),
        budget=RunBudget(max_tokens=3),
    )

    events = await _collect(runner, config)

    # cumulative 2 then 4 → the limit (3) is reached on the second call.
    assert _trigger_dimensions(events) == ["tokens"]


@pytest.mark.asyncio
async def test_elapsed_budget_excludes_approval_wait(monkeypatch):
    """Assertion 4: a long human wait must not consume the elapsed budget."""
    context = AgentContext.empty("session-budget-elapsed")

    class FakeAgent:
        async def astream_events(self, _inputs, version, **kwargs):
            await asyncio.sleep(0.2)
            yield _llm_usage_event("m0")
            sink = context.metadata.get(APPROVAL_EVENT_SINK_KEY)
            if sink is not None:
                await sink({"requestId": "req-1", "toolName": "apply_patch"})
                await asyncio.sleep(1.5)
            yield _llm_usage_event("m1")

    monkeypatch.setattr(langgraph_runner_module, "build_react_graph", lambda _model, tools, **_kwargs: FakeAgent())
    runner = LangGraphRunner(model_factory=lambda _model: object())
    config = RunnerConfig(
        model="fake",
        system_prompt="",
        tools=[],
        context=context,
        budget=RunBudget(max_elapsed_seconds=1),
    )

    started = time.monotonic()
    events = await _collect(runner, config)
    wall_seconds = time.monotonic() - started

    # The run really outlived the budget in wall-clock terms...
    assert wall_seconds > 1.0
    # ...yet the approval wait was excluded, so no dimension was exhausted.
    assert _trigger_dimensions(events) == []
