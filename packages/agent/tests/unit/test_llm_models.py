"""Tests for llm/models.py - routing + httpx logic."""
from unittest.mock import AsyncMock, MagicMock, patch

import pytest


@pytest.fixture
def patch_config_client():
    """Mock the _models_router.config_client to return test providers.
    get_providers() is sync, so use MagicMock (not AsyncMock)."""
    with patch("xihe_agent.llm.models._models_router") as mock_router:
        mock_router.config_client = MagicMock()
        yield mock_router


@pytest.mark.asyncio
async def test_list_models_no_config_returns_empty(patch_config_client):
    from xihe_agent.llm.models import list_models

    patch_config_client.config_client = None
    result = await list_models()
    assert result == {"models": {}}


@pytest.mark.asyncio
async def test_list_models_httpx_failure_returns_empty(patch_config_client):
    from xihe_agent.llm.models import list_models

    patch_config_client.config_client.get_providers.return_value = {
        "openai": {"apiKey": "sk-test", "baseUrl": "https://api.openai.com"},
    }
    with patch("xihe_agent.llm.models.httpx.AsyncClient") as mock_client_cls:
        mock_client = AsyncMock()
        mock_client_cls.return_value.__aenter__.return_value = mock_client
        mock_client.get.side_effect = Exception("Network error")

        result = await list_models()
    assert result["models"]["openai"] == []


@pytest.mark.asyncio
async def test_list_models_empty_providers(patch_config_client):
    from xihe_agent.llm.models import list_models

    patch_config_client.config_client.get_providers.return_value = {}
    result = await list_models()
    assert result == {"models": {}}
