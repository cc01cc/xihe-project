"""Tests for xihe_agent.config_client — ConfigClient sync, cache, and resolution."""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from xihe_agent.config_client import ConfigClient


@pytest.fixture
def client():
    return ConfigClient(cp_url="http://test-cp:8080", api_token="test-token")


class TestConfigClientInit:
    def test_initial_state_empty(self, client):
        assert client._admin_cache == {}
        assert client._system_cache == {}
        assert client._provider_cache == {}
        assert client._last_fetch == 0.0
        assert client.config_revision == ""
        assert client.last_sync_report["ok"] is False

    def test_stores_constructor_args(self, client):
        assert client.cp_url == "http://test-cp:8080"
        assert client.api_token == "test-token"


class TestConfigClientGet:
    def test_get_admin_precedence(self, client):
        client._admin_cache["logging"] = {"logLevel": "debug"}
        client._system_cache["logging"] = {"logLevel": "info"}
        assert client.get("logging", "logLevel") == "debug"

    def test_get_fallback_to_system(self, client):
        client._system_cache["logging"] = {"logLevel": "info"}
        assert client.get("logging", "logLevel") == "info"

    def test_get_missing_domain_returns_none(self, client):
        assert client.get("nonexistent", "key") is None

    def test_get_missing_key_returns_none(self, client):
        client._admin_cache["logging"] = {"logLevel": "info"}
        assert client.get("logging", "missingKey") is None

    def test_get_admin_null_not_fallback_to_system(self, client):
        client._admin_cache["llm-provider"] = {"openaiApiKey": ""}
        client._system_cache["llm-provider"] = {"openaiApiKey": "sk-system"}
        assert client.get("llm-provider", "openaiApiKey") == ""


class TestConfigClientGetBool:
    def test_get_bool_true_values(self, client):
        client._admin_cache["logging"] = {"useRegistry": "true"}
        assert client.get_bool("logging", "useRegistry") is True

    def test_get_bool_false_values(self, client):
        client._admin_cache["logging"] = {"useRegistry": "false"}
        assert client.get_bool("logging", "useRegistry") is False

    def test_get_bool_numeric_true(self, client):
        client._admin_cache["logging"] = {"flag": "1"}
        assert client.get_bool("logging", "flag") is True

    def test_get_bool_missing_returns_false(self, client):
        assert client.get_bool("logging", "nonexistent") is False


class TestConfigClientProviders:
    def test_get_providers_returns_empty_initially(self, client):
        assert client.get_providers() == {}

    def test_get_providers_after_rebuild(self, client):
        client._admin_cache["llm-provider"] = {
            "openaiApiKey": "sk-admin",
            "baseUrl": "https://api.openai.com/v1",
        }
        client._system_cache["llm-provider"] = {
            "deepseekApiKey": "sk-system",
        }
        client._rebuild_provider_cache()

        providers = client.get_providers()
        assert "openai" in providers
        assert providers["openai"]["apiKey"] == "sk-admin"
        assert providers["openai"]["baseUrl"] == "https://api.openai.com/v1"

    def test_get_providers_admin_overrides_system(self, client):
        client._admin_cache["llm-provider"] = {
            "deepseekApiKey": "sk-admin-ds",
            "openaiApiKey": "",
        }
        client._system_cache["llm-provider"] = {
            "deepseekApiKey": "sk-system-ds",
            "openaiApiKey": "",
        }
        client._rebuild_provider_cache()

        providers = client.get_providers()
        assert providers["deepseek"]["apiKey"] == "sk-admin-ds"

    def test_get_providers_empty_api_key_excluded(self, client):
        client._admin_cache["llm-provider"] = {
            "openaiApiKey": "",
            "deepseekApiKey": "",
        }
        client._system_cache["llm-provider"] = {
            "openaiApiKey": "",
            "deepseekApiKey": "",
        }
        client._rebuild_provider_cache()
        assert client.get_providers() == {}

    def test_get_provider_specific(self, client):
        client._admin_cache["llm-provider"] = {"openaiApiKey": "sk-test"}
        client._rebuild_provider_cache()

        provider = client.get_provider("openai")
        assert provider is not None
        assert provider["apiKey"] == "sk-test"
        assert client.get_provider("nonexistent") is None

    def test_xiaomi_provider_uses_its_default_base_url(self, client):
        client._admin_cache["llm-provider"] = {
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
    async def test_sync_populates_caches(self, mock_httpx):
        mock_client = AsyncMock()
        mock_httpx.return_value.__aenter__.return_value = mock_client

        async def mock_get(url, **kwargs):
            if "/admin/logging" in url:
                return _mock_response(200, {"logLevel": "debug"})
            elif "/admin/llm-provider" in url:
                return _mock_response(200, {"openaiApiKey": "sk-test"})
            elif "/system/infrastructure" in url:
                return _mock_response(200, {"dbUrl": "jdbc:test"})
            return _mock_response(404)

        mock_client.get = mock_get

        c = ConfigClient("http://cp:8080", "token")
        report = await c.sync()

        assert c._admin_cache.get("logging") == {"logLevel": "debug"}
        assert c._admin_cache.get("llm-provider") == {"openaiApiKey": "sk-test"}
        assert c._system_cache.get("infrastructure") == {"dbUrl": "jdbc:test"}
        assert c._last_fetch > 0
        assert report["ok"] is True
        assert report["domains"]["llm-provider"]["effective"] == "ok"
        assert report["revision"] == c.config_revision

    @patch("httpx.AsyncClient")
    async def test_sync_handles_non_200_gracefully(self, mock_httpx):
        mock_client = AsyncMock()
        mock_httpx.return_value.__aenter__.return_value = mock_client

        async def mock_get(url, **kwargs):
            return _mock_response(500)

        mock_client.get = mock_get

        c = ConfigClient("http://cp:8080", "token")
        report = await c.sync()

        assert c._admin_cache == {}
        assert c._system_cache == {}
        assert report["ok"] is False
        assert report["domains"]["llm-provider"]["effective"] == "unreachable"

    @patch("httpx.AsyncClient")
    async def test_sync_handles_connection_error(self, mock_httpx):
        mock_client = AsyncMock()
        mock_httpx.return_value.__aenter__.return_value = mock_client

        async def mock_get(url, **kwargs):
            raise ConnectionError("connection refused")

        mock_client.get = mock_get

        c = ConfigClient("http://cp:8080", "token")
        report = await c.sync()

        assert c._admin_cache == {}
        assert c._system_cache == {}
        assert report["ok"] is False
        assert report["domains"]["llm-provider"]["effective"] == "unreachable"

    @patch("httpx.AsyncClient")
    async def test_sync_failure_keeps_previous_snapshot(self, mock_httpx):
        mock_client = AsyncMock()
        mock_httpx.return_value.__aenter__.return_value = mock_client

        async def successful_get(url, **kwargs):
            if "/admin/llm-provider" in url:
                return _mock_response(200, {"openaiApiKey": "sk-first"})
            return _mock_response(404)

        mock_client.get = successful_get
        c = ConfigClient("http://cp:8080", "token")
        await c.sync()
        previous_revision = c.config_revision

        async def failed_get(url, **kwargs):
            if "/admin/llm-provider" in url:
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
            return _mock_response(200, {"logLevel": "info"})

        mock_client.get = mock_get

        c = ConfigClient("http://cp:8080", "token")
        await c.sync_with_retry(max_retries=3)

        assert c._admin_cache.get("logging") is not None

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
            return _mock_response(200, {"logLevel": "info"})

        mock_client.get = mock_get

        c = ConfigClient("http://cp:8080", "token")
        await c.sync_with_retry(max_retries=3)

        assert call_count > 1
        assert c._admin_cache.get("logging") is not None
