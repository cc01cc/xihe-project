"""PLAN-0508 T3.1: per-attempt provider HTTP transport telemetry.

One collector lives on the ApiChatModel (one per Run) while every
``ApiSender.stream`` dispatch opens exactly one attempt with a monotonically
increasing per-Run ``seq``. Emission is side-effect only, delivered to the
injected sink: bounded ``transport_progress`` stage transitions (at most four
per attempt, never per chunk) plus one ``transport_attempt`` terminal summary.
The sender never yields telemetry, so consumer cancellation and early close
still terminate the attempt from the sender's exception/``finally`` path.

Wall-clock ``startedAt/endedAt`` are display fields; ``elapsedMs/durationMs``
come from the process monotonic clock and are never derived from cross-process
wall-clock subtraction (root-cause fix 2026-10-14).
"""

from __future__ import annotations

import time
import uuid
from collections.abc import Callable
from datetime import UTC, datetime
from typing import Any

from loguru import logger

from xihe_agent.llm.api_request import ApiRequestError

STAGE_ATTEMPT_STARTED = "attempt_started"
STAGE_FIRST_CHUNK = "first_chunk"
STAGE_STREAMING = "streaming"
STAGE_ATTEMPT_FINISHED = "attempt_finished"

OUTCOME_SUCCESS = "success"
OUTCOME_ERROR = "error"
OUTCOME_TIMEOUT = "timeout"
OUTCOME_ABORTED = "aborted"

PROGRESS_EVENT = "transport_progress"
ATTEMPT_EVENT = "transport_attempt"

# Unclassified failures fall back to the existing safe terminal-code domain;
# raw exception text, provider bodies and credentials never leave the process.
SAFE_FALLBACK_ERROR_CODE = "AGENT_STREAM_FAILED"

TransportEventSink = Callable[[str, dict[str, Any]], None]


class TransportMetricsCollector:
    """Run-scoped attempt sequencing; delivers (eventType, payload) to the sink."""

    def __init__(self, sink: TransportEventSink | None = None) -> None:
        self._sink = sink
        self._seq = 0

    def begin_attempt(self) -> TransportAttemptRecorder:
        self._seq += 1
        return TransportAttemptRecorder(seq=self._seq, sink=self._sink)


class TransportAttemptRecorder:
    """Bounded stage state for one dispatch; terminal emission happens once."""

    def __init__(self, *, seq: int, sink: TransportEventSink | None) -> None:
        self.attempt_id = str(uuid.uuid4())
        self.seq = seq
        self.started_at = datetime.now(UTC)
        self._sink = sink
        self._started_monotonic = time.monotonic()
        self._chunk_count = 0
        self._first_chunk_ms: int | None = None
        self._streaming_emitted = False
        self._finished = False
        self._progress(STAGE_ATTEMPT_STARTED)

    def observe_content(self, text: str, reasoning: str) -> None:
        """Register one non-empty decoded content yield from the sender."""
        if self._sink is None or self._finished or not (text or reasoning):
            return
        self._chunk_count += 1
        if self._first_chunk_ms is None:
            self._first_chunk_ms = self._elapsed_ms()
            self._progress(STAGE_FIRST_CHUNK)
        elif not self._streaming_emitted:
            self._streaming_emitted = True
            self._progress(STAGE_STREAMING)

    def succeeded(self) -> None:
        self._finish(OUTCOME_SUCCESS, None)

    def aborted(self) -> None:
        self._finish(OUTCOME_ABORTED, None)

    def failed(self, exc: BaseException) -> None:
        """Classify a failure without touching raw exception text."""
        if isinstance(exc, ApiRequestError):
            outcome = OUTCOME_TIMEOUT if exc.status == 504 else OUTCOME_ERROR
            self._finish(outcome, exc.terminal_code)
            return
        self._finish(OUTCOME_ERROR, SAFE_FALLBACK_ERROR_CODE)

    def close(self) -> None:
        """Backstop for an early consumer close: a still-open attempt is aborted."""
        self._finish(OUTCOME_ABORTED, None)

    def _elapsed_ms(self) -> int:
        return int((time.monotonic() - self._started_monotonic) * 1000)

    def _finish(self, outcome: str, error_code: str | None) -> None:
        if self._finished:
            return
        self._finished = True
        self._progress(STAGE_ATTEMPT_FINISHED)
        self._deliver(
            ATTEMPT_EVENT,
            {
                "attemptId": self.attempt_id,
                "seq": self.seq,
                "startedAt": _utc_iso(self.started_at),
                "endedAt": _utc_iso(datetime.now(UTC)),
                "durationMs": self._elapsed_ms(),
                "outcome": outcome,
                "errorCode": error_code,
                "firstChunkMs": self._first_chunk_ms,
                "chunkCount": self._chunk_count,
                "uploadBytes": None,
                "downloadBytes": None,
            },
        )

    def _progress(self, stage: str) -> None:
        self._deliver(
            PROGRESS_EVENT,
            {
                "attemptId": self.attempt_id,
                "seq": self.seq,
                "stage": stage,
                "startedAt": _utc_iso(self.started_at),
                "elapsedMs": self._elapsed_ms(),
            },
        )

    def _deliver(self, event_type: str, payload: dict[str, Any]) -> None:
        if self._sink is None:
            return
        try:
            self._sink(event_type, payload)
        except Exception:
            # Telemetry is a side channel: a failing sink must never break the
            # provider dispatch or the Run.
            logger.opt(exception=True).warning(
                "transport telemetry sink failed eventType={} attemptId={}", event_type, self.attempt_id
            )


def _utc_iso(value: datetime) -> str:
    return value.isoformat().replace("+00:00", "Z")
