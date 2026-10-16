"""Tests for llm/models.py - routing + httpx logic."""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from xihe_agent.llm.base import ENV_PROVIDER_KEY_MAP


def _clear_provider_env(monkeypatch: pytest.MonkeyPatch) -> None:
    for env_name in ENV_PROVIDER_KEY_MAP.values():
        monkeypatch.delenv(env_name, raising=False)
    # PLAN-0504 decision #9: the fallback registry endpoint is env-only.
    monkeypatch.delenv("XIHE_API_BASE", raising=False)


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
    config_client.redeem_provider_lease = AsyncMock(
        return_value={
            "provider": "deepseek",
            "routeProvider": "deepseek",
            "model": "*",
            "baseUrl": "https://provider.test/v1",
            "apiKey": "sk-scoped",
            "connectionRevision": 4,
            "modelDiscovery": "remote-models",
            "manualModels": [],
            "connectionKey": "default",
            "apiTypeId": "openai-chat-completions",
            "apiTypeVersion": 1,
            "operation": "chat",
        }
    )
    response = MagicMock(status_code=200)
    response.json.return_value = {"data": [{"id": "deepseek-chat"}]}

    with patch("xihe_agent.llm.models.httpx.AsyncClient") as mock_client_cls:
        mock_client = AsyncMock()
        mock_client_cls.return_value.__aenter__.return_value = mock_client
        mock_client.get.return_value = response

        result = await fetch_connection_catalog(
            config_client,
            [
                {
                    "lease": "pl-test",
                    "runId": "catalog-run",
                    "connectionId": "conn-1",
                    "connectionKey": "default",
                    "providerId": "deepseek",
                    "apiTypeId": "openai-chat-completions",
                    "apiTypeVersion": 1,
                    "operation": "chat",
                    "scope": "USER",
                    "displayName": "DeepSeek",
                    "connectionRevision": 4,
                }
            ],
        )

    config_client.redeem_provider_lease.assert_awaited_once()
    assert result["models"]["conn-1"] == ["deepseek-chat"]
    assert result["providers"]["conn-1"]["connectionId"] == "conn-1"
    assert result["providers"]["conn-1"]["connectionKey"] == "default"
    assert result["providers"]["conn-1"]["providerId"] == "deepseek"
    assert result["providers"]["conn-1"]["apiTypeId"] == "openai-chat-completions"
    assert result["providers"]["conn-1"]["apiTypeVersion"] == 1
    assert result["providers"]["conn-1"]["operation"] == "chat"
    assert result["providers"]["conn-1"]["status"] == "ready"


@pytest.mark.asyncio
async def test_scoped_catalog_preserves_same_provider_different_connections():
    from xihe_agent.llm.models import fetch_connection_catalog

    config_client = MagicMock()
    config_client.config_revision = "connection-rev"
    config_client.redeem_provider_lease = AsyncMock(
        side_effect=[
            {
                "provider": "deepseek",
                "routeProvider": "deepseek",
                "model": "*",
                "baseUrl": None,
                "apiKey": "sk-scoped",
                "connectionRevision": 4,
                "modelDiscovery": "manual",
                "manualModels": ["deepseek-chat"],
                "connectionKey": "default",
                "apiTypeId": "openai-chat-completions",
                "apiTypeVersion": 1,
                "operation": "chat",
            },
            {
                "provider": "deepseek",
                "routeProvider": "deepseek",
                "model": "*",
                "baseUrl": None,
                "apiKey": "sk-scoped-2",
                "connectionRevision": 9,
                "modelDiscovery": "manual",
                "manualModels": ["deepseek-reasoner"],
                "connectionKey": "secondary",
                "apiTypeId": "openai-chat-completions",
                "apiTypeVersion": 1,
                "operation": "chat",
            },
        ]
    )

    result = await fetch_connection_catalog(
        config_client,
        [
            {
                "lease": "pl-1",
                "runId": "catalog-run",
                "connectionId": "conn-1",
                "connectionKey": "default",
                "providerId": "deepseek",
                "apiTypeId": "openai-chat-completions",
                "apiTypeVersion": 1,
                "operation": "chat",
                "scope": "USER",
                "displayName": "DeepSeek",
                "connectionRevision": 4,
            },
            {
                "lease": "pl-2",
                "runId": "catalog-run",
                "connectionId": "conn-2",
                "connectionKey": "secondary",
                "providerId": "deepseek",
                "apiTypeId": "openai-chat-completions",
                "apiTypeVersion": 1,
                "operation": "chat",
                "scope": "WORKSPACE",
                "displayName": "DeepSeek Secondary",
                "connectionRevision": 9,
            },
        ],
    )

    assert config_client.redeem_provider_lease.await_count == 2
    assert result["models"]["conn-1"] == ["deepseek-chat"]
    assert result["models"]["conn-2"] == ["deepseek-reasoner"]
    assert result["providers"]["conn-1"]["connectionKey"] == "default"
    assert result["providers"]["conn-2"]["connectionKey"] == "secondary"
    assert result["providers"]["conn-2"]["scope"] == "WORKSPACE"


def _run_scoped_catalog(model_ids, monkeypatch, model_discovery="remote-models", manual_models=None):
    """Run fetch_connection_catalog for one connection (callers patch litellm)."""
    from xihe_agent.llm.models import fetch_connection_catalog

    config_client = MagicMock()
    config_client.config_revision = "connection-rev"
    grant = {
        "provider": "test",
        "routeProvider": "test",
        "model": "*",
        "baseUrl": "https://provider.test/v1",
        "apiKey": "sk-scoped",
        "connectionRevision": 4,
        "modelDiscovery": model_discovery,
        "manualModels": manual_models if manual_models is not None else [],
        "connectionKey": "default",
        "apiTypeId": "openai-chat-completions",
        "apiTypeVersion": 1,
        "operation": "chat",
    }
    config_client.redeem_provider_lease = AsyncMock(return_value=grant)
    response = MagicMock(status_code=200)
    response.json.return_value = {"data": [{"id": m} for m in model_ids]}

    async def _run():
        with patch("xihe_agent.llm.models.httpx.AsyncClient") as mock_client_cls:
            mock_client = AsyncMock()
            mock_client_cls.return_value.__aenter__.return_value = mock_client
            mock_client.get.return_value = response
            return await fetch_connection_catalog(
                config_client,
                [
                    {
                        "lease": "pl-test",
                        "runId": "catalog-run",
                        "connectionId": "conn-1",
                        "connectionKey": "default",
                        "providerId": "test",
                        "apiTypeId": "openai-chat-completions",
                        "apiTypeVersion": 1,
                        "operation": "chat",
                        "scope": "USER",
                        "displayName": "Test",
                        "connectionRevision": 4,
                    }
                ],
            )

    import asyncio

    return asyncio.run(_run())


def test_model_record_includes_litellm_metadata(monkeypatch):
    monkeypatch.setattr("xihe_agent.llm.models.litellm.get_model_info", lambda _m: {
        "mode": "chat",
        "supports_vision": True,
        "max_input_tokens": 128000,
        "max_output_tokens": 16384,
        "max_tokens": 16384,
        "input_cost_per_token": 2.5e-06,
        "output_cost_per_token": 1e-05,
    })
    from xihe_agent.llm.models import _model_record

    record = _model_record("openai", "gpt-4o")
    assert record["capabilities"] == {"chat": True, "image": False}
    assert record["inputModalities"] == ["text", "image"]
    assert record["outputModalities"] == ["text"]
    assert record["contextWindowTokens"] == 128000
    assert record["maxOutputTokens"] == 16384
    assert record["pricing"] == {"currency": "USD", "unit": "1M tokens", "input": 2.5, "output": 10.0}


def test_model_record_omits_metadata_for_unknown_model(monkeypatch):
    monkeypatch.setattr("xihe_agent.llm.models.litellm.get_model_info", lambda _m: (_ for _ in ()).throw(Exception("unmapped")))
    from xihe_agent.llm.models import _model_record

    record = _model_record("test", "totally-unknown-model")
    assert record["capabilities"] == {"chat": True, "image": False}
    for key in ("inputModalities", "outputModalities", "contextWindowTokens", "maxOutputTokens", "pricing"):
        assert key not in record


def test_model_record_image_capability_from_litellm_mode(monkeypatch):
    monkeypatch.setattr("xihe_agent.llm.models.litellm.get_model_info", lambda _m: {"mode": "image_generation"})
    from xihe_agent.llm.models import _model_record

    record = _model_record("test", "seedream-4")  # name does NOT match the fallback pattern
    assert record["capabilities"]["image"] is True
    assert record["outputModalities"] == ["image"]


def test_model_record_image_capability_name_fallback(monkeypatch):
    monkeypatch.setattr("xihe_agent.llm.models.litellm.get_model_info", lambda _m: (_ for _ in ()).throw(Exception("unmapped")))
    from xihe_agent.llm.models import _model_record

    assert _model_record("openai", "dall-e-3")["capabilities"]["image"] is True
    assert _model_record("deepseek", "deepseek-chat")["capabilities"]["image"] is False


def test_scoped_catalog_remote_records_include_metadata(monkeypatch):
    info = {
        "mode": "chat",
        "supports_vision": False,
        "max_input_tokens": 64000,
        "max_output_tokens": 8192,
        "max_tokens": 8192,
        "input_cost_per_token": 1e-07,
        "output_cost_per_token": 5e-07,
    }
    monkeypatch.setattr("xihe_agent.llm.models.litellm.get_model_info", lambda _m: info)
    result = _run_scoped_catalog(["known-model"], monkeypatch)
    record = result["providers"]["conn-1"]["models"][0]
    assert record["contextWindowTokens"] == 64000
    assert record["maxOutputTokens"] == 8192
    assert record["inputModalities"] == ["text"]
    assert record["capabilities"]["image"] is False


def test_scoped_catalog_manual_models_include_metadata(monkeypatch):
    monkeypatch.setattr("xihe_agent.llm.models.litellm.get_model_info", lambda _m: {"mode": "image_generation"})
    result = _run_scoped_catalog(
        [],
        monkeypatch,
        model_discovery="manual",
        manual_models=["custom-image-model"],
    )
    record = result["providers"]["conn-1"]["models"][0]
    assert record["name"] == "custom-image-model"
    assert record["capabilities"]["image"] is True
    assert result["providers"]["conn-1"]["status"] == "ready"
