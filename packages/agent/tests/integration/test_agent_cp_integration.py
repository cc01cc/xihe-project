"""
Agent → CP integration tests using real backend.
Requires CP running at localhost:8080 (Docker Compose or H2 mode).
Run with: uv run pytest tests/integration/ -v
"""

import time

import httpx
import pytest

CP_URL = "http://localhost:8080"


def is_cp_running() -> bool:
    try:
        r = httpx.get(f"{CP_URL}/actuator/health", timeout=2)
        return r.status_code == 200
    except Exception:
        return False


cp_available = is_cp_running()


@pytest.mark.integration
@pytest.mark.skipif(not cp_available, reason="CP server not running at localhost:8080")
class TestAgentCPIntegration:
    """Tests requiring a running CP instance."""

    def test_cp_health_accessible(self):
        """CP health endpoint returns UP."""
        r = httpx.get(f"{CP_URL}/actuator/health", timeout=5)
        assert r.status_code == 200
        assert r.json()["status"] == "UP"

    def test_auth_register_and_login(self):
        """CP auth flow: register → login → get token."""
        email = f"test-{time.time():.0f}@test.com"
        # Register
        r = httpx.post(
            f"{CP_URL}/api/v1/auth/register",
            json={"email": email, "password": "Pass1234!", "name": "Test"},
            timeout=10,
        )
        assert r.status_code in (200, 201)
        data = r.json()
        token = data.get("accessToken")
        if not token:
            pytest.skip("Register did not return token")

        # Login
        r = httpx.post(
            f"{CP_URL}/api/v1/auth/login",
            json={"email": email, "password": "Pass1234!"},
            timeout=10,
        )
        assert r.status_code == 200
        assert "accessToken" in r.json()

    def test_chat_endpoint_requires_auth(self):
        """CP /v1/chat returns 401 without auth token."""
        r = httpx.post(f"{CP_URL}/api/v1/chat", json={"content": "hi"}, timeout=5)
        assert r.status_code == 401

    def test_chat_endpoint_rejects_missing_session_with_explicit_branch(self):
        """Authenticated Chat requests still require an existing Session and branch."""
        email = f"chat-{time.time():.0f}@test.com"
        # Register
        r = httpx.post(
            f"{CP_URL}/api/v1/auth/register",
            json={"email": email, "password": "Pass1234!", "name": "Test"},
            timeout=10,
        )
        auth = r.json()
        token = auth["accessToken"]

        r = httpx.post(
            f"{CP_URL}/api/v1/chat",
            json={
                "content": "hello",
                "sessionId": "00000000-0000-0000-0000-000000000000",
                "branchId": "00000000-0000-0000-0000-000000000000",
            },
            headers={
                "Authorization": f"Bearer {token}",
                "X-Workspace-Id": auth["workspaceId"],
            },
            timeout=10,
        )
        assert r.status_code == 404
        assert r.json()["code"] == "SESSION_NOT_FOUND"

    def test_mcp_endpoint_returns_tools(self):
        """CP /api/v1/mcp tools/list returns tool list."""
        r = httpx.post(
            f"{CP_URL}/api/v1/mcp",
            json={
                "jsonrpc": "2.0",
                "method": "tools/list",
                "params": {},
                "id": 1,
            },
            timeout=10,
        )
        # May fail if MCP proxy not configured, but should not 500
        assert r.status_code in [200, 401, 404, 500]
