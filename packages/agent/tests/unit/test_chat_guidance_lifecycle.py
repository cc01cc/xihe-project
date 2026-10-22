"""PLAN-0543 D3: one GuidanceConsumer per Run, closed exactly once.

Before this fix the consumer was built inline in `RunnerConfig` and its
`httpx.AsyncClient` leaked on every run. These tests pin the finally contract:
success, exception, cancellation, close-failure, and the helper's no-op path.
"""

import asyncio
import json
from collections.abc import AsyncIterator, Iterator
from typing import Any

import pytest
from fastapi.testclient import TestClient
from loguru import logger

import xihe_agent.api.chat as chat_api
import xihe_agent.app_state as app_state
from xihe_agent.interfaces.agent_runner import AgentEvent
from xihe_agent.interfaces.context import AgentContext
from xihe_agent.main import app


class _RecordingConsumer:
    """Stands in for GuidanceConsumer; records construction and close count."""

    instances: list["_RecordingConsumer"] = []
    close_error: Exception | None = None

    def __init__(self, base_url: str, service_token: str, run_id: str, **_kwargs: Any) -> None:
        self.base_url = base_url
        self.service_token = service_token
        self.run_id = run_id
        self.close_calls = 0
        type(self).instances.append(self)

    async def aclose(self) -> None:
        self.close_calls += 1
        if type(self).close_error is not None:
            raise type(self).close_error


class _StubRunner:
    def __init__(self, events: list[AgentEvent], error: Exception | None) -> None:
        self._events = events
        self._error = error

    async def stream(self, messages: Any, config: Any) -> AsyncIterator[AgentEvent]:
        if self._error is not None:
            raise self._error
        for event in self._events:
            yield event


class _StubContextProvider:
    async def load(self, session_id: str, **kwargs: Any) -> AgentContext:
        return AgentContext(aggregate_id=session_id)


class _StubApiType:
    id = "stub-api-type"
    version = 1


class _StubApiChatModel:
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
def recording_consumer(monkeypatch: pytest.MonkeyPatch) -> Iterator[type[_RecordingConsumer]]:
    _RecordingConsumer.instances.clear()
    _RecordingConsumer.close_error = None
    monkeypatch.setattr(chat_api, "GuidanceConsumer", _RecordingConsumer)
    monkeypatch.setattr(chat_api, "context_provider", _StubContextProvider())
    monkeypatch.setattr(chat_api, "ApiChatModel", _StubApiChatModel)
    monkeypatch.setattr(
        chat_api,
        "validate_snapshot",
        lambda data: (
            _StubApiType(),
            {
                "template": {
                    "bodySource": '{"model":"${xh.model}","messages":[{"role":"user","content":"${xh.user_input}"}]}'
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
    yield _RecordingConsumer


@pytest.fixture()
def warning_lines() -> Iterator[list[str]]:
    messages: list[str] = []
    sink_id = logger.add(lambda message: messages.append(str(message)), level="WARNING")
    try:
        yield messages
    finally:
        logger.remove(sink_id)


def _install_runner(
    monkeypatch: pytest.MonkeyPatch,
    events: list[AgentEvent] | None = None,
    error: Exception | None = None,
) -> None:
    monkeypatch.setattr(
        chat_api,
        "LangGraphRunner",
        lambda *a, **k: _StubRunner(events or [], error),
    )


def _post_chat(run_id: str) -> Any:
    client = TestClient(app)
    return client.post(
        "/internal/v1/agent/chat",
        json={
            "content": "guidance lifecycle probe",
            "sessionId": "s-guidance-lifecycle",
            "toolMode": "none",
            "instructions": "guidance lifecycle baseline",
        },
        headers={
            "Authorization": "Bearer dev-token-not-secure",
            "X-Chat-Run-Id": run_id,
        },
    )


def test_success_path_closes_consumer_once(
    recording_consumer: type[_RecordingConsumer],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _install_runner(monkeypatch, events=[AgentEvent(type="done", data={"outcome": "success"})])

    response = _post_chat("run-guidance-success")

    assert response.status_code == 200
    assert len(recording_consumer.instances) == 1
    consumer = recording_consumer.instances[0]
    assert consumer.run_id == "run-guidance-success"
    assert consumer.close_calls == 1


def test_runner_exception_path_closes_consumer_once(
    recording_consumer: type[_RecordingConsumer],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _install_runner(monkeypatch, error=RuntimeError("runner exploded"))

    response = _post_chat("run-guidance-exception")

    assert response.status_code == 200
    events = dict(_sse_events(response))
    assert events["error"]["type"] == "error"
    assert len(recording_consumer.instances) == 1
    assert recording_consumer.instances[0].close_calls == 1


def test_close_failure_warns_and_preserves_run_outcome(
    recording_consumer: type[_RecordingConsumer],
    warning_lines: list[str],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _RecordingConsumer.close_error = RuntimeError("client already closed")
    _install_runner(monkeypatch, events=[AgentEvent(type="done", data={"outcome": "success"})])

    response = _post_chat("run-guidance-close-failure")

    assert response.status_code == 200
    events = dict(_sse_events(response))
    assert events["done"]["outcome"] == "success"
    assert recording_consumer.instances[0].close_calls == 1
    assert any("guidance consumer close failed" in line for line in warning_lines)


@pytest.mark.asyncio
async def test_close_helper_survives_cancellation_and_reraises() -> None:
    started = asyncio.Event()
    release = asyncio.Event()
    finished = asyncio.Event()

    class _SlowConsumer:
        close_calls = 0

        async def aclose(self) -> None:
            self.close_calls += 1
            started.set()
            await release.wait()
            finished.set()

    consumer = _SlowConsumer()
    task = asyncio.create_task(chat_api._close_guidance_consumer(consumer))
    await started.wait()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task

    release.set()
    await asyncio.wait_for(finished.wait(), timeout=2)
    assert consumer.close_calls == 1, "shielded close must not be interrupted"


@pytest.mark.asyncio
async def test_close_helper_is_a_noop_without_consumer() -> None:
    assert await chat_api._close_guidance_consumer(None) is None
