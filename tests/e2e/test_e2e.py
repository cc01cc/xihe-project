"""
E2E test: Full chain UI → CP → Agent → CP → Runtime
Simulates user interaction by calling CP endpoints directly.
"""
import json
import os

# Disable proxy for local connections.
os.environ.pop("HTTP_PROXY", None)
os.environ.pop("HTTPS_PROXY", None)
os.environ.pop("http_proxy", None)
os.environ.pop("https_proxy", None)
os.environ.pop("ALL_PROXY", None)
os.environ.pop("all_proxy", None)

import httpx


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
        if event_name != "connected":
            continue
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


def _create_session(base_url: str, name: str) -> tuple[str, dict[str, str]]:
    email = f"{name}-{os.getpid()}@test.com"
    registration = httpx.post(
        f"{base_url}/api/v1/auth/register",
        json={"email": email, "password": "Pass1234!", "name": name},
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
        json={"title": name},
        headers=headers,
        timeout=10,
        trust_env=False,
    )
    assert session.status_code == 201, session.text
    return session.json()["id"], headers


def test_e2e_chat(backend_stack):
    """User sends message → Agent replies via CP → UI receives SSE."""
    session_id, headers = _create_session(backend_stack["cp_url"], "e2e-chat")
    events_url = f"{backend_stack['cp_url']}/api/v1/events?sessionId={session_id}"

    with httpx.stream("GET", events_url, headers=headers, timeout=30, trust_env=False) as events_response:
        assert events_response.status_code == 200
        events = _iter_sse_events(events_response.iter_lines())
        _wait_for_connected_event(events)

        chat_response = httpx.post(
            f"{backend_stack['cp_url']}/api/v1/chat",
            json={"sessionId": session_id, "content": "你好", "stream": True, "toolMode": "none"},
            headers=headers,
            timeout=30,
            trust_env=False,
        )
        assert chat_response.status_code == 202
        assert chat_response.json()["status"] == "accepted"

        streamed_text = _collect_stream_text(events)
        assert streamed_text
        assert "你好" in streamed_text or "xihe Agent" in streamed_text


def test_e2e_tool_call(backend_stack):
    """User asks to read file → Agent calls tool → returns file content."""
    session_id, headers = _create_session(backend_stack["cp_url"], "e2e-tool")
    events_url = f"{backend_stack['cp_url']}/api/v1/events?sessionId={session_id}"

    with httpx.stream("GET", events_url, headers=headers, timeout=30, trust_env=False) as events_response:
        assert events_response.status_code == 200
        events = _iter_sse_events(events_response.iter_lines())
        _wait_for_connected_event(events)

        chat_response = httpx.post(
            f"{backend_stack['cp_url']}/api/v1/chat",
            json={"sessionId": session_id, "content": "读取 test.txt", "stream": True, "toolMode": "workspace"},
            headers=headers,
            timeout=30,
            trust_env=False,
        )
        assert chat_response.status_code == 202
        assert chat_response.json()["status"] == "accepted"

        streamed_text = _collect_stream_text(events)
        assert "Hello from xihe workspace" in streamed_text


def test_e2e_health(backend_stack):
    """All services should be healthy."""
    _, headers = _create_session(backend_stack["cp_url"], "e2e-health")
    response = httpx.get(f"{backend_stack['cp_url']}/api/v1/health", timeout=5, trust_env=False)
    assert response.json()["status"] == "UP"

    response = httpx.get(f"{backend_stack['agent_url']}/internal/v1/agent/health", timeout=5, trust_env=False)
    assert response.json()["liveness"] == "up"

    response = httpx.post(
        f"{backend_stack['cp_url']}/api/v1/mcp",
        json={
            "jsonrpc": "2.0",
            "method": "initialize",
            "params": {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {"name": "health-check", "version": "0.1.0"},
            },
            "id": 1,
        },
        headers={**headers, "Content-Type": "application/json", "Accept": "application/json, text/event-stream"},
        timeout=10,
        trust_env=False,
    )
    assert response.status_code == 200
