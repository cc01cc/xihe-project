"""PLAN-0679 T1.2 + task-103: provider request capture on ApiChatModel dispatch (D2/D4/B-1).

Drives the real generation seam (``_agenerate``) against a stand-in sender that records the
bytes it was handed, and asserts the side-channel contract: one event per dispatched provider
step, fingerprint layers stay hash/count only, the audit block carries the verbatim wire bytes
the sender saw, the tier switch suppresses bodies, and a broken sink never breaks dispatch.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import json
from typing import Any

import pytest
from langchain_core.messages import HumanMessage

from xihe_agent.adapters.api_chat_model import ApiChatModel
from xihe_agent.app_state import _resolve_provider_audit_tier, _resolve_provider_fingerprint_enabled
from xihe_agent.config_snapshot import RunConfigSnapshot
from xihe_agent.llm import provider_fingerprint
from xihe_agent.llm.api_request import chat_type
from xihe_agent.llm.api_sender import AttemptAudit, NativeResponse

CANARY = "current-turn-canary-0679"
OLD_TURN = "historical-turn-text-0679"

SOURCE = {
    "model": "${xh.model}",
    "messages": ["${xh.conversation_history}", {"role": "user", "content": "${xh.user_input}"}],
    "tools": ["${xh.tools}"],
    "stream": True,
}


class _FakeSender:
    """Stand-in for ApiSender: mirrors its capture contract (self.audit + wire bytes)."""

    def __init__(
        self,
        *,
        provider_usage: dict[str, int] | None = None,
        http_status: int | None = 200,
        response_bytes: bytes = b'{"ok":true}',
        error_bytes: bytes | None = None,
        error: Exception | None = None,
    ) -> None:
        self.request_id = "fingerprint-test"
        self.audit: AttemptAudit | None = None
        self.sent_bodies: list[dict[str, Any]] = []
        self._provider_usage = dict(provider_usage or {})
        self._http_status = http_status
        self._response_bytes = response_bytes
        self._error_bytes = error_bytes
        self._error = error

    async def stream(self, body: dict[str, Any]):
        wire = json.dumps(body, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")
        self.sent_bodies.append(body)
        self.audit = AttemptAudit(
            request_bytes=wire,
            response_bytes=self._response_bytes,
            error_bytes=self._error_bytes,
            http_status=self._http_status,
            streamed=True,
            ttft_ms=5,
            total_ms=12,
        )
        if self._error is not None:
            raise self._error
        response = NativeResponse(
            text="ok",
            records=[],
            calls=[],
            usage=None,
            provider_usage=self._provider_usage,
        )
        yield ("ok", "", response)


def _model(
    *,
    sink: Any = None,
    enabled: bool = True,
    token_estimator: Any = None,
    sampling_overrides: dict[str, Any] | None = None,
    image_data_urls: list[str] | None = None,
    audit_tier: str = "full",
) -> ApiChatModel:
    return ApiChatModel(
        api_type=chat_type("openai-chat-completions", 1),
        grant={
            "apiTypeId": "openai-chat-completions",
            "apiTypeVersion": 1,
            "operation": "chat",
            "apiKey": "unit-test-only",
            "baseUrl": "https://provider.invalid/v1",
        },
        body_source=json.dumps(SOURCE),
        values={
            "model": "fixture-model",
            "user_input": CANARY,
            "conversation_history": [{"role": "user", "content": OLD_TURN}],
            "tools": [
                {
                    "type": "function",
                    "function": {
                        "name": "read_file",
                        "description": "read",
                        "parameters": {"type": "object", "properties": {}},
                    },
                }
            ],
        },
        request_id="fingerprint-test",
        timeout=1,
        transport_sink=sink,
        fingerprint_enabled=enabled,
        audit_tier=audit_tier,
        token_estimator=token_estimator,
        sampling_overrides=sampling_overrides,
        image_data_urls=image_data_urls,
    )


def _capture() -> tuple[list[tuple[str, dict[str, Any]]], Any]:
    events: list[tuple[str, dict[str, Any]]] = []
    return events, lambda event_type, payload: events.append((event_type, payload))


def _run(model: ApiChatModel) -> Any:
    return asyncio.run(model._agenerate([HumanMessage(content=CANARY)]))


def _sha(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def test_every_step_emits_one_fingerprint_without_prompt_content() -> None:
    events, sink = _capture()
    model = _model(sink=sink)
    model._sender = _FakeSender()  # type: ignore[assignment]
    _run(model)
    _run(model)

    assert len(events) == 2
    assert [payload["document"]["providerStep"] for _, payload in events] == [1, 2]
    event_type, payload = events[0]
    assert event_type == "provider_request_fingerprint"
    document = payload["document"]
    assert document["algo"] == "sha256"
    assert document["dispatchAttempt"] == 1
    assert set(document["layers"]) == {"systemTemplate", "history", "userInput", "toolSchema", "config"}
    assert document["layers"]["history"]["count"] == 1
    assert document["layers"]["toolSchema"]["count"] == 1
    assert document["layers"]["config"]["samplingKeys"] == []

    # T2.2: the request block carries the facts CP persists verbatim (counts/model/api type), and
    # the completed body's own calibration is the byte total - no second measurement.
    request = payload["request"]
    assert request["apiTypeId"] == "openai-chat-completions"
    assert request["apiTypeVersion"] == 1
    assert request["model"] == "fixture-model"
    assert request["messageCount"] == 2  # history turn + current input, both rendered
    assert request["toolCount"] == 1
    assert request["bytesTotal"] == document["outbound"]["bytes"]
    assert request["roleHistogram"] == {"user": 2}

    # The fingerprint half stays content-free (hashes/counts only); only the audit body is verbatim.
    assert CANARY not in json.dumps(payload["document"], ensure_ascii=False)
    assert OLD_TURN not in json.dumps(payload["document"], ensure_ascii=False)
    assert "read_file" not in json.dumps(document, ensure_ascii=False)
    assert len(json.dumps(document).encode("utf-8")) <= provider_fingerprint.FINGERPRINT_MAX_PAYLOAD_BYTES


def test_audit_stores_the_exact_bytes_the_sender_received() -> None:
    events, sink = _capture()
    sender = _FakeSender(provider_usage={"cache_read_input_tokens": 7, "cache_write_input_tokens": 3})
    model = _model(sink=sink)
    model._sender = sender  # type: ignore[assignment]
    _run(model)

    _, payload = events[0]
    audit = payload["audit"]
    wire = sender.audit.request_bytes
    assert audit["tier"] == "full"
    assert audit["providerStep"] == 1
    assert audit["httpStatus"] == 200
    assert audit["streamed"] is True
    assert audit["ttftMs"] == 5 and audit["totalMs"] == 12
    assert audit["request"]["bytes"] == len(wire)
    assert audit["request"]["sha256"] == _sha(wire)
    assert base64.b64decode(audit["request"]["bodyB64"]) == wire
    assert audit["cacheRead"] == 7 and audit["cacheWrite"] == 3
    assert audit["requestParams"]["model"] == "fixture-model"
    assert audit["toolSurface"]["count"] == 1
    assert CANARY in base64.b64decode(audit["request"]["bodyB64"]).decode("utf-8")
    assert payload["audit"]["finishReason"] is None


def test_metadata_tier_keeps_only_hashes_and_bytes() -> None:
    events, sink = _capture()
    sender = _FakeSender()
    model = _model(sink=sink, audit_tier="metadata")
    model._sender = sender  # type: ignore[assignment]
    _run(model)

    audit = events[0][1]["audit"]
    assert audit["tier"] == "metadata"
    assert audit["request"]["bodyB64"] is None
    assert audit["request"]["sha256"] == _sha(sender.audit.request_bytes)
    assert audit["response"]["bodyB64"] is None
    # Params and the tool-surface hash are not prompt text, so metadata keeps them.
    assert audit["requestParams"] == {"model": "fixture-model", "stream": True}
    assert audit["toolSurface"]["count"] == 1


def test_off_tier_emits_fingerprint_but_no_bodies_or_params() -> None:
    events, sink = _capture()
    model = _model(sink=sink, audit_tier="off")
    model._sender = _FakeSender()  # type: ignore[assignment]
    _run(model)

    audit = events[0][1]["audit"]
    assert audit["tier"] == "off"
    # Off means nothing about the wire is kept at all - not even a hash.
    assert audit["request"] is None and audit["response"] is None and audit["errorBody"] is None
    assert audit["requestParams"] is None and audit["toolSurface"] is None
    assert events[0][1]["document"]["layers"]["userInput"]  # the fingerprint half still ships


def test_failed_attempt_still_records_its_error_body() -> None:
    events, sink = _capture()
    sender = _FakeSender(http_status=429, response_bytes=b"", error_bytes=b'{"error":"rate"}', error=RuntimeError("provider rejected"))
    model = _model(sink=sink)
    model._sender = sender  # type: ignore[assignment]
    with pytest.raises(RuntimeError):
        _run(model)

    audit = events[0][1]["audit"]
    assert audit["httpStatus"] == 429
    assert audit["errorBody"]["bytes"] == len(b'{"error":"rate"}')
    assert base64.b64decode(audit["errorBody"]["bodyB64"]) == b'{"error":"rate"}'


def test_sampling_and_image_parts_land_in_the_config_layer() -> None:
    events, sink = _capture()
    model = _model(
        sink=sink,
        sampling_overrides={"temperature": 0.2, "top_p": 0.8},
        image_data_urls=["data:image/png;base64,AAAA"],
    )
    model._sender = _FakeSender()  # type: ignore[assignment]
    _run(model)
    _, payload = events[0]
    assert payload["document"]["layers"]["config"]["samplingKeys"] == ["temperature", "top_p"]
    assert payload["document"]["layers"]["config"]["imageParts"] == 1


def test_estimator_behaviour_is_unchanged_by_the_fingerprint() -> None:
    events, sink = _capture()
    estimated: list[dict[str, Any]] = []

    def estimator(body: dict[str, Any]) -> int:
        estimated.append(body)
        return 42

    model = _model(sink=sink, token_estimator=estimator)
    model._sender = _FakeSender()  # type: ignore[assignment]
    _run(model)
    _run(model)
    assert len(events) == 2
    assert model.estimated_step_count == 2
    assert model.estimated_input_tokens == 84
    assert len(estimated) == 2
    assert estimated[0]["model"] == "fixture-model"


def test_disabled_switch_emits_nothing() -> None:
    events, sink = _capture()
    model = _model(sink=sink, enabled=False)
    model._sender = _FakeSender()  # type: ignore[assignment]
    _run(model)
    assert events == []


def test_missing_sink_is_silent() -> None:
    model = _model(sink=None)
    model._sender = _FakeSender()  # type: ignore[assignment]
    assert _run(model) is not None


def test_failing_sink_never_breaks_dispatch() -> None:
    def broken_sink(event_type: str, payload: dict[str, Any]) -> None:
        raise RuntimeError("relay down")

    model = _model(sink=broken_sink)
    model._sender = _FakeSender()  # type: ignore[assignment]
    assert _run(model) is not None


def test_rejected_before_dispatch_records_nothing() -> None:
    events, sink = _capture()
    model = _model(sink=sink)
    model._sender = _FakeSender()  # type: ignore[assignment]
    sender = model._sender
    sender.audit = None

    async def _empty(body: dict[str, Any]):
        if False:
            yield ("", "", None)

    sender.stream = _empty  # type: ignore[method-assign]
    with pytest.raises(Exception):
        _run(model)
    assert events == []


def test_oversized_document_emits_fail_open_error_document(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(provider_fingerprint, "FINGERPRINT_MAX_PAYLOAD_BYTES", 16)
    events, sink = _capture()
    model = _model(sink=sink)
    model._sender = _FakeSender()  # type: ignore[assignment]
    _run(model)
    assert events[0][1]["document"] == {"status": "error", "reasonCode": "FINGERPRINT_TOO_LARGE"}


def _snapshot(entries: dict[str, dict[str, str]] | None = None) -> RunConfigSnapshot:
    return RunConfigSnapshot(
        workspace_id="workspace-fixture",
        user_id=None,
        fetched_at=0.0,
        entries=entries or {},
        revisions={},
    )


def test_switch_defaults_to_enabled_when_the_key_is_absent() -> None:
    assert _resolve_provider_fingerprint_enabled(_snapshot()) is True


def test_switch_reads_workspace_level_value() -> None:
    enabled = _snapshot({"agent-runtime": {"providerRequestFingerprintEnabled": "true"}})
    disabled = _snapshot({"agent-runtime": {"providerRequestFingerprintEnabled": "false"}})
    assert _resolve_provider_fingerprint_enabled(enabled) is True
    assert _resolve_provider_fingerprint_enabled(disabled) is False


def test_switch_is_independent_from_the_0666_fingerprint_key() -> None:
    entries = {"context-policy": {"fingerprintEnabled": "false"}}
    assert _resolve_provider_fingerprint_enabled(_snapshot(entries)) is True


def test_switch_accepts_run_workspace_overrides() -> None:
    snapshot = _snapshot({"agent-runtime": {"providerRequestFingerprintEnabled": "true"}})
    assert (
        _resolve_provider_fingerprint_enabled(
            snapshot, None, {"agent-runtime": {"providerRequestFingerprintEnabled": "false"}}
        )
        is False
    )


def test_switch_ignores_unrecognized_values_and_defaults_enabled() -> None:
    snapshot = _snapshot({"agent-runtime": {"providerRequestFingerprintEnabled": "maybe"}})
    assert _resolve_provider_fingerprint_enabled(snapshot) is True


def test_audit_tier_defaults_to_full_when_the_key_is_absent() -> None:
    assert _resolve_provider_audit_tier(_snapshot()) == "full"


def test_audit_tier_reads_the_three_known_values() -> None:
    for value in ("full", "metadata", "off"):
        snapshot = _snapshot({"agent-runtime": {"providerAudit": value}})
        assert _resolve_provider_audit_tier(snapshot) == value


def test_audit_tier_accepts_run_workspace_overrides() -> None:
    snapshot = _snapshot({"agent-runtime": {"providerAudit": "full"}})
    assert (
        _resolve_provider_audit_tier(
            snapshot, None, {"agent-runtime": {"providerAudit": "off"}}
        )
        == "off"
    )


def test_audit_tier_ignores_unrecognized_values_and_keeps_full() -> None:
    snapshot = _snapshot({"agent-runtime": {"providerAudit": "verbose"}})
    assert _resolve_provider_audit_tier(snapshot) == "full"
