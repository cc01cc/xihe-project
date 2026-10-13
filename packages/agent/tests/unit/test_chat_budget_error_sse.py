"""PLAN-0492 T2.2: RUN_BUDGET_EXHAUSTED must survive the Agent SSE mapping.

The runner emits `dimension` with the error event; the chat endpoint's SSE
mapping previously rebuilt the error payload from a fixed field set and dropped
it, so the CP relay (and the UI) lost the exhausted dimension. This test pins
the wire contract at the Agent boundary with a stub runner.
"""

import json
from collections.abc import AsyncIterator, Iterator
from typing import Any

import pytest
from fastapi.testclient import TestClient

import xihe_agent.api.chat as chat_api
import xihe_agent.app_state as app_state
from xihe_agent.interfaces.agent_runner import AgentEvent
from xihe_agent.interfaces.context import AgentContext
from xihe_agent.main import app


class _StubRunner:
    def __init__(self, events: list[AgentEvent]) -> None:
        self._events = events

    async def stream(self, messages: Any, config: Any) -> AsyncIterator[AgentEvent]:
        for event in self._events:
            yield event


class _StubContextProvider:
    async def load(self, session_id: str, **kwargs: Any) -> AgentContext:
        return AgentContext(aggregate_id=session_id)


class _StubApiType:
    """PLAN-0439/0485 lease-gate stand-in: only `.id`/`.version` are compared."""

    id = "stub-api-type"
    version = 1


class _StubApiChatModel:
    """Native sender stand-in: the runner is stubbed, so no provider call ever runs."""

    def __init__(self, **kwargs: Any) -> None:
        self._kwargs = kwargs

    @property
    def native_records(self) -> list[dict[str, Any]]:
        return []


def _sse_events(response: Any) -> Iterator[tuple[str, dict[str, Any]]]:
    event_name = ""
    for line in response.iter_lines():
        if line.startswith("event:"):
            event_name = line[len("event:") :].strip()
        elif line.startswith("data:"):
            yield event_name, json.loads(line[len("data:") :].strip())


@pytest.fixture()
def stub_budget_runner(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    events = [
        AgentEvent(
            type="error",
            data={
                "error": "Run budget exhausted (tokens)",
                "code": "RUN_BUDGET_EXHAUSTED",
                "dimension": "tokens",
                "retryable": False,
            },
        ),
        AgentEvent(
            type="done",
            data={"outcome": "error", "errorCode": "RUN_BUDGET_EXHAUSTED"},
        ),
    ]
    monkeypatch.setattr(chat_api, "LangGraphRunner", lambda *a, **k: _StubRunner(events))
    monkeypatch.setattr(chat_api, "context_provider", _StubContextProvider())
    monkeypatch.setattr(chat_api, "ApiChatModel", _StubApiChatModel)
    # PLAN-0439/0485: the chat endpoint preflights an api-type snapshot and
    # redeems a one-use provider lease. This test pins the budget-dimension
    # wire contract, so the lease gate is stubbed to a self-consistent grant.
    monkeypatch.setattr(
        chat_api,
        "validate_snapshot",
        lambda data: (
            _StubApiType(),
            {
                "template": {
                    # A published body source is always valid JSON; the chat path
                    # parses it again for the RAG-slot trigger, so an empty stub
                    # would fail as CONTEXT_BUILD_FAILED/INVALID_JSON.
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


def test_budget_error_sse_carries_the_exhausted_dimension(stub_budget_runner: None) -> None:
    client = TestClient(app)

    with client.stream(
        "POST",
        "/internal/v1/agent/chat",
        json={
            "content": "loop until the budget stops me",
            "sessionId": "s1",
            "toolMode": "none",
            # T3.1: instructions are CP-owned and required; the Agent has no
            # process-level fallback, so a chat without them fails closed.
            "instructions": "budget lane baseline",
        },
        headers={
            "Authorization": "Bearer dev-token-not-secure",
            "X-Chat-Run-Id": "run-budget-sse",
        },
    ) as response:
        assert response.status_code == 200, response.read().decode("utf-8", "replace")[:400]
        events = dict(_sse_events(response))

    error = events["error"]
    assert error["code"] == "RUN_BUDGET_EXHAUSTED"
    assert error["dimension"] == "tokens"
    assert error["retryable"] is False
    assert error["outcome"] == "error"

    done = events["done"]
    assert done["errorCode"] == "RUN_BUDGET_EXHAUSTED"
    assert done["outcome"] == "error"
