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


def _create_session(base_url: str) -> tuple[str, dict[str, str]]:
    registration = httpx.post(
        f"{base_url}/api/v1/auth/register",
        json={
            "email": f"ui-proxy-{os.getpid()}@test.com",
            "password": "Pass1234!",
            "name": "UI Proxy",
        },
        timeout=10,
        trust_env=False,
    )
    assert registration.status_code == 201, registration.text
    auth = registration.json()
    headers = {
        "Authorization": f"Bearer {auth['accessToken']}",
        "X-Workspace-Id": auth["workspaceId"],
    }
    session = httpx.post(
        f"{base_url}/api/v1/sessions",
        json={"title": "UI Proxy"},
        headers=headers,
        timeout=10,
        trust_env=False,
    )
    assert session.status_code == 201, session.text
    return session.json()["id"], headers


def test_ui_dev_proxy_stream(ui_stack):
    """Vite dev proxy should stream CP responses through /api."""
    session_id, headers = _create_session(ui_stack["ui_url"])
    events_url = f"{ui_stack['ui_url']}/api/v1/events?sessionId={session_id}"

    with httpx.stream("GET", events_url, headers=headers, timeout=30, trust_env=False) as events_response:
        assert events_response.status_code == 200
        assert "text/event-stream" in events_response.headers.get("content-type", "")
        events = _iter_sse_events(events_response.iter_lines())
        _wait_for_connected_event(events)

        chat_response = httpx.post(
            f"{ui_stack['ui_url']}/api/v1/chat",
            json={
                "sessionId": session_id,
                "content": "读取 test.txt",
                "stream": True,
                "toolMode": "workspace",
            },
            headers=headers,
            timeout=30,
            trust_env=False,
        )
        assert chat_response.status_code == 202
        assert chat_response.json()["status"] == "accepted"

        streamed_text = _collect_stream_text(events)
        assert "Hello from xihe workspace" in streamed_text
