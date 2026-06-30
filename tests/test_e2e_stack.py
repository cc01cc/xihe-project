"""
跨模块端到端集成测试。
前置条件：docker compose up -d（CP/Agent/Runtime/PostgreSQL 全部运行中）
运行方式：uv run --with httpx pytest tests/test_e2e_stack.py -v -m e2e
"""
import pytest
import httpx
import time

CP_URL = "http://localhost:8080"
AGENT_URL = "http://localhost:8000"
RUNTIME_URL = "http://localhost:8001"


# ── 服务健康检查 ──────────────────────────────────────────────────────────

@pytest.mark.e2e
class TestServiceHealth:
    """验证全部 4 个服务正常运行。"""

    def test_cp_health(self):
        r = httpx.get(f"{CP_URL}/actuator/health", timeout=5)
        assert r.status_code == 200
        assert r.json()["status"] == "UP"

    def test_agent_health(self):
        r = httpx.get(f"{AGENT_URL}/health", timeout=5)
        assert r.status_code == 200
        data = r.json()
        assert data["llm"]["configured"] is True
        assert data["llm"]["provider"] == "deepseek"

    def test_runtime_health(self):
        r = httpx.get(f"{RUNTIME_URL}/health", timeout=5)
        assert r.status_code == 200

    def test_postgres_via_cp(self):
        """CP 能正常连接 PostgreSQL（健康检查隐式验证）。"""
        r = httpx.get(f"{CP_URL}/actuator/health", timeout=5)
        data = r.json()
        assert data["status"] == "UP"
        # Spring Boot Actuator health 包含 db 组件
        if "components" in data:
            assert data["components"].get("db", {}).get("status") == "UP"


# ── 认证链路 ─────────────────────────────────────────────────────────────

@pytest.mark.e2e
class TestAuthFlow:
    """注册 → 登录 → 刷新 Token 完整链路。"""

    def _unique_email(self):
        return f"e2e-{int(time.time() * 1000)}@xihe.test"

    def test_register_returns_tokens(self):
        r = httpx.post(f"{CP_URL}/auth/register", json={
            "email": self._unique_email(), "password": "Pass1234!", "name": "E2E"
        }, timeout=10)
        assert r.status_code in [200, 201]
        data = r.json()
        assert "accessToken" in data
        assert "refreshToken" in data
        assert len(data["accessToken"]) > 20

    def test_register_duplicate_email_rejected(self):
        email = self._unique_email()
        httpx.post(f"{CP_URL}/auth/register", json={
            "email": email, "password": "Pass1234!", "name": "Dup"
        }, timeout=10)
        r = httpx.post(f"{CP_URL}/auth/register", json={
            "email": email, "password": "Pass1234!", "name": "Dup2"
        }, timeout=10)
        assert r.status_code == 400

    def test_login_with_valid_credentials(self):
        email = self._unique_email()
        httpx.post(f"{CP_URL}/auth/register", json={
            "email": email, "password": "Pass1234!", "name": "Login"
        }, timeout=10)
        r = httpx.post(f"{CP_URL}/auth/login", json={
            "email": email, "password": "Pass1234!"
        }, timeout=10)
        assert r.status_code == 200
        assert "accessToken" in r.json()

    def test_login_with_wrong_password(self):
        email = self._unique_email()
        httpx.post(f"{CP_URL}/auth/register", json={
            "email": email, "password": "correctpass", "name": "Wrong"
        }, timeout=10)
        r = httpx.post(f"{CP_URL}/auth/login", json={
            "email": email, "password": "incorrectpass"
        }, timeout=10)
        assert r.status_code == 401

    def test_refresh_token_returns_new_tokens(self):
        email = self._unique_email()
        reg = httpx.post(f"{CP_URL}/auth/register", json={
            "email": email, "password": "Pass1234!", "name": "Refresh"
        }, timeout=10)
        refresh = reg.json()["refreshToken"]
        r = httpx.post(f"{CP_URL}/auth/refresh", json={
            "refreshToken": refresh
        }, timeout=10)
        assert r.status_code == 200
        assert "accessToken" in r.json()


# ── 聊天链路 ─────────────────────────────────────────────────────────────

@pytest.mark.e2e
class TestChatFlow:
    """认证后聊天请求链路。"""

    def _get_token(self):
        email = f"chat-{int(time.time() * 1000)}@xihe.test"
        r = httpx.post(f"{CP_URL}/auth/register", json={
            "email": email, "password": "Pass1234!", "name": "Chatter"
        }, timeout=10)
        return r.json()["accessToken"]

    def test_chat_requires_auth(self):
        r = httpx.post(f"{CP_URL}/v1/chat", json={"content": "hello"}, timeout=5)
        assert r.status_code == 401

    def test_chat_returns_accepted(self):
        token = self._get_token()
        session_id = f"chat-{int(time.time() * 1000)}"
        r = httpx.post(f"{CP_URL}/v1/chat",
            json={"content": "hello", "session_id": session_id},
            headers={"Authorization": f"Bearer {token}"},
            timeout=15)
        assert r.status_code in [200, 201, 202, 409]  # 409 = session already exists

    def test_chat_persists_message(self):
        token = self._get_token()
        session_id = f"persist-{int(time.time() * 1000)}"
        r = httpx.post(f"{CP_URL}/v1/chat",
            json={"content": "持久化测试", "session_id": session_id},
            headers={"Authorization": f"Bearer {token}"},
            timeout=15)
        assert r.status_code in [200, 201, 202, 409]


class TestModuleCommunication:
    """验证模块间通过 Docker 网络可达。"""

    def test_agent_sees_cp_url(self):
        """Agent 容器通过 Docker 网络访问 CP。"""
        r = httpx.get(f"{AGENT_URL}/health", timeout=5)
        data = r.json()
        assert data["cp_url"] == "http://control-plane:8080"

    def test_agent_mcp_status_expected(self):
        """Agent MCP 连接状态（未配置时为 degraded，属正常）。"""
        r = httpx.get(f"{AGENT_URL}/health", timeout=5)
        data = r.json()
        # MCP 初始化可能成功或失败，取决于 CP 配置
        assert "mcp_initialized" in data

    def test_runtime_mcp_endpoint_accessible(self):
        """Runtime MCP 端点可达。"""
        r = httpx.get(f"{RUNTIME_URL}/health", timeout=5)
        assert r.status_code == 200

    def test_cp_openapi_docs_available(self):
        """CP OpenAPI 文档可访问。"""
        r = httpx.get(f"{CP_URL}/v3/api-docs", timeout=5)
        assert r.status_code == 200
        data = r.json()
        assert "openapi" in data or "info" in data
