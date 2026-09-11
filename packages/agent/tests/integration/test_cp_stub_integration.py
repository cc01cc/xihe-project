"""
T2 stub integration test for Agent ↔ CP ConfigClient (effective contract).

PLAN-0307 decision #19: the Agent fetches layer-less effective values from
`GET /internal/v1/config/effective/{domain}`; CP performs the
`env > workspace > user > instance > default` merge server-side.

Uses pytest-httpx to intercept outbound httpx requests. No Docker required.
"""

import re

import httpx
import pytest

from xihe_agent.config_client import ConfigClient


def _effective(entries: dict, revision: str = "rev-1", source: str = "instance") -> dict:
    return {"revision": revision, "source": source, "entries": entries}


@pytest.mark.integration
class TestConfigClientStubIntegration:
    """Tests ConfigClient.sync() with stubbed CP effective responses."""

    async def test_sync_populates_effective_domain(self, httpx_mock):
        async def handler(request: httpx.Request) -> httpx.Response:
            if re.search(r"/effective/llm-provider", str(request.url)):
                return httpx.Response(
                    200,
                    json=_effective({
                        "defaultProvider": "openai",
                        "baseUrl": "https://api.openai.com/v1",
                    }),
                )
            return httpx.Response(404)

        httpx_mock.add_callback(handler, is_reusable=True)

        client = ConfigClient(cp_url="http://cp:12631", api_token="test-token")
        await client.sync()

        assert client.get("llm-provider", "defaultProvider") == "openai"
        assert client.get("llm-provider", "baseUrl") == "https://api.openai.com/v1"

    async def test_sync_uses_effective_entries_without_layers(self, httpx_mock):
        async def handler(request: httpx.Request) -> httpx.Response:
            if re.search(r"/effective/llm-provider", str(request.url)):
                return httpx.Response(
                    200,
                    json=_effective(
                        {"defaultProvider": "openai", "baseUrl": ""},
                        source="workspace",
                    ),
                )
            return httpx.Response(404)

        httpx_mock.add_callback(handler, is_reusable=True)

        client = ConfigClient(cp_url="http://cp:12631", api_token="test-token")
        report = await client.sync()

        assert client.get("llm-provider", "defaultProvider") == "openai"
        assert report["domains"]["llm-provider"]["source"] == "workspace"
        assert report["domains"]["llm-provider"]["revision"] == "rev-1"

    async def test_workspace_id_param_forwarded(self, httpx_mock):
        async def handler(request: httpx.Request) -> httpx.Response:
            if re.search(r"/effective/llm-provider", str(request.url)):
                return httpx.Response(200, json=_effective({"openaiApiKey": "sk-ws"}))
            return httpx.Response(404)

        httpx_mock.add_callback(handler, is_reusable=True)

        client = ConfigClient(
            cp_url="http://cp:12631",
            api_token="test-token",
            workspace_id="ws-77",
        )
        await client.sync()

        reqs = [
            r for r in httpx_mock.get_requests()
            if re.search(r"/effective/llm-provider", str(r.url))
        ]
        assert reqs and reqs[0].url.params.get("workspaceId") == "ws-77"

    async def test_sync_handles_500_gracefully(self, httpx_mock):
        async def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(500)

        httpx_mock.add_callback(handler, is_reusable=True)

        client = ConfigClient(cp_url="http://cp:12631", api_token="test-token")
        await client.sync()

        assert client._effective_cache == {}
        assert client.get_domain("llm-provider") == {}

    async def test_sync_handles_connection_error(self, httpx_mock):
        async def handler(request: httpx.Request) -> httpx.Response:
            raise httpx.ConnectError("connection refused")

        httpx_mock.add_callback(handler, is_reusable=True)

        client = ConfigClient(cp_url="http://cp:12631", api_token="test-token")
        await client.sync()

        assert client._effective_cache == {}

    async def test_auth_header_forwarded(self, httpx_mock):
        async def handler(request: httpx.Request) -> httpx.Response:
            if re.search(r"/effective/llm-provider", str(request.url)):
                return httpx.Response(200, json=_effective({"openaiApiKey": "sk-test"}))
            return httpx.Response(404)

        httpx_mock.add_callback(handler, is_reusable=True)

        client = ConfigClient(cp_url="http://cp:12631", api_token="my-secret-token")
        await client.sync()

        requests = httpx_mock.get_requests()
        llm_reqs = [
            r for r in requests if re.search(r"/effective/llm-provider", str(r.url))
        ]
        assert len(llm_reqs) >= 1
        assert llm_reqs[0].headers.get("Authorization") == "Bearer my-secret-token"

    async def test_sync_populates_multiple_domains(self, httpx_mock):
        async def handler(request: httpx.Request) -> httpx.Response:
            if re.search(r"/effective/logging", str(request.url)):
                return httpx.Response(200, json=_effective({"logLevel": "debug"}))
            if re.search(r"/effective/llm-provider", str(request.url)):
                return httpx.Response(200, json=_effective({"openaiApiKey": "sk-test"}))
            return httpx.Response(404)

        httpx_mock.add_callback(handler, is_reusable=True)

        client = ConfigClient(cp_url="http://cp:12631", api_token="test-token")
        await client.sync()

        assert client._effective_cache.get("logging") == {"logLevel": "debug"}
        assert client._effective_cache.get("llm-provider") == {"openaiApiKey": "sk-test"}
        assert client._last_fetch > 0
