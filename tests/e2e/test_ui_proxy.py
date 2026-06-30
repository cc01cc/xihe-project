"""
E2E test: UI dev proxy forwards requests to the control plane.
"""

import os
import json

import httpx


os.environ.pop("HTTP_PROXY", None)
os.environ.pop("HTTPS_PROXY", None)
os.environ.pop("http_proxy", None)
os.environ.pop("https_proxy", None)
os.environ.pop("ALL_PROXY", None)
os.environ.pop("all_proxy", None)


def _iter_sse_events(lines):
    event_name = "message"
    data_lines: list[str] = []

    for line in lines:
        if line == "":
            if data_lines:
                yield event_name, "\n".join(data_lines)
            event_name = "message"
            data_lines = []
            continue

        if line.startswith("event:"):
            event_name = line.split(":", 1)[1].strip()
            continue

        if line.startswith("data:"):
            data_lines.append(line.split(":", 1)[1].strip())


def _wait_for_connected_event(events):
    for event_name, raw_payload in events:
        if event_name == "connected":
            return raw_payload
    raise AssertionError("SSE stream ended before connected event")


def _collect_stream_text(events) -> str:
    chunks: list[str] = []

    for event_name, raw_payload in events:
        payload = json.loads(raw_payload)

        if event_name == "token":
            chunks.append(payload.get("content", ""))
            continue

        if event_name == "error":
            raise AssertionError(payload.get("error", "Unknown SSE error"))

        if event_name == "done":
            return "".join(chunks)

    raise AssertionError("SSE stream ended before done event")


def test_ui_dev_proxy_stream(ui_stack):
    """Vite dev proxy should stream CP responses through /api."""
    session_id = "ui-proxy-test"
    events_url = f"{ui_stack['ui_url']}/api/v1/events?session_id={session_id}"

    with httpx.stream("GET", events_url, timeout=30, trust_env=False) as events_response:
        assert events_response.status_code == 200
        assert "text/event-stream" in events_response.headers.get("content-type", "")
        events = _iter_sse_events(events_response.iter_lines())
        _wait_for_connected_event(events)

        exec_response = httpx.post(
            f"{ui_stack['ui_url']}/api/v1/exec",
            json={
                "session_id": session_id,
                "content": "读取 test.txt",
                "stream": True,
            },
            timeout=30,
            trust_env=False,
        )
        assert exec_response.status_code == 202
        assert exec_response.json()["status"] == "accepted"

        streamed_text = _collect_stream_text(events)
        assert "Hello from xihe workspace" in streamed_text