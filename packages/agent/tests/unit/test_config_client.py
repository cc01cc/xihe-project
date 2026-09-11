"""Tests for xihe_agent.config_client — effective config sync, cache, and resolution.

PLAN-0307 decisions #19 (layer encapsulation) / #37 (three layers server-side):
the client fetches per-domain *effective* values from
`GET /internal/v1/config/effective/{domain}` and never selects layers itself.
"""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from xihe_agent.config_client import (
    CONFIG_DOMAINS,
    ConfigClient,
)


def _effective(entries: dict, revision: str = "r1", source: str = "instance") -> dict:
    return {
        "domain": "llm-provider",
        "revision": revision,
        "source": source,
        "entries": entries,
    }


@pytest.fixture
def client():
    return ConfigClient(cp_url="http://test-cp:8080", api_token="test-token")


class TestConfigClientInit:
    def test_initial_state_empty(self, client):
        assert client._effective_cache == {}
        assert client._provider_cache == {}
        assert client._last_fetch == 0.0
        assert client.config_revision == ""
        assert client.last_sync_report["ok"] is False
        assert client.workspace_id is None

    def test_stores_constructor_args(self):
        c = ConfigClient(
            cp_url="http://test-cp:8080",
            api_token="test-token",
            workspace_id="ws-1",
        )
        assert c.cp_url == "http://test-cp:8080"
        assert c.api_token == "test-token"
        assert c.workspace_id == "ws-1"

    def test_domains_are_eight_layer_less(self):
        assert CONFIG_DOMAINS == (
            "llm-provider",
            "context-policy",
            "embedding",
            "logging",
            "agent-runtime",
            "agent-profile",
            "user-preference",
            "rag",
        )


class TestConfigClientGet:
    def test_get_effective_value(self, client):
        client._effective_cache["logging"] = {"logLevel": "debug"}
        assert client.get("logging", "logLevel") == "debug"

    def test_get_missing_domain_returns_none(self, client):
        assert client.get("nonexistent", "key") is None

    def test_get_missing_key_returns_none(self, client):
        client._effective_cache["logging"] = {"logLevel": "info"}
        assert client.get("logging", "missingKey") is None

    def test_get_empty_string_is_kept(self, client):
        client._effective_cache["llm-provider"] = {"openaiApiKey": ""}
        assert client.get("llm-provider", "openaiApiKey") == ""


class TestConfigClientGetBool:
    def test_get_bool_true_values(self, client):
        client._effective_cache["agent-runtime"] = {"useRegistry": "true"}
        assert client.get_bool("agent-runtime", "useRegistry") is True

    def test_get_bool_false_values(self, client):
        client._effective_cache["agent-runtime"] = {"useRegistry": "false"}
        assert client.get_bool("agent-runtime", "useRegistry") is False

    def test_get_bool_numeric_true(self, client):
        client._effective_cache["agent-runtime"] = {"flag": "1"}
        assert client.get_bool("agent-runtime", "flag") is True

    def test_get_bool_missing_returns_false(self, client):
        assert client.get_bool("agent-runtime", "nonexistent") is False


class TestConfigClientProviders:
    def test_get_providers_returns_empty_initially(self, client):
        assert client.get_providers() == {}

    def test_get_providers_after_rebuild(self, client):
        client._effective_cache["llm-provider"] = {
            "openaiApiKey": "sk-effective",
            "baseUrl": "https://api.openai.com/v1",
        }
        client._rebuild_provider_cache()

        providers = client.get_providers()
        assert "openai" in providers
        assert providers["openai"]["apiKey"] == "sk-effective"
        assert providers["openai"]["baseUrl"] == "https://api.openai.com/v1"

    def test_get_providers_empty_api_key_excluded(self, client):
        client._effective_cache["llm-provider"] = {
            "openaiApiKey": "",
            "deepseekApiKey": "",
        }
        client._rebuild_provider_cache()
        assert client.get_providers() == {}

    def test_get_provider_specific(self, client):
        client._effective_cache["llm-provider"] = {"openaiApiKey": "sk-test"}
        client._rebuild_provider_cache()

        provider = client.get_provider("openai")
        assert provider is not None
        assert provider["apiKey"] == "sk-test"
        assert client.get_provider("nonexistent") is None

    def test_xiaomi_provider_uses_its_default_base_url(self, client):
        client._effective_cache["llm-provider"] = {
            "xiaomiApiKey": "sk-mimo-test",
            "xiaomiModel": "mimo-v2.5",
        }
        client._rebuild_provider_cache()

        assert client.get_provider("xiaomi") == {
            "provider": "xiaomi",
            "apiKey": "sk-mimo-test",
            "baseUrl": "https://api.xiaomimimo.com/v1",
            "model": "mimo-v2.5",
        }


def _mock_response(status_code=200, json_data=None):
    """Create a sync Mock that mimics httpx.Response for testing."""
    resp = MagicMock(spec=[])
    resp.status_code = status_code
    resp.json = MagicMock(return_value=json_data or {})
    return resp


class TestConfigClientSync:
    @patch("httpx.AsyncClient")
    async def test_sync_populates_effective_cache(self, mock_httpx):
        mock_client = AsyncMock()
        mock_httpx.return_value.__aenter__.return_value = mock_client

        async def mock_get(url, **kwargs):
            if url.endswith("/effective/logging"):
                return _mock_response(200, _effective({"logLevel": "debug"}))
            if url.endswith("/effective/llm-provider"):
                return _mock_response(200, _effective({"openaiApiKey": "sk-test"}))
            return _mock_response(404)

        mock_client.get = mock_get

        c = ConfigClient("http://cp:8080", "token")
        report = await c.sync()

        assert c._effective_cache.get("logging") == {"logLevel": "debug"}
        assert c._effective_cache.get("llm-provider") == {"openaiApiKey": "sk-test"}
        assert c._last_fetch > 0
        assert report["ok"] is True
        assert report["domains"]["llm-provider"]["status"] == "ok"
        # CP-supplied revision is used when present.
        assert report["revision"] == c.config_revision
        assert c.config_revision != ""

    @patch("httpx.AsyncClient")
    async def test_sync_passes_workspace_id(self, mock_httpx):
        mock_client = AsyncMock()
        mock_httpx.return_value.__aenter__.return_value = mock_client
        seen_params: list[dict] = []

        async def mock_get(url, **kwargs):
            seen_params.append(kwargs.get("params") or {})
            if url.endswith("/effective/llm-provider"):
                return _mock_response(200, _effective({"openaiApiKey": "sk-test"}))
            return _mock_response(404)

        mock_client.get = mock_get

        c = ConfigClient("http://cp:8080", "token", workspace_id="ws-42")
        await c.sync()

        assert seen_params and all(p.get("workspaceId") == "ws-42" for p in seen_params)

    @patch("httpx.AsyncClient")
    async def test_sync_records_source(self, mock_httpx):
        mock_client = AsyncMock()
        mock_httpx.return_value.__aenter__.return_value = mock_client

        async def mock_get(url, **kwargs):
            if url.endswith("/effective/llm-provider"):
                return _mock_response(
                    200, _effective({"openaiApiKey": "sk-test"}, source="workspace")
                )
            return _mock_response(404)

        mock_client.get = mock_get

        c = ConfigClient("http://cp:8080", "token")
        report = await c.sync()

        assert report["domains"]["llm-provider"]["source"] == "workspace"

    @patch("httpx.AsyncClient")
    async def test_sync_handles_non_200_gracefully(self, mock_httpx):
        mock_client = AsyncMock()
        mock_httpx.return_value.__aenter__.return_value = mock_client

        async def mock_get(url, **kwargs):
            return _mock_response(500)

        mock_client.get = mock_get

        c = ConfigClient("http://cp:8080", "token")
        report = await c.sync()

        assert c._effective_cache == {}
        assert report["ok"] is False
        assert report["domains"]["llm-provider"]["status"] == "unreachable"

    @patch("httpx.AsyncClient")
    async def test_sync_handles_connection_error(self, mock_httpx):
        mock_client = AsyncMock()
        mock_httpx.return_value.__aenter__.return_value = mock_client

        async def mock_get(url, **kwargs):
            raise ConnectionError("connection refused")

        mock_client.get = mock_get

        c = ConfigClient("http://cp:8080", "token")
        report = await c.sync()

        assert c._effective_cache == {}
        assert report["ok"] is False
        assert report["domains"]["llm-provider"]["status"] == "unreachable"

    @patch("httpx.AsyncClient")
    async def test_sync_rejects_non_object_entries(self, mock_httpx):
        mock_client = AsyncMock()
        mock_httpx.return_value.__aenter__.return_value = mock_client

        async def mock_get(url, **kwargs):
            if url.endswith("/effective/llm-provider"):
                return _mock_response(200, {"entries": ["not", "a", "map"]})
            return _mock_response(404)

        mock_client.get = mock_get

        c = ConfigClient("http://cp:8080", "token")
        report = await c.sync()

        assert report["ok"] is False
        assert report["domains"]["llm-provider"]["status"] == "invalid_response"

    @patch("httpx.AsyncClient")
    async def test_sync_failure_keeps_previous_snapshot(self, mock_httpx):
        mock_client = AsyncMock()
        mock_httpx.return_value.__aenter__.return_value = mock_client

        async def successful_get(url, **kwargs):
            if url.endswith("/effective/llm-provider"):
                return _mock_response(200, _effective({"openaiApiKey": "sk-first"}))
            return _mock_response(404)

        mock_client.get = successful_get
        c = ConfigClient("http://cp:8080", "token")
        await c.sync()
        previous_revision = c.config_revision

        async def failed_get(url, **kwargs):
            if url.endswith("/effective/llm-provider"):
                return _mock_response(500)
            return _mock_response(404)

        mock_client.get = failed_get
        report = await c.sync()

        assert report["ok"] is False
        assert c.get_provider("openai")["apiKey"] == "sk-first"
        assert c.config_revision == previous_revision


class TestConfigClientSyncWithRetry:
    @patch("httpx.AsyncClient")
    async def test_retry_succeeds_on_first_try(self, mock_httpx):
        mock_client = AsyncMock()
        mock_httpx.return_value.__aenter__.return_value = mock_client

        async def mock_get(url, **kwargs):
            return _mock_response(200, _effective({"logLevel": "info"}))

        mock_client.get = mock_get

        c = ConfigClient("http://cp:8080", "token")
        await c.sync_with_retry(max_retries=3)

        assert c._effective_cache.get("logging") is not None

    @patch("httpx.AsyncClient")
    async def test_retry_succeeds_after_failure(self, mock_httpx):
        mock_client = AsyncMock()
        mock_httpx.return_value.__aenter__.return_value = mock_client

        call_count = 0

        async def mock_get(url, **kwargs):
            nonlocal call_count
            call_count += 1
            if call_count == 1:
                raise ConnectionError("first failure")
            return _mock_response(200, _effective({"logLevel": "info"}))

        mock_client.get = mock_get

        c = ConfigClient("http://cp:8080", "token")
        await c.sync_with_retry(max_retries=3)

        assert call_count > 1
        assert c._effective_cache.get("logging") is not None
