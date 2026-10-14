"""PLAN-0508 T3.1 transport telemetry tests; ephemeral loopback recorder, no credentials."""

import asyncio
import json
from contextlib import asynccontextmanager

import pytest

from xihe_agent.llm.api_request import ApiRequestError, chat_type
from xihe_agent.llm.api_sender import ApiSender
from xihe_agent.llm.transport_metrics import (
    ATTEMPT_EVENT,
    OUTCOME_ABORTED,
    OUTCOME_ERROR,
    OUTCOME_SUCCESS,
    OUTCOME_TIMEOUT,
    PROGRESS_EVENT,
    STAGE_ATTEMPT_FINISHED,
    STAGE_ATTEMPT_STARTED,
    STAGE_FIRST_CHUNK,
    STAGE_STREAMING,
    TransportMetricsCollector,
)

TYPE = chat_type("openai-chat-completions", 1)
PROGRESS_KEYS = {"attemptId", "seq", "stage", "startedAt", "elapsedMs"}
ATTEMPT_KEYS = {
    "attemptId",
    "seq",
    "startedAt",
    "endedAt",
    "durationMs",
    "outcome",
    "errorCode",
    "firstChunkMs",
    "chunkCount",
    "uploadBytes",
    "downloadBytes",
}


def grant(base):
    return {"apiTypeId": TYPE.id, "apiTypeVersion": TYPE.version, "operation": "chat", "apiKey": "fixture-only", "baseUrl": base}


def body(stream=True):
    return {"model": "fixture", "messages": [{"role": "user", "content": "hi"}], "stream": stream}


def sse_two_chunks():
    frames = [
        {"choices": [{"index": 0, "delta": {"role": "assistant"}}]},
        {"choices": [{"index": 0, "delta": {"content": "Hel"}}]},
        {"choices": [{"index": 0, "delta": {"content": "lo"}}]},
        {"choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]},
    ]
    return "".join(f"data: {json.dumps(frame)}\n\n" for frame in frames) + "data: [DONE]\n\n"


def json_response():
    return {
        "choices": [{"message": {"role": "assistant", "content": "answer"}, "finish_reason": "stop"}],
        "usage": {"prompt_tokens": 3, "completion_tokens": 2},
    }


@asynccontextmanager
async def recorder(payload, *, status=200, stream=False, hold=None):
    captures = []
    handlers = set()

    async def handle(reader, writer):
        task = asyncio.current_task()
        handlers.add(task)
        try:
            raw = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), 3)
            lines = raw.decode().split("\r\n")
            headers = dict(line.lower().split(": ", 1) for line in lines[1:] if ": " in line)
            data = await asyncio.wait_for(reader.readexactly(int(headers["content-length"])), 3)
            captures.append(json.loads(data))
            if hold is not None:
                hold.set()
                await reader.read()
                return
            outgoing = payload(len(captures)) if callable(payload) else payload
            content = outgoing.encode() if isinstance(outgoing, str) else json.dumps(outgoing).encode()
            mime = "text/event-stream" if stream else "application/json"
            writer.write(
                f"HTTP/1.1 {status} fixture\r\nContent-Type: {mime}\r\nContent-Length: {len(content)}\r\nConnection: close\r\n\r\n".encode()
                + content
            )
            await writer.drain()
        finally:
            writer.close()
            await writer.wait_closed()
            handlers.discard(task)

    server = await asyncio.start_server(handle, "127.0.0.1", 0)
    try:
        yield f"http://127.0.0.1:{server.sockets[0].getsockname()[1]}/v1", captures
    finally:
        server.close()
        await server.wait_closed()
        for task in list(handlers):
            task.cancel()
        if handlers:
            await asyncio.gather(*list(handlers), return_exceptions=True)


class EventLog:
    def __init__(self):
        self.events = []

    def __call__(self, event_type, payload):
        self.events.append((event_type, payload))

    def stages(self):
        return [payload["stage"] for event_type, payload in self.events if event_type == PROGRESS_EVENT]

    def terminals(self):
        return [payload for event_type, payload in self.events if event_type == ATTEMPT_EVENT]


async def drain(sender):
    return [part async for part in sender.stream(body())]


def test_collector_sequences_attempts_with_bounded_stages():
    log = EventLog()
    collector = TransportMetricsCollector(log)
    first = collector.begin_attempt()
    second = collector.begin_attempt()

    assert (first.seq, second.seq) == (1, 2)
    assert first.attempt_id != second.attempt_id

    for chunk in ("a", "b", "c"):
        first.observe_content(chunk, "")
    first.succeeded()
    first.aborted()  # terminal emission is exactly once

    assert log.stages() == [
        STAGE_ATTEMPT_STARTED,
        STAGE_ATTEMPT_STARTED,
        STAGE_FIRST_CHUNK,
        STAGE_STREAMING,
        STAGE_ATTEMPT_FINISHED,
    ]
    assert all(payload["elapsedMs"] >= 0 for event_type, payload in log.events if event_type == PROGRESS_EVENT)
    stages_by_attempt = {}
    for event_type, payload in log.events:
        if event_type == PROGRESS_EVENT:
            stages_by_attempt.setdefault(payload["attemptId"], []).append(payload["stage"])
    assert all(len(stages) <= 4 for stages in stages_by_attempt.values())

    terminal = log.terminals()[0]
    assert terminal["outcome"] == OUTCOME_SUCCESS
    assert terminal["errorCode"] is None
    assert terminal["chunkCount"] == 3
    assert isinstance(terminal["firstChunkMs"], int)
    assert terminal["uploadBytes"] is None
    assert terminal["downloadBytes"] is None


def test_payload_keys_are_frozen_and_exclude_content_credentials():
    log = EventLog()
    recorder_ = TransportMetricsCollector(log).begin_attempt()
    recorder_.observe_content("secret-content", "reasoning-content")
    recorder_.failed(ApiRequestError("LLM_PROVIDER_INVALID_RESPONSE", 502))

    for event_type, payload in log.events:
        assert set(payload) == (PROGRESS_KEYS if event_type == PROGRESS_EVENT else ATTEMPT_KEYS)
    blob = json.dumps(log.events)
    assert "secret-content" not in blob
    assert "reasoning-content" not in blob
    assert "fixture-only" not in blob

    terminal = log.terminals()[0]
    assert terminal["outcome"] == OUTCOME_ERROR
    assert terminal["errorCode"] == "AGENT_STREAM_FAILED"


def test_attempt_without_content_keeps_first_chunk_unknown():
    log = EventLog()
    recorder_ = TransportMetricsCollector(log).begin_attempt()
    recorder_.succeeded()

    assert log.stages() == [STAGE_ATTEMPT_STARTED, STAGE_ATTEMPT_FINISHED]
    terminal = log.terminals()[0]
    assert terminal["firstChunkMs"] is None
    assert terminal["chunkCount"] == 0


@pytest.mark.parametrize(
    "failure,outcome,error_code",
    [
        (ApiRequestError("LLM_PROVIDER_TIMEOUT", 504), OUTCOME_TIMEOUT, "LLM_PROVIDER_UNREACHABLE"),
        (ApiRequestError("LLM_PROVIDER_UNREACHABLE", 502), OUTCOME_ERROR, "LLM_PROVIDER_UNREACHABLE"),
        (ApiRequestError("LLM_CREDENTIALS_INVALID", 502), OUTCOME_ERROR, "LLM_CREDENTIALS_INVALID"),
        (RuntimeError("boom"), OUTCOME_ERROR, "AGENT_STREAM_FAILED"),
    ],
)
def test_failure_classification_keeps_only_safe_codes(failure, outcome, error_code):
    log = EventLog()
    recorder_ = TransportMetricsCollector(log).begin_attempt()
    recorder_.failed(failure)

    terminal = log.terminals()[0]
    assert terminal["outcome"] == outcome
    assert terminal["errorCode"] == error_code
    assert "boom" not in json.dumps(log.events)


def test_close_backstop_marks_unfinished_attempt_aborted():
    log = EventLog()
    recorder_ = TransportMetricsCollector(log).begin_attempt()
    recorder_.close()

    terminal = log.terminals()[0]
    assert terminal["outcome"] == OUTCOME_ABORTED
    assert terminal["errorCode"] is None
    assert log.stages() == [STAGE_ATTEMPT_STARTED, STAGE_ATTEMPT_FINISHED]


def test_sink_failure_never_breaks_the_attempt():
    def failing_sink(event_type, payload):
        raise RuntimeError("sink down")

    collector = TransportMetricsCollector(failing_sink)
    recorder_ = collector.begin_attempt()
    recorder_.observe_content("x", "")
    recorder_.aborted()
    recorder_.close()


async def test_stream_dispatch_emits_one_bounded_attempt():
    log = EventLog()
    async with recorder(sse_two_chunks(), stream=True) as (base, captures):
        sender = ApiSender(TYPE, grant(base), "request-1", 3, collector=TransportMetricsCollector(log))
        parts = [part async for part in sender.stream(body())]

    assert parts[-1][2] is not None
    assert len(captures) == 1
    assert log.stages() == [STAGE_ATTEMPT_STARTED, STAGE_FIRST_CHUNK, STAGE_STREAMING, STAGE_ATTEMPT_FINISHED]
    terminal = log.terminals()[0]
    assert terminal["outcome"] == OUTCOME_SUCCESS
    assert terminal["errorCode"] is None
    assert terminal["chunkCount"] == 2
    assert isinstance(terminal["firstChunkMs"], int)
    assert terminal["uploadBytes"] is None
    assert terminal["downloadBytes"] is None


async def test_each_dispatch_opens_its_own_attempt_and_seq():
    log = EventLog()
    async with recorder(sse_two_chunks(), stream=True) as (base, captures):
        sender = ApiSender(TYPE, grant(base), "request-1", 3, collector=TransportMetricsCollector(log))
        await drain(sender)
        await drain(sender)

    assert len(captures) == 2
    assert [terminal["seq"] for terminal in log.terminals()] == [1, 2]
    assert len({terminal["attemptId"] for terminal in log.terminals()}) == 2


async def test_non_stream_dispatch_counts_single_content_chunk():
    log = EventLog()
    async with recorder(json_response()) as (base, _captures):
        sender = ApiSender(TYPE, grant(base), "request-1", 3, collector=TransportMetricsCollector(log))
        _ = [part async for part in sender.stream(body(stream=False))]

    assert log.stages() == [STAGE_ATTEMPT_STARTED, STAGE_FIRST_CHUNK, STAGE_ATTEMPT_FINISHED]
    terminal = log.terminals()[0]
    assert terminal["outcome"] == OUTCOME_SUCCESS
    assert terminal["chunkCount"] == 1


async def test_timeout_dispatch_records_timeout_outcome():
    log = EventLog()
    hold = asyncio.Event()
    async with recorder("", stream=True, hold=hold) as (base, _captures):
        sender = ApiSender(TYPE, grant(base), "request-1", 0.2, collector=TransportMetricsCollector(log))
        with pytest.raises(ApiRequestError) as error:
            await drain(sender)

    assert error.value.status == 504
    assert error.value.code == "LLM_PROVIDER_UNREACHABLE"
    terminal = log.terminals()[0]
    assert terminal["outcome"] == OUTCOME_TIMEOUT
    assert terminal["errorCode"] == "LLM_PROVIDER_UNREACHABLE"


async def test_cancelled_consumer_terminates_attempt_as_aborted():
    log = EventLog()
    hold = asyncio.Event()
    async with recorder("", stream=True, hold=hold) as (base, _captures):
        sender = ApiSender(TYPE, grant(base), "request-1", 3, collector=TransportMetricsCollector(log))
        task = asyncio.create_task(drain(sender))
        await asyncio.wait_for(hold.wait(), 3)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

    assert log.stages() == [STAGE_ATTEMPT_STARTED, STAGE_ATTEMPT_FINISHED]
    terminal = log.terminals()[0]
    assert terminal["outcome"] == OUTCOME_ABORTED
    assert terminal["errorCode"] is None


async def test_provider_failure_records_safe_error_code():
    log = EventLog()
    async with recorder({"error": "fixture"}, status=500) as (base, _captures):
        sender = ApiSender(TYPE, grant(base), "request-1", 3, collector=TransportMetricsCollector(log))
        with pytest.raises(ApiRequestError) as error:
            await drain(sender)

    assert error.value.code == "LLM_PROVIDER_UNREACHABLE"
    terminal = log.terminals()[0]
    assert terminal["outcome"] == OUTCOME_ERROR
    assert terminal["errorCode"] == "LLM_PROVIDER_UNREACHABLE"
