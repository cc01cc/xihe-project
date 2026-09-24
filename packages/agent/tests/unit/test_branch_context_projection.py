"""PLAN-0410 T2.3/T2.4: branch-aware context projection input for the Agent.

Covers: the snapshot request carries the CP-validated branch selectors; the
loaded `AgentContext`/`RunnerConfig` consume the CP-given branch; run-scoped
Event writers carry `correlation_id=runId`; required append failures converge
the run to failure; and a branch-A context never contains branch-B facts
(messages / tool results / summary / tombstones) — in BOTH directions.
"""

import json
from urllib.parse import parse_qs, urlparse

import httpx
import pytest

import xihe_agent.agent_runner.langgraph_runner as langgraph_runner_module
from xihe_agent.agent_runner import LangGraphRunner
from xihe_agent.context.event_sourced_provider import EventSourcedContextProvider
from xihe_agent.context.store_client import CPContextServiceClient
from xihe_agent.interfaces.agent_runner import RunnerConfig
from xihe_agent.interfaces.context import AgentContext
from xihe_agent.interfaces.message import TextMessage
from xihe_agent.interfaces.tool import ToolSpec
from xihe_agent.llm.base import create_llm

LCToolAdapter = langgraph_runner_module.LCToolAdapter


class FakeTool:
    """Minimal tool for driving the LCToolAdapter event writers."""

    def __init__(self) -> None:
        self._spec = ToolSpec(
            name="fake_tool",
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


class RecordingEventStore:
    """In-memory EventStore double; can fail selected event types on demand."""

    def __init__(self, fail_types: set[str] | None = None) -> None:
        self.events = []
        self.fail_types = fail_types or set()

    async def append(self, event):
        if event.type in self.fail_types:
            raise RuntimeError(f"event store unavailable for {event.type}")
        self.events.append(event)
        return event.with_sequence(len(self.events))

    async def append_many(self, aggregate_id, events):
        return [await self.append(e) for e in events]

    async def read(self, aggregate_id, after_sequence=0):
        for event in self.events:
            if event.sequence > after_sequence:
                yield event

    async def get_latest_sequence(self, aggregate_id):
        return len(self.events)

    async def fork(self, source_aggregate_id, at_sequence, new_aggregate_id):
        raise NotImplementedError


def _context_with_run(branch_id: str = "") -> AgentContext:
    context = AgentContext.empty("session-1")
    context.metadata["runId"] = "run-123"
    context.branch_id = branch_id
    return context


# ---------------------------------------------------------------------------
# T2.3: snapshot request + AgentContext/RunnerConfig consume the CP branch
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_snapshot_request_carries_run_and_branch_selectors():
    captured: dict[str, str] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["query"] = urlparse(str(request.url)).query
        return httpx.Response(
            200,
            json={"aggregate_id": "session-1", "branch_id": "branch-a", "messages": []},
        )

    client = CPContextServiceClient("http://cp.test", "token")
    client._client = httpx.AsyncClient(transport=httpx.MockTransport(handler))

    snapshot = await client.get_context_snapshot(
        "session-1", after_sequence=0, run_id="run-1", branch_id="branch-a"
    )

    query = parse_qs(captured["query"])
    assert query["afterSequence"] == ["0"]
    assert query["runId"] == ["run-1"]
    assert query["branchId"] == ["branch-a"]
    assert snapshot["branch_id"] == "branch-a"


@pytest.mark.asyncio
async def test_provider_load_passes_run_id_and_returns_cp_given_branch():
    captured: dict[str, object] = {}

    class StubClient:
        async def get_context_snapshot(self, session_id, after_sequence=0, run_id=None, branch_id=None):
            captured.update(
                session_id=session_id,
                after_sequence=after_sequence,
                run_id=run_id,
                branch_id=branch_id,
            )
            return {
                "aggregate_id": session_id,
                "branch_id": "branch-a",
                "messages": [{"role": "human", "content": "A prompt"}],
            }

    provider = EventSourcedContextProvider(StubClient())
    context = await provider.load("session-1", after_sequence=0, run_id="run-1")

    assert captured["run_id"] == "run-1"
    assert context.branch_id == "branch-a"
    assert context.messages[0].content == "A prompt"


def test_agent_context_snapshot_roundtrips_branch_id():
    snapshot = {
        "aggregate_id": "session-1",
        "latest_sequence": 7,
        "branch_id": "branch-b",
        "messages": [{"role": "human", "content": "hi"}],
        "epoch": None,
        "runtime_state": {},
        "metadata": {},
    }
    restored = AgentContext.from_snapshot(snapshot)
    assert restored.branch_id == "branch-b"
    assert restored.to_snapshot()["branch_id"] == "branch-b"


def test_runner_config_carries_branch_and_builds_prompt_from_branch_context():
    """The LangGraph prompt consumes exactly the CP-given branch context."""
    context_a = AgentContext.from_snapshot(_branch_snapshot("branch-a", "A-marker"))
    config = RunnerConfig(
        model="mock",
        system_prompt="base system prompt",
        tools=[],
        context=context_a,
        branch_id="branch-a",
    )
    assert config.branch_id == "branch-a"

    runner = LangGraphRunner(model_factory=lambda _model: create_llm())
    system_messages = runner._build_system_messages(config, context_a)
    rendered = "\n".join(str(m.content) for m in system_messages)
    assert "A-marker summary" in rendered, "prompt must carry branch A's summary"
    assert "B-marker summary" not in rendered, "prompt must never carry branch B's summary"


@pytest.mark.asyncio
async def test_runner_branch_mismatch_fails_closed():
    context = _context_with_run(branch_id="branch-a")
    config = RunnerConfig(
        model="mock",
        system_prompt="test",
        tools=[],
        context=context,
        branch_id="branch-b",
    )
    runner = LangGraphRunner(model_factory=lambda _model: create_llm())
    with pytest.raises(RuntimeError, match="does not match"):
        async for _ in runner.stream([TextMessage(role="human", content="hi")], config):
            pass


# ---------------------------------------------------------------------------
# T2.3: run-scoped writers carry correlation_id=runId
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_stream_writers_carry_run_correlation():
    store = RecordingEventStore()
    runner = LangGraphRunner(model_factory=lambda _model: create_llm(), event_store=store)
    context = _context_with_run(branch_id="branch-a")
    config = RunnerConfig(
        model="mock",
        system_prompt="test",
        tools=[],
        context=context,
        branch_id="branch-a",
    )

    events = [
        event
        async for event in runner.stream([TextMessage(role="human", content="Hi")], config)
    ]

    written_types = [event.type for event in store.events]
    assert "prompt.admitted" in written_types
    assert "assistant.responded" in written_types
    assert all(event.correlation_id == "run-123" for event in store.events), (
        "every run-scoped writer must carry correlation_id=runId so CP derives the branch"
    )
    assert any(event.type == "usage" for event in events)


@pytest.mark.asyncio
async def test_tool_writers_carry_run_correlation():
    store = RecordingEventStore()
    context = _context_with_run(branch_id="branch-a")
    adapter = LCToolAdapter(FakeTool(), context, store)

    await adapter._arun(query="hello")

    written_types = [event.type for event in store.events]
    assert written_types == ["tool.called", "tool.result"]
    assert all(event.correlation_id == "run-123" for event in store.events)


@pytest.mark.asyncio
async def test_prompt_admitted_without_run_id_writes_no_correlation():
    """spec §7: no runId -> no correlation -> CP marks the row unanchorable
    (409 BRANCH_ANCHOR_UNAVAILABLE), never a silent root cursor."""
    store = RecordingEventStore()
    runner = LangGraphRunner(model_factory=lambda _model: create_llm(), event_store=store)
    context = AgentContext.empty("session-1")

    await runner._append_prompt_admitted([TextMessage(role="human", content="legacy")], context)

    assert len(store.events) == 1
    assert store.events[0].correlation_id is None


# ---------------------------------------------------------------------------
# T2.3: required EventStore write failures converge the run to failure
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_prompt_admitted_append_failure_fails_the_run():
    store = RecordingEventStore(fail_types={"prompt.admitted"})
    runner = LangGraphRunner(model_factory=lambda _model: create_llm(), event_store=store)
    config = RunnerConfig(
        model="mock",
        system_prompt="test",
        tools=[],
        context=_context_with_run(branch_id="branch-a"),
        branch_id="branch-a",
    )

    with pytest.raises(RuntimeError, match="prompt.admitted"):
        async for _ in runner.stream([TextMessage(role="human", content="hi")], config):
            pass


@pytest.mark.asyncio
async def test_assistant_append_failure_converges_run_after_usage():
    store = RecordingEventStore(fail_types={"assistant.responded"})
    runner = LangGraphRunner(model_factory=lambda _model: create_llm(), event_store=store)
    config = RunnerConfig(
        model="mock",
        system_prompt="test",
        tools=[],
        context=_context_with_run(branch_id="branch-a"),
        branch_id="branch-a",
    )

    collected = []
    with pytest.raises(RuntimeError, match="assistant.responded"):
        async for event in runner.stream([TextMessage(role="human", content="hi")], config):
            collected.append(event)

    assert any(event.type == "usage" for event in collected)
    assert any(event.type == "token" for event in collected)


# ---------------------------------------------------------------------------
# T2.4: branch A / branch B input isolation — BOTH directions
# ---------------------------------------------------------------------------


def _branch_snapshot(branch_id: str, marker: str) -> dict:
    """A CP-shaped branch snapshot: ancestor prefix + branch facts (message,
    tool result, assistant reply), branch summary in epoch SUM, and a durable
    prune tombstone already applied to its tool message."""
    return {
        "aggregate_id": "session-1",
        "latest_sequence": 42,
        "branch_id": branch_id,
        "messages": [
            {"role": "human", "content": "shared ancestor prompt"},
            {"role": "human", "content": f"{marker} prompt"},
            {"role": "tool", "content": f"{marker} tool output"},
            {"role": "tool", "content": "[old tool result cleared]"},
            {"role": "ai", "content": f"{marker} reply"},
        ],
        "epoch": {
            "epoch_id": "epoch-1",
            "system_messages": [
                "Conversation summary of compacted history:",
                f"{marker} summary",
            ],
            "sources": [],
            "l1_rendered": "",
        },
        "runtime_state": {},
        "metadata": {},
    }


def test_branch_a_context_excludes_branch_b_facts_and_vice_versa():
    context_a = AgentContext.from_snapshot(_branch_snapshot("branch-a", "A-marker"))
    context_b = AgentContext.from_snapshot(_branch_snapshot("branch-b", "B-marker"))

    encoded_a = json.dumps(context_a.to_snapshot(), ensure_ascii=False)
    encoded_b = json.dumps(context_b.to_snapshot(), ensure_ascii=False)

    # A sees its own message / tool result / reply / summary, never B's.
    assert "A-marker prompt" in encoded_a
    assert "A-marker tool output" in encoded_a
    assert "A-marker reply" in encoded_a
    assert "A-marker summary" in encoded_a
    assert "B-marker" not in encoded_a

    # Reverse direction.
    assert "B-marker prompt" in encoded_b
    assert "B-marker tool output" in encoded_b
    assert "B-marker reply" in encoded_b
    assert "B-marker summary" in encoded_b
    assert "A-marker" not in encoded_b

    # Shared ancestor prefix is present on both sides.
    assert "shared ancestor prompt" in encoded_a
    assert "shared ancestor prompt" in encoded_b

    # The CP-given branch identity is preserved end to end.
    assert context_a.branch_id == "branch-a"
    assert context_b.branch_id == "branch-b"


def test_branch_prompt_build_excludes_sibling_summary_both_directions():
    runner = LangGraphRunner(model_factory=lambda _model: create_llm())
    context_a = AgentContext.from_snapshot(_branch_snapshot("branch-a", "A-marker"))
    context_b = AgentContext.from_snapshot(_branch_snapshot("branch-b", "B-marker"))

    rendered_a = "\n".join(
        str(m.content)
        for m in runner._build_system_messages(
            RunnerConfig(
                model="mock",
                system_prompt="base",
                tools=[],
                context=context_a,
                branch_id="branch-a",
            ),
            context_a,
        )
    )
    rendered_b = "\n".join(
        str(m.content)
        for m in runner._build_system_messages(
            RunnerConfig(
                model="mock",
                system_prompt="base",
                tools=[],
                context=context_b,
                branch_id="branch-b",
            ),
            context_b,
        )
    )

    assert "A-marker summary" in rendered_a and "B-marker" not in rendered_a
    assert "B-marker summary" in rendered_b and "A-marker" not in rendered_b
