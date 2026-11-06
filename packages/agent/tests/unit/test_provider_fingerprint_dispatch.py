"""PLAN-0679 T1.2: fingerprint emission wiring on ApiChatModel dispatch (D2/D4/B-1).

Drives ``_dispatch_body`` directly (the same seam the existing adapter tests use) and
asserts the side-channel contract: one event for the first provider step, zero prompt
content, no change to the existing body/estimate behaviour, fail-open on a broken sink.
"""

from __future__ import annotations

import json
from typing import Any

import pytest
from langchain_core.messages import HumanMessage

from xihe_agent.adapters.api_chat_model import ApiChatModel
from xihe_agent.app_state import _resolve_provider_fingerprint_enabled
from xihe_agent.config_snapshot import RunConfigSnapshot
from xihe_agent.llm import provider_fingerprint
from xihe_agent.llm.api_request import chat_type

CANARY = "current-turn-canary-0679"
OLD_TURN = "historical-turn-text-0679"

SOURCE = {
    "model": "${xh.model}",
    "messages": ["${xh.conversation_history}", {"role": "user", "content": "${xh.user_input}"}],
    "tools": ["${xh.tools}"],
    "stream": True,
}


def _model(
    *,
    sink: Any = None,
    enabled: bool = True,
    token_estimator: Any = None,
    sampling_overrides: dict[str, Any] | None = None,
    image_data_urls: list[str] | None = None,
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
        token_estimator=token_estimator,
        sampling_overrides=sampling_overrides,
        image_data_urls=image_data_urls,
    )


def _capture() -> tuple[list[tuple[str, dict[str, Any]]], Any]:
    events: list[tuple[str, dict[str, Any]]] = []
    return events, lambda event_type, payload: events.append((event_type, payload))


def test_first_step_emits_one_fingerprint_without_prompt_content() -> None:
    events, sink = _capture()
    model = _model(sink=sink)
    model._dispatch_body([HumanMessage(content=CANARY)])
    model._dispatch_body([HumanMessage(content=CANARY)])

    assert len(events) == 1
    event_type, payload = events[0]
    assert event_type == "provider_request_fingerprint"
    document = payload["document"]
    assert document["algo"] == "sha256"
    assert document["providerStep"] == 1
    assert document["dispatchAttempt"] == 1
    assert set(document["layers"]) == {"systemTemplate", "history", "userInput", "toolSchema", "config"}
    assert document["layers"]["history"]["count"] == 1
    assert document["layers"]["toolSchema"]["count"] == 1
    assert document["layers"]["config"]["samplingKeys"] == []

    # T2.2: the request block carries the facts CP persists verbatim (counts/model/api type), and
    # the completed body's own calibration is the byte total — no second measurement.
    request = payload["request"]
    assert request["apiTypeId"] == "openai-chat-completions"
    assert request["apiTypeVersion"] == 1
    assert request["model"] == "fixture-model"
    assert request["messageCount"] == 2  # history turn + current input, both rendered
    assert request["toolCount"] == 1
    assert request["bytesTotal"] == document["outbound"]["bytes"]
    assert request["roleHistogram"] == {"user": 2}

    serialized = json.dumps(payload, ensure_ascii=False)
    assert CANARY not in serialized
    assert OLD_TURN not in serialized
    assert "read_file" not in serialized  # tool names never leave the process
    assert len(serialized.encode("utf-8")) <= provider_fingerprint.FINGERPRINT_MAX_PAYLOAD_BYTES


def test_sampling_and_image_parts_land_in_the_config_layer() -> None:
    events, sink = _capture()
    model = _model(
        sink=sink,
        sampling_overrides={"temperature": 0.2, "top_p": 0.8},
        image_data_urls=["data:image/png;base64,AAAA"],
    )
    model._dispatch_body([HumanMessage(content=CANARY)])
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
    first = model._dispatch_body([HumanMessage(content=CANARY)])
    second = model._dispatch_body([HumanMessage(content=CANARY)])
    assert len(events) == 1
    assert model.estimated_step_count == 2
    assert model.estimated_input_tokens == 84
    assert first is estimated[0] and second is estimated[1]  # identity preserved
    assert "messages" in first and first["model"] == "fixture-model"


def test_disabled_switch_emits_nothing() -> None:
    events, sink = _capture()
    model = _model(sink=sink, enabled=False)
    body = model._dispatch_body([HumanMessage(content=CANARY)])
    assert events == []
    assert "messages" in body


def test_missing_sink_is_silent() -> None:
    model = _model(sink=None)
    assert "messages" in model._dispatch_body([HumanMessage(content=CANARY)])


def test_failing_sink_never_breaks_dispatch() -> None:
    def broken_sink(event_type: str, payload: dict[str, Any]) -> None:
        raise RuntimeError("relay down")

    model = _model(sink=broken_sink)
    body = model._dispatch_body([HumanMessage(content=CANARY)])
    assert "messages" in body


def test_oversized_document_emits_fail_open_error_document(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(provider_fingerprint, "FINGERPRINT_MAX_PAYLOAD_BYTES", 16)
    events, sink = _capture()
    model = _model(sink=sink)
    model._dispatch_body([HumanMessage(content=CANARY)])
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
