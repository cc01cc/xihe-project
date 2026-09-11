"""Tests for llm/models.py - routing + httpx logic."""
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from xihe_agent.llm.base import ENV_PROVIDER_KEY_MAP


def _clear_provider_env(monkeypatch: pytest.MonkeyPatch) -> None:
    for env_name in ENV_PROVIDER_KEY_MAP.values():
        monkeypatch.delenv(env_name, raising=False)


@pytest.fixture
def patch_config_client():
    """Mock the _models_router.config_client to return test providers.
    get_domain() is sync, so use MagicMock (not AsyncMock)."""
    with patch("xihe_agent.llm.models._models_router") as mock_router:
        mock_router.config_client = MagicMock()
        mock_router.config_client.get_domain.return_value = {}
        yield mock_router


@pytest.mark.asyncio
async def test_list_models_no_config_returns_empty(patch_config_client):
    from xihe_agent.llm.models import list_models

    patch_config_client.config_client = None
    result = await list_models()
    assert result == {"models": {}, "providers": {}, "configRevision": ""}


@pytest.mark.asyncio
async def test_list_models_httpx_failure_returns_empty(patch_config_client, monkeypatch):
    from xihe_agent.llm.models import list_models

    _clear_provider_env(monkeypatch)
    monkeypatch.setenv("XIHE_OPENAI_API_KEY", "sk-test")
    patch_config_client.config_client.get_domain.return_value = {
        "baseUrl": "https://api.openai.com",
    }
    with patch("xihe_agent.llm.models.httpx.AsyncClient") as mock_client_cls:
        mock_client = AsyncMock()
        mock_client_cls.return_value.__aenter__.return_value = mock_client
        mock_client.get.side_effect = Exception("Network error")

        result = await list_models()
    assert result["models"]["openai"] == []


@pytest.mark.asyncio
async def test_list_models_empty_providers(patch_config_client, monkeypatch):
    from xihe_agent.llm.models import list_models

    _clear_provider_env(monkeypatch)
    patch_config_client.config_client.get_domain.return_value = {}
    patch_config_client.config_client.config_revision = ""
    result = await list_models()
    assert result == {"models": {}, "providers": {}, "configRevision": ""}


@pytest.mark.asyncio
async def test_list_models_success_includes_chat_capability(patch_config_client, monkeypatch):
    from xihe_agent.llm.models import list_models

    _clear_provider_env(monkeypatch)
    monkeypatch.setenv("XIHE_XIAOMI_API_KEY", "test-key")
    patch_config_client.config_client.config_revision = "rev-1"
    patch_config_client.config_client.get_domain.return_value = {
        "xiaomiApiBase": "https://provider.test/v1",
    }
    response = MagicMock(status_code=200)
    response.json.return_value = {
        "data": [{"id": "mimo-v2.5"}, {"id": "mimo-v2.5-asr"}],
    }
    with patch("xihe_agent.llm.models.httpx.AsyncClient") as mock_client_cls:
        mock_client = AsyncMock()
        mock_client_cls.return_value.__aenter__.return_value = mock_client
        mock_client.get.return_value = response

        result = await list_models()

    assert result["models"]["xiaomi"] == ["mimo-v2.5", "mimo-v2.5-asr"]
    models = result["providers"]["xiaomi"]["models"]
    assert models[0]["capabilities"]["chat"] is True
    assert models[1]["capabilities"]["chat"] is False
    assert result["providers"]["xiaomi"]["status"] == "ready"


@pytest.mark.asyncio
async def test_list_models_auth_failure_has_actionable_status(patch_config_client, monkeypatch):
    from xihe_agent.llm.models import list_models

    _clear_provider_env(monkeypatch)
    monkeypatch.setenv("XIHE_OPENAI_API_KEY", "invalid-key")
    patch_config_client.config_client.config_revision = "rev-2"
    patch_config_client.config_client.get_domain.return_value = {
        "openaiApiBase": "https://provider.test/v1",
    }
    response = MagicMock(status_code=401)
    with patch("xihe_agent.llm.models.httpx.AsyncClient") as mock_client_cls:
        mock_client = AsyncMock()
        mock_client_cls.return_value.__aenter__.return_value = mock_client
        mock_client.get.return_value = response

        result = await list_models()

    assert result["providers"]["openai"]["status"] == "invalid_credentials"
    assert result["providers"]["openai"]["reasonCode"] == "LLM_CREDENTIALS_INVALID"


@pytest.mark.asyncio
async def test_scoped_catalog_redeems_lease_and_fetches_models():
    from xihe_agent.llm.models import fetch_connection_catalog

    config_client = MagicMock()
    config_client.config_revision = "connection-rev"
    config_client.redeem_provider_lease = AsyncMock(return_value={
        "provider": "deepseek",
        "routeProvider": "deepseek",
        "model": "*",
        "baseUrl": "https://provider.test/v1",
        "apiKey": "sk-scoped",
        "connectionRevision": 4,
        "modelDiscovery": "remote-models",
        "manualModels": [],
    })
    response = MagicMock(status_code=200)
    response.json.return_value = {"data": [{"id": "deepseek-chat"}]}

    with patch("xihe_agent.llm.models.httpx.AsyncClient") as mock_client_cls:
        mock_client = AsyncMock()
        mock_client_cls.return_value.__aenter__.return_value = mock_client
        mock_client.get.return_value = response

        result = await fetch_connection_catalog(config_client, [{
            "lease": "pl-test",
            "runId": "catalog-run",
            "connectionId": "conn-1",
            "providerId": "deepseek",
            "scope": "USER",
            "displayName": "DeepSeek",
            "connectionRevision": 4,
        }])

    config_client.redeem_provider_lease.assert_awaited_once()
    assert result["models"]["deepseek"] == ["deepseek-chat"]
    assert result["providers"]["deepseek"]["connectionId"] == "conn-1"
    assert result["providers"]["deepseek"]["status"] == "ready"
