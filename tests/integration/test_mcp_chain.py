"""
MCP 工具调用链路测试：CP → Runtime。
前置条件：docker compose up -d（CP + Runtime 运行中）
运行方式：pytest tests/integration/test_mcp_chain.py -v -m integration
"""
import json
import os
import time

import httpx
import pytest

os.environ.pop("HTTP_PROXY", None)
os.environ.pop("HTTPS_PROXY", None)
os.environ.pop("http_proxy", None)
os.environ.pop("https_proxy", None)

CP_URL = os.environ.get("XIHE_CP_URL", "http://localhost:8080")
RUNTIME_URL = os.environ.get("XIHE_RUNTIME_URL", "http://localhost:8001")

MCP_HEADERS = {
    "Content-Type": "application/json",
    "Accept": "application/json, text/event-stream",
}


def _get_auth_headers() -> dict[str, str]:
    """注册并获取 JWT token。"""
    email = f"mcp-test-{int(time.time() * 1000)}@xihe.test"
    r = httpx.post(
        f"{CP_URL}/api/v1/auth/register",
        json={"email": email, "password": "Pass1234!", "name": "MCP Test"},
        timeout=10,
        trust_env=False,
    )
    assert r.status_code == 201, f"Register failed: {r.status_code} {r.text}"
    data = r.json()
    return {
        "Authorization": f"Bearer {data['accessToken']}",
        "X-Workspace-Id": data["workspaceId"],
    }


def _mcp_init(base_url: str, headers: dict) -> httpx.Response:
    """发送 MCP initialize 请求。"""
    return httpx.post(
        f"{base_url}/mcp",
        json={
            "jsonrpc": "2.0",
            "method": "initialize",
            "params": {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {"name": "integration-test", "version": "0.1.0"},
            },
            "id": 1,
        },
        headers=headers,
        timeout=10,
        trust_env=False,
    )


def _mcp_call(base_url: str, session_id: str, method: str, params: dict, req_id: int, headers: dict) -> httpx.Response:
    """发送 MCP 工具调用请求。"""
    call_headers = {**headers, "mcp-session-id": session_id}
    return httpx.post(
        f"{base_url}/mcp",
        json={"jsonrpc": "2.0", "method": method, "params": params, "id": req_id},
        headers=call_headers,
        timeout=10,
        trust_env=False,
    )


def _extract_mcp_result(response_text: str) -> dict:
    """从 MCP SSE 响应中提取 result。"""
    for line in response_text.split("\n"):
        if not line.startswith("data: "):
            continue
        try:
            data = json.loads(line[6:])
        except json.JSONDecodeError:
            continue
        if "result" in data:
            return data
    raise AssertionError("No result found in MCP response")


# ── CP MCP 代理测试 ──────────────────────────────────────────────────

@pytest.mark.integration
class TestCPMcpProxy:
    """CP 作为 MCP 反向代理转发请求到 Runtime。"""

    def test_cp_mcp_requires_auth(self):
        """CP MCP 端点未认证时返回 401。"""
        r = _mcp_init(f"{CP_URL}/api/v1", MCP_HEADERS)
        assert r.status_code == 401

    def test_cp_mcp_initialize_with_auth(self):
        """CP MCP 端点认证后可发送 initialize。"""
        headers = {**MCP_HEADERS, **_get_auth_headers()}
        r = _mcp_init(f"{CP_URL}/api/v1", headers)
        assert r.status_code == 200
        assert "mcp-session-id" in r.headers

    def test_cp_proxies_tools_list(self):
        """CP 转发 tools/list 返回 Runtime 工具列表。"""
        headers = {**MCP_HEADERS, **_get_auth_headers()}

        init_resp = _mcp_init(f"{CP_URL}/api/v1", headers)
        assert init_resp.status_code == 200
        session_id = init_resp.headers.get("mcp-session-id")

        tools_resp = _mcp_call(f"{CP_URL}/api/v1", session_id, "tools/list", {}, 2, headers)
        assert tools_resp.status_code == 200

        payload = _extract_mcp_result(tools_resp.text)
        tools = payload["result"].get("tools", [])
        assert len(tools) >= 3  # 至少 read_file, write_file, list_directory
        tool_names = [t["name"] for t in tools]
        assert "read_file" in tool_names

    def test_cp_proxies_tools_call(self):
        """CP 转发 tools/call 到 Runtime 并返回结果。"""
        headers = {**MCP_HEADERS, **_get_auth_headers()}

        init_resp = _mcp_init(f"{CP_URL}/api/v1", headers)
        session_id = init_resp.headers.get("mcp-session-id")

        call_resp = _mcp_call(
            f"{CP_URL}/api/v1", session_id, "tools/call",
            {"name": "list_directory", "arguments": {"path": "/tmp"}},
            3, headers
        )
        assert call_resp.status_code == 200

        payload = _extract_mcp_result(call_resp.text)
        assert "result" in payload
        content = payload["result"].get("content", [])
        assert len(content) > 0


# ── Runtime 直接测试 ────────────────────────────────────────────────

@pytest.mark.integration
class TestRuntimeDirect:
    """直接访问 Runtime MCP 端点（不经过 CP）。"""

    def test_runtime_health(self):
        """Runtime 健康检查。"""
        r = httpx.get(f"{RUNTIME_URL}/health", timeout=5)
        assert r.status_code == 200

    def test_runtime_mcp_initialize(self):
        """Runtime MCP initialize 返回 session ID。"""
        r = _mcp_init(RUNTIME_URL, MCP_HEADERS)
        assert r.status_code == 200
        assert "mcp-session-id" in r.headers

    def test_runtime_tools_list(self):
        """Runtime tools/list 返回工具列表。"""
        init_resp = _mcp_init(RUNTIME_URL, MCP_HEADERS)
        session_id = init_resp.headers.get("mcp-session-id")

        tools_resp = _mcp_call(RUNTIME_URL, session_id, "tools/list", {}, 2, MCP_HEADERS)
        assert tools_resp.status_code == 200

        payload = _extract_mcp_result(tools_resp.text)
        tools = payload["result"].get("tools", [])
        assert len(tools) >= 3
        tool_names = [t["name"] for t in tools]
        assert "read_file" in tool_names
        assert "list_directory" in tool_names

    def test_runtime_list_directory(self):
        """Runtime list_directory 返回 /tmp 内容。"""
        init_resp = _mcp_init(RUNTIME_URL, MCP_HEADERS)
        session_id = init_resp.headers.get("mcp-session-id")

        call_resp = _mcp_call(
            RUNTIME_URL, session_id, "tools/call",
            {"name": "list_directory", "arguments": {"path": "/tmp"}},
            3, MCP_HEADERS
        )
        assert call_resp.status_code == 200

        payload = _extract_mcp_result(call_resp.text)
        assert "result" in payload
