"""PLAN-0670 M2c / BL-289: the inbound cap must reach the *real* run terminal payload.

What these tests pin (and why they exist):
- the builder component carries ``truncation`` in the approved wire shape (component contract);
- the runner merges the marker into the terminal ``done`` event only (envelope unchanged);
- the production chat route (``api/chat.py``) applies the caps before ``native_history``/runner and
  the SSE ``done`` event carries ``agentContextTruncation`` — this is the path that was missing
  before BL-289 (the caps lived only in the unused component builder).
"""

import json
from collections.abc import AsyncIterator, Iterator
from typing import Any

import pytest
from fastapi.testclient import TestClient
from loguru import logger

import xihe_agent.api.chat as chat_api
import xihe_agent.app_state as app_state
from xihe_agent.agent_runner.langgraph_runner import _attach_terminal_truncation
from xihe_agent.context.builder import build_context
from xihe_agent.context.inbound_limits import DEFAULT_MAX_MESSAGES
from xihe_agent.interfaces.agent_runner import AgentEvent
from xihe_agent.interfaces.chat_run_context import ChatRunContext
from xihe_agent.interfaces.context import AgentContext
from xihe_agent.interfaces.message import TextMessage
from xihe_agent.main import app

IID = "61e3d9d0-71c7-4b53-9e55-6ca4211ed67c"


def _component(kind: str, config: dict[str, Any]) -> dict[str, Any]:
    return {"instanceId": IID, "type": kind, "enabled": True, "config": config}


def _run(messages: list[TextMessage]) -> ChatRunContext:
    template_id = "b441b5da-f94a-4d3d-bb76-67a55da8c647"
    snapshot = {
        "layer": "workspace",
        "templateId": template_id,
        "version": 2,
        "template": {
            "id": template_id,
            "version": 2,
            "document": "{{component:" + IID + "}}",
            "components": [_component("conversation_history", {"selection": "recent", "maxTokens": 10_000_000, "includeCompaction": False})],
        },
    }
    return ChatRunContext.from_request(
        {
            "runId": "run",
            "sessionId": "session",
            "requestId": "request",
            "instructions": "safe instructions",
            "platformInstructions": "platform instructions",
            "contextTemplateSnapshot": snapshot,
            "componentSources": {},
        },
        AgentContext("session", messages=messages),
    )


def _history(count: int) -> list[TextMessage]:
    return [TextMessage("human", f"m-{index}") for index in range(count)]


def test_builder_component_carries_the_inbound_truncation() -> None:
    built = build_context(_run(_history(DEFAULT_MAX_MESSAGES + 500)), [], "current")
    component = built.components[0]
    assert component.truncation is not None
    assert component.truncation["droppedMessages"] == 500
    assert component.truncation["keptMessages"] == DEFAULT_MAX_MESSAGES
    assert (
        component.truncation["keptMessages"] + component.truncation["droppedMessages"]
        == DEFAULT_MAX_MESSAGES + 500
    )
    assert component.truncation["strategy"] == "newestKeep"


def test_builder_component_has_no_truncation_when_under_the_cap() -> None:
    built = build_context(_run(_history(3)), [], "current")
    assert built.components[0].truncation is None


def test_runner_merges_the_marker_into_done_only() -> None:
    marker = {"droppedMessages": 500, "keptMessages": 2000, "strategy": "newestKeep"}
    done = _attach_terminal_truncation(AgentEvent(type="done", data={"outcome": "success"}), marker)
    assert done.data["agentContextTruncation"] == marker
    assert done.data["outcome"] == "success"

    token = _attach_terminal_truncation(AgentEvent(type="token", data={"content": "x"}), marker)
    assert token.data == {"content": "x"}, "only the terminal done event carries the marker"

    no_cap = _attach_terminal_truncation(AgentEvent(type="done", data={"outcome": "success"}), None)
    assert "agentContextTruncation" not in no_cap.data, "no truncation -> the key is absent"


# ---- production path: real chat route, stubbed provider/model/runner ----------------------------

_TruncationSeen: dict[str, Any] = {}


class _StubApiType:
    id = "stub-api-type"
    version = 1


class _StubApiChatModel:
    estimated_input_tokens = 0

    def __init__(self, **kwargs: Any) -> None:
        pass

    @property
    def native_records(self) -> list[dict[str, Any]]:
        return []


class _StubContextProvider:
    pending_messages: list[TextMessage] = []

    async def load(self, session_id: str, **kwargs: Any) -> AgentContext:
        return AgentContext(session_id, messages=list(type(self).pending_messages))


class _TruncationStubRunner:
    def __init__(self, *args: Any, **kwargs: Any) -> None:
        pass

    async def stream(self, messages: Any, config: Any) -> AsyncIterator[AgentEvent]:
        _TruncationSeen["truncation"] = config.agent_context_truncation
        _TruncationSeen["history_len"] = len(config.context.messages)
        # Emulate the real runner: it forwards the adapter's done event through the merge helper.
        yield _attach_terminal_truncation(
            AgentEvent(type="done", data={"outcome": "success"}),
            config.agent_context_truncation,
        )


def _sse_events(response: Any) -> Iterator[tuple[str, dict[str, Any]]]:
    event_name = ""
    for line in response.iter_lines():
        if line.startswith("event:"):
            event_name = line[len("event:") :].strip()
        elif line.startswith("data:"):
            yield event_name, json.loads(line[len("data:") :].strip())


@pytest.fixture()
def stub_truncation_runner(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    _TruncationSeen.clear()
    _StubContextProvider.pending_messages = []
    monkeypatch.setattr(chat_api, "LangGraphRunner", _TruncationStubRunner)
    monkeypatch.setattr(chat_api, "context_provider", _StubContextProvider())
    monkeypatch.setattr(chat_api, "ApiChatModel", _StubApiChatModel)
    monkeypatch.setattr(
        chat_api,
        "validate_snapshot",
        lambda data: (
            _StubApiType(),
            {
                "template": {
                    "bodySource": '{"model":"${xh.model}","messages":['
                    '{"role":"user","content":"${xh.user_input}"}]}'
                }
            },
        ),
    )
    monkeypatch.setattr(chat_api, "render_request", lambda *a, **k: {})

    async def _redeem(payload: dict[str, Any], request_id: str | None = None) -> dict[str, Any]:
        return {
            "apiTypeId": _StubApiType.id,
            "apiTypeVersion": _StubApiType.version,
            "operation": "chat",
            "connectionRevision": payload.get("connectionRevision"),
            "provider": payload.get("providerId"),
            "model": payload.get("model"),
        }

    monkeypatch.setattr(app_state.config_client, "redeem_provider_lease", _redeem)
    monkeypatch.setattr(app_state, "_llm_ready", "ready")
    monkeypatch.setattr(app_state.config_client, "_effective_cache", {})
    yield


def _chat_done_event() -> dict[str, Any]:
    client = TestClient(app)
    with client.stream(
        "POST",
        "/internal/v1/agent/chat",
        json={
            "content": "truncation lane",
            "sessionId": "s-truncation",
            "toolMode": "none",
            "instructions": "truncation baseline",
        },
        headers={
            "Authorization": "Bearer dev-token-not-secure",
            "X-Chat-Run-Id": "run-truncation",
            "X-Request-Id": "req-truncation",
        },
    ) as response:
        assert response.status_code == 200, response.read().decode("utf-8", "replace")[:400]
        events = list(_sse_events(response))
    done = [data for name, data in events if name == "done"]
    assert len(done) == 1
    return done[0]


def test_chat_path_caps_the_real_history_and_reports_it_on_done(
    stub_truncation_runner: None,
) -> None:
    _StubContextProvider.pending_messages = _history(DEFAULT_MAX_MESSAGES + 500)

    done = _chat_done_event()

    assert _TruncationSeen["history_len"] == DEFAULT_MAX_MESSAGES, (
        "the production route must cap context.messages before the runner (BL-289)"
    )
    marker = done["agentContextTruncation"]
    assert marker["droppedMessages"] == 500
    assert marker["keptMessages"] == DEFAULT_MAX_MESSAGES
    assert marker["keptMessages"] + marker["droppedMessages"] == DEFAULT_MAX_MESSAGES + 500
    assert marker["strategy"] == "newestKeep"
    assert _TruncationSeen["truncation"] == marker, "the runner saw the same object the wire got"


def test_chat_path_omits_the_key_when_nothing_is_dropped(stub_truncation_runner: None) -> None:
    _StubContextProvider.pending_messages = _history(3)

    done = _chat_done_event()

    assert "agentContextTruncation" not in done, "under the cap the key must be absent, not all-zero"


def test_truncation_warn_and_wire_share_one_source() -> None:
    records: list[str] = []
    handler = logger.add(lambda message: records.append(str(message)), level="WARNING")
    try:
        from xihe_agent.context.inbound_limits import truncate_for_run

        kept, truncation = truncate_for_run(_history(DEFAULT_MAX_MESSAGES + 500))
    finally:
        logger.remove(handler)

    assert len(kept) == DEFAULT_MAX_MESSAGES
    assert truncation is not None
    warn = [record for record in records if "event=agent_context_truncated" in record]
    assert len(warn) == 1
    assert "dropped=500" in warn[0]
    marker = truncation.to_wire()
    assert marker["droppedMessages"] == 500
    assert marker["keptMessages"] == DEFAULT_MAX_MESSAGES
