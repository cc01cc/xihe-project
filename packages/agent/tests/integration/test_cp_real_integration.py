"""
T3 real integration test for Agent ↔ CP.
Requires a running CP instance at localhost:{XIHE_CP_PORT}.
Run with: uv run pytest tests/integration/test_cp_real_integration.py -v

PLAN-0410 T3.3: beyond the legacy auth/health legs this file now verifies the
branch context API and the Agent LLM-input source against the REAL
CP/Agent/PostgreSQL partial-stack profile.
"""

import os
import time
import uuid

import httpx
import pytest

CP_PORT = int(os.environ.get("XIHE_CP_PORT", "12631"))
CP_URL = f"http://localhost:{CP_PORT}"
AGENT_PORT = int(os.environ.get("XIHE_AGENT_PORT", "12632"))
AGENT_URL = os.environ.get("XIHE_AGENT_URL", f"http://localhost:{AGENT_PORT}")
# Service Bearer shared by the compose stack (docker-compose.yml
# XIHE_CP_API_TOKEN default) — the same token the Agent container uses.
SERVICE_TOKEN = os.environ.get("XIHE_CP_API_TOKEN", "dev-token-not-secure")


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
            f"{CP_URL}/api/v1/auth/register",
            json={"email": email, "password": "Pass1234!", "name": "Test"},
            timeout=10,
        )
        assert r.status_code in (200, 201)
        token = r.json().get("accessToken")
        if not token:
            pytest.skip("Register did not return token")

        r = httpx.post(
            f"{CP_URL}/api/v1/auth/login",
            json={"email": email, "password": "Pass1234!"},
            timeout=10,
        )
        assert r.status_code == 200
        assert "accessToken" in r.json()

    def test_chat_endpoint_requires_auth(self):
        r = httpx.post(f"{CP_URL}/api/v1/chat", json={"content": "hi"}, timeout=5)
        assert r.status_code == 401

    def test_chat_endpoint_accepts_authenticated_request(self):
        email = f"chat-{time.time():.0f}@test.com"
        r = httpx.post(
            f"{CP_URL}/api/v1/auth/register",
            json={"email": email, "password": "Pass1234!", "name": "Test"},
            timeout=10,
        )
        assert r.status_code in (200, 201)
        token = r.json()["accessToken"]

        r = httpx.post(
            f"{CP_URL}/api/v1/chat",
            json={"content": "hello", "sessionId": "test"},
            headers={"Authorization": f"Bearer {token}"},
            timeout=10,
        )
        assert r.status_code in [200, 202, 409]

    def test_mcp_endpoint_returns_response(self):
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
        assert r.status_code in [200, 401, 404, 500]

    # ------------------------------------------------------------------
    # PLAN-0410 T3.3: branch context API on the real CP/PG stack
    # ------------------------------------------------------------------

    def test_branch_context_snapshot_api_is_branch_scoped_and_fail_closed(self):
        token = self._register_and_login()
        session_id = self._create_placeholder_session(token)
        service = {"Authorization": f"Bearer {SERVICE_TOKEN}"}
        base = f"{CP_URL}/internal/v1/context/{session_id}"

        root = httpx.get(f"{base}/snapshot", headers=service, timeout=15)
        assert root.status_code == 200, root.text
        branch_id = root.json().get("branch_id")
        assert branch_id, "CP must hand out the durable branch id of this Session's root"

        scoped = httpx.get(
            f"{base}/snapshot", params={"branchId": branch_id}, headers=service, timeout=15
        )
        assert scoped.status_code == 200, scoped.text
        assert scoped.json().get("branch_id") == branch_id

        forged_branch = httpx.get(
            f"{base}/snapshot",
            params={"branchId": str(uuid.uuid4())},
            headers=service,
            timeout=15,
        )
        assert forged_branch.status_code == 404, forged_branch.text
        assert forged_branch.json().get("code") == "BRANCH_NOT_FOUND"

        forged_run = httpx.get(
            f"{base}/snapshot",
            params={"runId": str(uuid.uuid4())},
            headers=service,
            timeout=15,
        )
        assert forged_run.status_code == 404, forged_run.text
        assert forged_run.json().get("code") == "RUN_NOT_FOUND"

        mismatch = httpx.get(
            f"{base}/snapshot",
            params={"branchId": branch_id, "runId": str(uuid.uuid4())},
            headers=service,
            timeout=15,
        )
        assert mismatch.status_code == 404, mismatch.text
        assert mismatch.json().get("code") == "RUN_NOT_FOUND"

        events_url = f"{base}/events"
        rows_before = len(httpx.get(events_url, headers=service, timeout=15).json())

        # Request-body branch injection is rejected with zero side effects.
        injected = httpx.post(
            events_url,
            json={
                "type": "prompt.admitted",
                "payload": {"message": {"role": "human", "content": "x"}},
                "branch_id": branch_id,
            },
            headers={**service, "Content-Type": "application/json"},
            timeout=15,
        )
        assert injected.status_code == 400, injected.text
        assert injected.json().get("code") == "INVALID_REQUEST"

        # Unknown correlation fails closed with zero side effects.
        unknown_correlation = httpx.post(
            events_url,
            json={
                "type": "assistant.responded",
                "payload": {"message": {"role": "ai", "content": "x"}},
                "correlation_id": str(uuid.uuid4()),
            },
            headers={**service, "Content-Type": "application/json"},
            timeout=15,
        )
        assert unknown_correlation.status_code == 404, unknown_correlation.text
        assert unknown_correlation.json().get("code") == "RUN_NOT_FOUND"
        rows_after = len(httpx.get(events_url, headers=service, timeout=15).json())
        assert rows_after == rows_before, "rejected appends must write zero rows"

        # A valid Session/global append persists and flows into the branch snapshot.
        marker = f"t3-branch-{uuid.uuid4().hex[:8]}"
        appended = httpx.post(
            events_url,
            json={
                "type": "context.env_updated",
                "payload": {"branch": "main", "head": marker, "is_repository": True},
            },
            headers={**service, "Content-Type": "application/json"},
            timeout=15,
        )
        assert appended.status_code == 200, appended.text
        snapshot = httpx.get(
            f"{base}/snapshot", params={"branchId": branch_id}, headers=service, timeout=15
        )
        assert snapshot.status_code == 200, snapshot.text
        assert snapshot.json()["epoch"]["env_head"] == marker

    # ------------------------------------------------------------------
    # PLAN-0410 T3.3: Agent LLM-input source == CP branch projection
    # ------------------------------------------------------------------

    async def test_agent_context_provider_loads_branch_scoped_llm_input_from_cp(self):
        from xihe_agent.context.event_sourced_provider import EventSourcedContextProvider
        from xihe_agent.context.store_client import CPContextServiceClient

        token = self._register_and_login()
        session_id = self._create_placeholder_session(token)
        service = {"Authorization": f"Bearer {SERVICE_TOKEN}", "Content-Type": "application/json"}
        marker = f"t3-llm-input-{uuid.uuid4().hex[:8]}"
        posted = httpx.post(
            f"{CP_URL}/internal/v1/context/{session_id}/events",
            json={
                "type": "context.env_updated",
                "payload": {"branch": "main", "head": marker, "is_repository": True},
            },
            headers=service,
            timeout=15,
        )
        assert posted.status_code == 200, posted.text

        # The exact Agent-side client the LLM prompt assembly consumes.
        client = CPContextServiceClient(base_url=CP_URL, api_token=SERVICE_TOKEN)
        provider = EventSourcedContextProvider(client)
        context = await provider.load(session_id, after_sequence=0)
        assert context.branch_id, "the Agent must consume the CP-given branch id"

        projection = httpx.get(
            f"{CP_URL}/internal/v1/context/{session_id}/snapshot",
            params={"branchId": context.branch_id},
            headers={"Authorization": f"Bearer {SERVICE_TOKEN}"},
            timeout=15,
        )
        assert projection.status_code == 200, projection.text
        truth = projection.json()
        assert truth["branch_id"] == context.branch_id
        assert truth["epoch"]["env_head"] == marker, "LLM input must carry the branch fact"
        assert [(m.role, m.content) for m in context.messages] == [
            (m["role"], m["content"]) for m in truth["messages"]
        ], "Agent LLM input must equal the CP branch projection, message for message"

        # Fail-closed from the Agent's own client: a forged branch never
        # degrades into a full-Session context.
        with pytest.raises(httpx.HTTPStatusError) as excinfo:
            await client.get_context_snapshot(session_id, branch_id=str(uuid.uuid4()))
        assert excinfo.value.response.status_code == 404

    # ------------------------------------------------------------------
    # PLAN-0410 T3.3: Agent process readiness is explicit (never implicit)
    # ------------------------------------------------------------------

    def test_agent_process_health_and_llm_readiness_is_explicit(self):
        r = httpx.get(f"{AGENT_URL}/internal/v1/agent/health", timeout=10)
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["liveness"] in ("up", "starting"), body
        # llmReady contract (packages/agent/AGENTS.md): independent from HTTP
        # liveness and fail-closed through an explicit state, never implicit.
        assert body["llmReady"] in (
            "missing_credentials",
            "invalid_credentials",
            "unreachable",
            "model_unavailable",
            "ready",
        ), f"LLM readiness must be reported explicitly, got {body['llmReady']!r}"
        assert body.get("llm") is not None, "LLM readiness detail must be exposed"

    # ------------------------------------------------------------------
    # helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _register_and_login() -> str:
        email = f"t3-branch-{uuid.uuid4().hex[:10]}@test.com"
        password = "Pass1234!"
        r = httpx.post(
            f"{CP_URL}/api/v1/auth/register",
            json={"email": email, "password": password, "name": "T3Branch"},
            timeout=15,
        )
        assert r.status_code in (200, 201), r.text
        r = httpx.post(
            f"{CP_URL}/api/v1/auth/login",
            json={"email": email, "password": password},
            timeout=15,
        )
        assert r.status_code == 200, r.text
        token = r.json().get("accessToken")
        assert token, r.text
        return token

    @staticmethod
    def _create_placeholder_session(token: str) -> str:
        """Creates a Session through the production attachment-placeholder
        entry point (H3) — the only Session producer a self-registered USER
        can reach without an explicit CREATE_ACCOUNT grant (0374/0407)."""
        session_id = str(uuid.uuid4())
        r = httpx.post(
            f"{CP_URL}/api/v1/sessions/{session_id}/attachments",
            headers={"Authorization": f"Bearer {token}"},
            files={"files": ("t3-probe.png", b"\x89PNG\r\n\x1a\n", "image/png")},
            timeout=30,
        )
        assert r.status_code == 200, r.text
        return session_id
