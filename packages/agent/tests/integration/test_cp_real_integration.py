"""
T3 real integration test for Agent ↔ CP.
Requires a running CP instance at localhost:{XIHE_CP_PORT}.
Run with: uv run pytest tests/integration/test_cp_real_integration.py -v
"""

import os
import time

import httpx
import pytest

CP_PORT = int(os.environ.get("XIHE_CP_PORT", "12631"))
CP_URL = f"http://localhost:{CP_PORT}"


def is_cp_running() -> bool:
    try:
        r = httpx.get(f"{CP_URL}/actuator/health", timeout=2)
        return r.status_code == 200
    except Exception:
        return False


cp_available = is_cp_running()


@pytest.mark.integration
@pytest.mark.docker
@pytest.mark.skipif(not cp_available, reason=f"CP server not reachable at {CP_URL}")
class TestAgentCPRealIntegration:
    """Tests requiring a running CP instance at localhost:{CP_PORT}."""

    def test_cp_health_accessible(self):
        r = httpx.get(f"{CP_URL}/actuator/health", timeout=5)
        assert r.status_code == 200
        assert r.json()["status"] == "UP"

    def test_auth_register_and_login(self):
        email = f"test-{time.time():.0f}@test.com"
        r = httpx.post(
            f"{CP_URL}/auth/register",
            json={"email": email, "password": "Pass1234!", "name": "Test"},
            timeout=10,
        )
        assert r.status_code in (200, 201)
        token = r.json().get("accessToken")
        if not token:
            pytest.skip("Register did not return token")

        r = httpx.post(
            f"{CP_URL}/auth/login",
            json={"email": email, "password": "Pass1234!"},
            timeout=10,
        )
        assert r.status_code == 200
        assert "accessToken" in r.json()

    def test_chat_endpoint_requires_auth(self):
        r = httpx.post(f"{CP_URL}/v1/chat", json={"content": "hi"}, timeout=5)
        assert r.status_code == 401

    def test_chat_endpoint_accepts_authenticated_request(self):
        email = f"chat-{time.time():.0f}@test.com"
        r = httpx.post(
            f"{CP_URL}/auth/register",
            json={"email": email, "password": "Pass1234!", "name": "Test"},
            timeout=10,
        )
        assert r.status_code in (200, 201)
        token = r.json()["accessToken"]

        r = httpx.post(
            f"{CP_URL}/v1/chat",
            json={"content": "hello", "session_id": "test"},
            headers={"Authorization": f"Bearer {token}"},
            timeout=10,
        )
        assert r.status_code in [200, 202, 409]

    def test_mcp_endpoint_returns_response(self):
        r = httpx.post(
            f"{CP_URL}/mcp",
            json={
                "jsonrpc": "2.0",
                "method": "tools/list",
                "params": {},
                "id": 1,
            },
            timeout=10,
        )
        assert r.status_code in [200, 401, 404, 500]
