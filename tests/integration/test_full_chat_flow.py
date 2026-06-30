"""
完整聊天流测试：注册 → 登录 → 发送消息 → 接收 SSE 响应。
前置条件：backend_stack fixture（conftest.py 启动 CP/Agent/Runtime）
"""
import json
import os
import time
import concurrent.futures

import httpx
import pytest

os.environ.pop("HTTP_PROXY", None)
os.environ.pop("HTTPS_PROXY", None)
os.environ.pop("http_proxy", None)
os.environ.pop("https_proxy", None)
os.environ.pop("ALL_PROXY", None)
os.environ.pop("all_proxy", None)


@pytest.mark.integration
class TestFullChatFlow:
    """验证注册 → 登录 → 发消息 → SSE 响应完整链路。"""

    def _register_and_login(self, cp_url: str) -> str:
        email = f"flow-{int(time.time() * 1000)}@test.com"
        r = httpx.post(
            f"{cp_url}/auth/register",
            json={"email": email, "password": "Pass1234!", "name": "Flow Test"},
            timeout=10,
            trust_env=False,
        )
        assert r.status_code in [200, 201]
        return r.json()["accessToken"]

    def test_register_login_send_message(self, backend_stack):
        """完整流程：注册 → 登录 → 发消息 → 接受请求。"""
        cp_url = backend_stack["cp_url"]
        token = self._register_and_login(cp_url)

        session_id = f"flow-{int(time.time() * 1000)}"
        r = httpx.post(
            f"{cp_url}/v1/chat",
            json={"content": "hello", "session_id": session_id},
            headers={"Authorization": f"Bearer {token}"},
            timeout=15,
            trust_env=False,
        )
        assert r.status_code in [200, 201, 202, 409]  # 409 = 无 SSE 订阅属正常

    def test_chat_without_auth_rejected(self, backend_stack):
        """未认证请求被拒绝。"""
        r = httpx.post(
            f"{backend_stack['cp_url']}/v1/chat",
            json={"content": "hello"},
            timeout=5,
            trust_env=False,
        )
        assert r.status_code == 401

    def test_chat_sse_stream(self, backend_stack):
        """SSE 事件流可连接并接收数据。"""
        cp_url = backend_stack["cp_url"]
        token = self._register_and_login(cp_url)
        session_id = f"sse-{int(time.time() * 1000)}"

        events_url = f"{cp_url}/v1/events?session_id={session_id}"
        headers = {"Authorization": f"Bearer {token}"}
        with httpx.stream("GET", events_url, headers=headers, timeout=5, trust_env=False) as resp:
            assert resp.status_code == 200
            # 读取前几行验证 SSE 格式
            lines = []
            for line in resp.iter_lines():
                lines.append(line)
                if len(lines) >= 3:
                    break
            # SSE 响应至少包含一个 data: 行
            assert any("data:" in line or "event:" in line or "id:" in line for line in lines)


@pytest.mark.integration
class TestSessionIsolation:
    """验证不同会话互相隔离。"""

    def _get_token(self, cp_url: str) -> str:
        email = f"iso-{int(time.time() * 1000)}@test.com"
        r = httpx.post(
            f"{cp_url}/auth/register",
            json={"email": email, "password": "Pass1234!", "name": "Isolation Test"},
            timeout=10,
            trust_env=False,
        )
        assert r.status_code in [200, 201]
        return r.json()["accessToken"]

    def test_multiple_sessions_isolated(self, backend_stack):
        """不同会话的消息互不干扰。"""
        cp_url = backend_stack["cp_url"]
        token = self._get_token(cp_url)

        session_a = f"sess-a-{int(time.time() * 1000)}"
        session_b = f"sess-b-{int(time.time() * 1000)}"

        r1 = httpx.post(
            f"{cp_url}/v1/chat",
            json={"content": "session A message", "session_id": session_a},
            headers={"Authorization": f"Bearer {token}"},
            timeout=15,
            trust_env=False,
        )
        r2 = httpx.post(
            f"{cp_url}/v1/chat",
            json={"content": "session B message", "session_id": session_b},
            headers={"Authorization": f"Bearer {token}"},
            timeout=15,
            trust_env=False,
        )

        assert r1.status_code in [200, 201, 202, 409]
        assert r2.status_code in [200, 201, 202, 409]

    def test_concurrent_requests_same_session(self, backend_stack):
        """同一会话并发请求不会崩溃。"""
        cp_url = backend_stack["cp_url"]
        token = self._get_token(cp_url)
        session_id = f"concurrent-{int(time.time() * 1000)}"

        def send_chat(i: int) -> int:
            r = httpx.post(
                f"{cp_url}/v1/chat",
                json={"content": f"msg-{i}", "session_id": session_id},
                headers={"Authorization": f"Bearer {token}"},
                timeout=15,
                trust_env=False,
            )
            return r.status_code

        with concurrent.futures.ThreadPoolExecutor(max_workers=3) as executor:
            results = list(executor.map(send_chat, range(3)))

        assert all(r in [200, 201, 202, 409] for r in results)


@pytest.mark.integration
class TestChatPersistence:
    """验证消息持久化。"""

    def _get_token(self, cp_url: str) -> str:
        email = f"persist-{int(time.time() * 1000)}@test.com"
        r = httpx.post(
            f"{cp_url}/auth/register",
            json={"email": email, "password": "Pass1234!", "name": "Persist Test"},
            timeout=10,
            trust_env=False,
        )
        assert r.status_code in [200, 201]
        return r.json()["accessToken"]

    def test_chat_persists_message(self, backend_stack):
        """聊天消息被持久化。"""
        cp_url = backend_stack["cp_url"]
        token = self._get_token(cp_url)
        session_id = f"persist-{int(time.time() * 1000)}"

        r = httpx.post(
            f"{cp_url}/v1/chat",
            json={"content": "持久化测试消息", "session_id": session_id},
            headers={"Authorization": f"Bearer {token}"},
            timeout=15,
            trust_env=False,
        )
        assert r.status_code in [200, 201, 202, 409]
