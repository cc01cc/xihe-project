"""PLAN-0508 T3.2: provider transport telemetry must reach the SSE wire.

The chat endpoint binds a transport sink into the model and hands the runner a
queue to fan in; both event types are re-emitted through the generic render
path with requestId/runId added by `correlated_data`. This test pins that
wiring with a stub model (capturing the sink) and a stub runner (relaying the
queue), following the PLAN-0492 budget-SSE pattern.
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


class _StubApiType:
    """PLAN-0439/0485 lease-gate stand-in: only `.id`/`.version` are compared."""

    id = "stub-api-type"
    version = 1


class _CapturingModel:
    """Native sender stand-in; captures the transport sink bound by the route."""

    captured_sink: Any = None

    def __init__(self, **kwargs: Any) -> None:
        _CapturingModel.captured_sink = kwargs.get("transport_sink")

    @property
    def native_records(self) -> list[dict[str, Any]]:
        return []


class _TransportStubRunner:
    """Stands in for LangGraphRunner: publishes via the sink, fans the queue in."""

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        pass

    async def stream(self, messages: Any, config: Any) -> AsyncIterator[AgentEvent]:
        sink = _CapturingModel.captured_sink
        assert callable(sink), "chat must bind a transport sink into the model"
        assert config.transport_events is not None, "chat must hand the runner the fan-in queue"
        sink(
            "transport_progress",
            {
                "attemptId": "a1",
                "seq": 1,
                "stage": "first_chunk",
                "startedAt": "2026-10-14T08:00:00Z",
                "elapsedMs": 83,
            },
        )
        sink(
            "transport_attempt",
            {
                "attemptId": "a1",
                "seq": 1,
                "startedAt": "2026-10-14T08:00:00Z",
                "endedAt": "2026-10-14T08:00:01Z",
                "durationMs": 1000,
                "outcome": "success",
                "errorCode": None,
                "firstChunkMs": 83,
                "chunkCount": 2,
                "uploadBytes": None,
                "downloadBytes": None,
            },
        )
        while not config.transport_events.empty():
            yield config.transport_events.get_nowait()
        yield AgentEvent(type="done", data={"outcome": "success"})


class _StubContextProvider:
    async def load(self, session_id: str, **kwargs: Any) -> AgentContext:
        return AgentContext(aggregate_id=session_id)


def _sse_events(response: Any) -> Iterator[tuple[str, dict[str, Any]]]:
    event_name = ""
    for line in response.iter_lines():
        if line.startswith("event:"):
            event_name = line[len("event:") :].strip()
        elif line.startswith("data:"):
            yield event_name, json.loads(line[len("data:") :].strip())


@pytest.fixture()
def stub_transport_runner(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    _CapturingModel.captured_sink = None
    monkeypatch.setattr(chat_api, "LangGraphRunner", _TransportStubRunner)
    monkeypatch.setattr(chat_api, "context_provider", _StubContextProvider())
    monkeypatch.setattr(chat_api, "ApiChatModel", _CapturingModel)
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


def test_transport_events_reach_sse_with_correlation(stub_transport_runner: None) -> None:
    client = TestClient(app)

    with client.stream(
        "POST",
        "/internal/v1/agent/chat",
        json={
            "content": "telemetry lane",
            "sessionId": "s1",
            "toolMode": "none",
            "instructions": "telemetry baseline",
        },
        headers={
            "Authorization": "Bearer dev-token-not-secure",
            "X-Chat-Run-Id": "run-transport-sse",
            "X-Request-Id": "req-transport-sse",
        },
    ) as response:
        assert response.status_code == 200, response.read().decode("utf-8", "replace")[:400]
        events = list(_sse_events(response))

    names = [name for name, _ in events]
    progress = [data for name, data in events if name == "transport_progress"]
    terminal = [data for name, data in events if name == "transport_attempt"]
    assert len(progress) == 1
    assert len(terminal) == 1

    # correlated_data stamps requestId/runId onto both telemetry events.
    assert progress[0]["requestId"] == "req-transport-sse"
    assert progress[0]["runId"] == "run-transport-sse"
    assert progress[0]["attemptId"] == "a1"
    assert progress[0]["seq"] == 1
    assert progress[0]["stage"] == "first_chunk"
    assert progress[0]["elapsedMs"] == 83

    assert terminal[0]["requestId"] == "req-transport-sse"
    assert terminal[0]["runId"] == "run-transport-sse"
    assert terminal[0]["outcome"] == "success"
    assert terminal[0]["errorCode"] is None
    assert terminal[0]["durationMs"] == 1000
    assert terminal[0]["chunkCount"] == 2

    assert names.index("transport_progress") < names.index("transport_attempt") < names.index("done")
