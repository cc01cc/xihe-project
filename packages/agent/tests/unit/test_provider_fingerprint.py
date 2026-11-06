"""PLAN-0679 T1.1: canonical sha256 module acceptance (design D3 / risk R2).

Mirrors the 0666 R2 acceptance shape:
- same fixture must hash identically from two independent processes;
- scrambled key insertion order must not change the hash;
- a realistic provider body fixture must hash stably (golden pin).
Plus the D6 rule pins: number normalization, missing-vs-null, escaping, type strictness.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path
from typing import Any

import pytest

from xihe_agent.llm import provider_fingerprint
from xihe_agent.llm.provider_fingerprint import (
    CanonicalValueError,
    build_fingerprint_document,
    canonical_bytes,
    canonical_json,
    fingerprint_event_payload,
    role_histogram,
    sha256_hex,
    strip_volatile,
)

FIXTURE = Path(__file__).parent / "fixtures" / "plan0679_provider_body.json"

# Golden pin: stable serialization of the committed fixture. Only a conscious change to the
# canonical rules may update this constant (it must be a design-level change, not incidental).
GOLDEN_FIXTURE_SHA256 = "8952eb6e1e079c8e52ab35836dce70903e9ae7a7e3d8cd7d1b8691a391942d26"


def _load_fixture() -> Any:
    return json.loads(FIXTURE.read_text(encoding="utf-8"))


def test_same_fixture_two_independent_processes_equal() -> None:
    """R2: two fresh interpreter processes must agree on the fixture hash."""
    script = (
        "import json,sys;"
        "from pathlib import Path;"
        "sys.path.insert(0, r'{src}');"
        "from xihe_agent.llm.provider_fingerprint import sha256_hex;"
        "print(sha256_hex(json.loads(Path(r'{fixture}').read_text(encoding='utf-8'))))"
    ).format(src=str(Path(__file__).parents[2] / "src"), fixture=str(FIXTURE))
    hashes = [
        subprocess.run(
            [sys.executable, "-c", script],
            capture_output=True,
            text=True,
            check=True,
            timeout=60,
        ).stdout.strip()
        for _ in range(2)
    ]
    assert hashes[0] == hashes[1]
    assert hashes[0] == sha256_hex(_load_fixture())


def test_key_order_scrambled_equal() -> None:
    body = _load_fixture()
    body["messages"][1]["content"].reverse()  # array order is semantic: must change the hash
    body["messages"][2]["tool_calls"][0]["function"] = dict(
        reversed(list(body["messages"][2]["tool_calls"][0]["function"].items()))
    )
    straight = sha256_hex(_load_fixture())
    assert straight != sha256_hex(body)  # arrays are order-sensitive by design

    def scramble(value: Any) -> Any:
        if isinstance(value, dict):
            return {k: scramble(v) for k, v in reversed(list(value.items()))}
        if isinstance(value, list):
            return [scramble(item) for item in value]
        return value

    assert sha256_hex(scramble(_load_fixture())) == straight


def test_real_body_fixture_golden_pin() -> None:
    assert sha256_hex(_load_fixture()) == GOLDEN_FIXTURE_SHA256


def test_number_normalization() -> None:
    assert canonical_json(1) == canonical_json(1.0) == canonical_json(1.00) == "1"
    assert canonical_json(0.0) == canonical_json(-0.0) == "0"
    assert canonical_json(1e23) == "100000000000000000000000"  # plain, no exponent
    assert canonical_json(1e-7) == "0.0000001"
    assert canonical_json(1.50) == "1.5"
    for bad in (float("nan"), float("inf"), float("-inf")):
        with pytest.raises(CanonicalValueError):
            canonical_json(bad)


def test_missing_key_vs_explicit_null_different() -> None:
    assert sha256_hex({}) != sha256_hex({"k": None})
    assert canonical_json({"k": None}) == '{"k":null}'


def test_bool_distinct_from_int() -> None:
    assert canonical_json(True) == "true"
    assert sha256_hex(True) != sha256_hex(1)
    assert canonical_json([False, 0]) == "[false,0]"


def test_string_escaping_rules() -> None:
    assert canonical_json('a"b\\c\nd\te') == '"a\\"b\\\\c\\nd\\te"'
    cjk = chr(0x4E2D) + chr(0x6587) + chr(0x2192) + "emoji"  # built from code points: no invisible chars
    quoted = '"' + cjk + '"'
    assert canonical_json(cjk) == quoted  # verbatim, not \\u-escaped
    assert canonical_bytes(cjk) == quoted.encode("utf-8")
    # C0 controls get \\u00xx escapes; CJK neighbors stay verbatim.
    assert canonical_json("\x00\x1f" + chr(0x4E2D)) == '"\\u0000\\u001f' + chr(0x4E2D) + '"'


def test_unsupported_and_malformed_inputs_rejected() -> None:
    for bad in ({1: "x"}, {"a": {2: "y"}}, object(), {"s": bytearray(b"x")}):
        with pytest.raises(CanonicalValueError):
            canonical_json(bad)


def test_strip_volatile_removes_recursively_arrays_keep_position() -> None:
    body = {
        "model": "m",
        "nested": {"request_id": "r1", "keep": 1, "deeper": [{"user": "u", "n": 2}]},
        "messages": [{"role": "user", "user": "u1"}],
    }
    stripped = strip_volatile(body, frozenset({"request_id", "user"}))
    assert stripped == {
        "model": "m",
        "nested": {"keep": 1, "deeper": [{"n": 2}]},
        "messages": [{"role": "user"}],
    }
    assert body["nested"]["request_id"] == "r1"  # input untouched
    assert sha256_hex(stripped) == sha256_hex(strip_volatile(stripped, frozenset()))


def test_canonical_json_tolerates_tuples_as_arrays() -> None:
    assert canonical_json((1, 2)) == canonical_json([1, 2]) == "[1,2]"


# --- PLAN-0679 T1.2: six-layer document builder (design 4.2) ----------------------------


def _document(**overrides: Any) -> dict[str, Any]:
    body = _load_fixture()
    arguments: dict[str, Any] = {
        "input_field": "messages",
        "history_count": 3,
        "sampling_overrides": {"temperature": 0.7},
        "image_part_count": 1,
        "provider_step": 1,
    }
    arguments.update(overrides)
    return build_fingerprint_document(body, **arguments)


def test_document_shape_has_all_six_layers_and_metadata() -> None:
    document = _document()
    assert document["algo"] == "sha256"
    assert document["dispatchAttempt"] == 1
    assert document["providerStep"] == 1
    assert set(document["layers"]) == {"systemTemplate", "history", "userInput", "toolSchema", "config"}
    assert set(document["outbound"]) == {"hash", "bytes"}
    assert document["layers"]["history"]["count"] == 3
    assert document["layers"]["toolSchema"]["count"] == 2
    assert document["layers"]["config"]["samplingKeys"] == ["temperature"]
    assert document["layers"]["config"]["imageParts"] == 1


def test_document_layers_split_render_product_without_leaking_content() -> None:
    document = _document()
    serialized = json.dumps(document, ensure_ascii=False)
    assert "总结这张截图" not in serialized
    assert "https://provider.invalid" not in serialized

    body = _load_fixture()
    changed_history = _load_fixture()
    changed_history["messages"][0]["content"] = "different system prompt"
    changed_current = _load_fixture()
    changed_current["messages"][-1]["content"] = "different current turn"
    changed_sampling = _load_fixture()
    changed_sampling["temperature"] = 0.1
    changed_tools = _load_fixture()
    changed_tools["tools"].pop()

    def layers(candidate: dict[str, Any]) -> dict[str, Any]:
        return build_fingerprint_document(
            candidate,
            input_field="messages",
            history_count=3,
            sampling_overrides={"temperature": 0.7},
            image_part_count=1,
            provider_step=1,
        )["layers"]

    base = layers(body)
    # History is the first `count` rendered records; the current turn is the tail.
    assert layers(changed_history)["history"]["hash"] != base["history"]["hash"]
    assert layers(changed_history)["userInput"]["hash"] == base["userInput"]["hash"]
    assert layers(changed_current)["userInput"]["hash"] != base["userInput"]["hash"]
    assert layers(changed_current)["history"]["hash"] == base["history"]["hash"]
    # Sampling lives in the template remainder; the tool schema is its own layer.
    assert layers(changed_sampling)["systemTemplate"]["hash"] != base["systemTemplate"]["hash"]
    assert layers(changed_tools)["toolSchema"]["hash"] != base["toolSchema"]["hash"]
    assert layers(changed_tools)["systemTemplate"]["hash"] == base["systemTemplate"]["hash"]
    # The calibration layer covers the complete body.
    assert sha256_hex(body) == build_fingerprint_document(
        body,
        input_field="messages",
        history_count=3,
        sampling_overrides={"temperature": 0.7},
        image_part_count=1,
        provider_step=1,
    )["outbound"]["hash"]


def test_document_history_count_clamps_to_rendered_records() -> None:
    fixture = _load_fixture()
    document = _document(history_count=99)
    assert document["layers"]["history"]["count"] == len(fixture["messages"])
    assert document["layers"]["userInput"]["bytes"] == len(canonical_bytes([]))


def test_document_without_tools_reports_zero_count() -> None:
    fixture = _load_fixture()
    fixture.pop("tools")
    document = build_fingerprint_document(
        fixture,
        input_field="messages",
        history_count=0,
        sampling_overrides=None,
        image_part_count=0,
        provider_step=2,
    )
    assert document["layers"]["toolSchema"] == {"count": 0}
    assert document["providerStep"] == 2


def test_oversized_document_fails_open_with_error_payload(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(provider_fingerprint, "FINGERPRINT_MAX_PAYLOAD_BYTES", 16)
    payload = fingerprint_event_payload(_document(), api_type_id="openai-chat", model="m")
    # The document slot carries the error marker (observable on the read side as
    # FINGERPRINT_TOO_LARGE); the request block still identifies the run's api type/model.
    assert payload["document"] == {"status": "error", "reasonCode": "FINGERPRINT_TOO_LARGE"}
    assert payload["request"]["apiTypeId"] == "openai-chat"


def test_normal_document_passes_through_event_payload() -> None:
    document = _document()
    payload = fingerprint_event_payload(
        document,
        api_type_id="openai-chat",
        api_type_version=3,
        model="openai/gpt-5",
        message_count=4,
        tool_count=2,
        bytes_total=1024,
        role_histogram={"user": 1, "assistant": 3},
    )
    # T2.2 contract: the document is carried verbatim inside the envelope; the request block is
    # assembled from the values the caller measured on the final rendered body.
    assert payload["document"] is document
    assert payload["request"] == {
        "apiTypeId": "openai-chat",
        "apiTypeVersion": 3,
        "model": "openai/gpt-5",
        "messageCount": 4,
        "toolCount": 2,
        "bytesTotal": 1024,
        "roleHistogram": {"user": 1, "assistant": 3},
    }


def test_event_payload_defaults_are_absent_not_fake() -> None:
    payload = fingerprint_event_payload(_document())
    request = payload["request"]
    assert request["apiTypeId"] == ""
    assert request["apiTypeVersion"] is None
    assert request["messageCount"] == 0
    assert request["toolCount"] == 0
    # bytesTotal falls back to the document's own outbound calibration, never 0.
    assert request["bytesTotal"] == payload["document"]["outbound"]["bytes"]
    assert request["roleHistogram"] == {}


def test_role_histogram_counts_only_textual_roles() -> None:
    records = [
        {"role": "user", "content": "a"},
        {"role": "assistant", "content": "b"},
        {"role": "assistant", "content": "c"},
        {"content": "no role"},
        {"role": None},
        {"role": ""},
        "not-a-mapping",
    ]
    assert role_histogram(records) == {"user": 1, "assistant": 2}
