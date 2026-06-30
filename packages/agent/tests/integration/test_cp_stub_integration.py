"""
T2 stub integration test for Agent ↔ CP ConfigClient.
Uses pytest-httpx to intercept outbound httpx requests.
No Docker required — CP responses are stubbed.
"""

import re

import httpx
import pytest

from xihe_agent.config_client import ConfigClient


@pytest.mark.integration
class TestConfigClientStubIntegration:
    """Tests ConfigClient.sync() with stubbed CP responses via pytest-httpx."""

    async def test_sync_populates_providers(self, httpx_mock):
        async def handler(request: httpx.Request) -> httpx.Response:
            if re.search(r"/admin/llm-provider", str(request.url)):
                return httpx.Response(
                    200,
                    json={
                        "openaiApiKey": "sk-admin-openai",
                        "baseUrl": "https://api.openai.com/v1",
                    },
                )
            return httpx.Response(404)

        httpx_mock.add_callback(handler, is_reusable=True)

        client = ConfigClient(cp_url="http://cp:12631", api_token="test-token")
        await client.sync()

        providers = client.get_providers()
        assert "openai" in providers
        assert providers["openai"]["apiKey"] == "sk-admin-openai"
        assert providers["openai"]["baseUrl"] == "https://api.openai.com/v1"

    async def test_sync_admin_overrides_system(self, httpx_mock):
        async def handler(request: httpx.Request) -> httpx.Response:
            if re.search(r"/admin/llm-provider", str(request.url)):
                return httpx.Response(200, json={"openaiApiKey": "sk-admin", "baseUrl": ""})
            if re.search(r"/system/llm-provider", str(request.url)):
                return httpx.Response(200, json={"openaiApiKey": "sk-system"})
            return httpx.Response(404)

        httpx_mock.add_callback(handler, is_reusable=True)

        client = ConfigClient(cp_url="http://cp:12631", api_token="test-token")
        await client.sync()

        assert client.get_provider("openai")["apiKey"] == "sk-admin"

    async def test_sync_system_fallback_when_admin_missing(self, httpx_mock):
        async def handler(request: httpx.Request) -> httpx.Response:
            if re.search(r"/system/llm-provider", str(request.url)):
                return httpx.Response(200, json={"openaiApiKey": "sk-system-only", "baseUrl": ""})
            return httpx.Response(404)

        httpx_mock.add_callback(handler, is_reusable=True)

        client = ConfigClient(cp_url="http://cp:12631", api_token="test-token")
        await client.sync()

        assert client.get_provider("openai") is not None
        assert client.get_provider("openai")["apiKey"] == "sk-system-only"

    async def test_sync_handles_500_gracefully(self, httpx_mock):
        async def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(500)

        httpx_mock.add_callback(handler, is_reusable=True)

        client = ConfigClient(cp_url="http://cp:12631", api_token="test-token")
        await client.sync()

        assert client._admin_cache == {}
        assert client._system_cache == {}
        assert client.get_providers() == {}

    async def test_sync_handles_connection_error(self, httpx_mock):
        async def handler(request: httpx.Request) -> httpx.Response:
            raise httpx.ConnectError("connection refused")

        httpx_mock.add_callback(handler, is_reusable=True)

        client = ConfigClient(cp_url="http://cp:12631", api_token="test-token")
        await client.sync()

        assert client._admin_cache == {}
        assert client._system_cache == {}

    async def test_auth_header_forwarded(self, httpx_mock):
        async def handler(request: httpx.Request) -> httpx.Response:
            if re.search(r"/admin/llm-provider", str(request.url)):
                return httpx.Response(200, json={"openaiApiKey": "sk-test"})
            return httpx.Response(404)

        httpx_mock.add_callback(handler, is_reusable=True)

        client = ConfigClient(cp_url="http://cp:12631", api_token="my-secret-token")
        await client.sync()

        requests = httpx_mock.get_requests()
        admin_reqs = [r for r in requests if re.search(r"/admin/llm-provider", str(r.url))]
        assert len(admin_reqs) >= 1
        assert admin_reqs[0].headers.get("X-Api-Token") == "my-secret-token"

    async def test_sync_populates_multiple_domains(self, httpx_mock):
        async def handler(request: httpx.Request) -> httpx.Response:
            if re.search(r"/admin/logging", str(request.url)):
                return httpx.Response(200, json={"logLevel": "debug"})
            if re.search(r"/admin/llm-provider", str(request.url)):
                return httpx.Response(200, json={"openaiApiKey": "sk-test"})
            if re.search(r"/system/infrastructure", str(request.url)):
                return httpx.Response(200, json={"dbUrl": "jdbc:test"})
            return httpx.Response(404)

        httpx_mock.add_callback(handler, is_reusable=True)

        client = ConfigClient(cp_url="http://cp:12631", api_token="test-token")
        await client.sync()

        assert client._admin_cache.get("logging") == {"logLevel": "debug"}
        assert client._admin_cache.get("llm-provider") == {"openaiApiKey": "sk-test"}
        assert client._system_cache.get("infrastructure") == {"dbUrl": "jdbc:test"}
        assert client._last_fetch > 0
