"""Tests for image generation tool."""

import base64
from unittest.mock import AsyncMock, patch

import pytest

from xihe_agent.tools import (
    GenerateImageTool,
    GPTImageProvider,
    ProviderManager,
)


class TestProviderManager:
    def test_empty_manager_raises(self):
        mgr = ProviderManager()
        with pytest.raises(ValueError, match="Unknown image provider"):
            mgr.get("nonexistent")

    def test_register_and_get(self):
        mgr = ProviderManager()
        provider = GPTImageProvider(api_key="test")
        mgr.register("test-provider", provider)
        assert mgr.get("test-provider") is provider
        assert mgr.default_provider == "test-provider"

    def test_get_default(self):
        mgr = ProviderManager()
        provider = GPTImageProvider(api_key="test")
        mgr.register("gpt-image", provider)
        assert mgr.get() is provider

    def test_from_env_no_keys(self):
        with patch.dict("os.environ", {}, clear=True):
            mgr = ProviderManager.from_env()
            assert len(mgr.providers) == 0

    def test_from_env_with_openai_key(self):
        env = {"XIHE_OPENAI_API_KEY": "sk-test"}
        with patch.dict("os.environ", env, clear=True):
            mgr = ProviderManager.from_env()
            assert "gpt-image" in mgr.providers
            assert isinstance(mgr.providers["gpt-image"], GPTImageProvider)

    def test_from_env_with_dashscope_key(self):
        env = {"XIHE_DASHSCOPE_API_KEY": "sk-test"}
        with patch.dict("os.environ", env, clear=True):
            mgr = ProviderManager.from_env()
            assert "qwen-image" in mgr.providers


class TestGPTImageProvider:
    @pytest.mark.asyncio
    async def test_generate_success(self):
        fake_image = b"\x89PNG\r\n\x1a\n" + b"\x00" * 100
        fake_b64 = base64.b64encode(fake_image).decode()

        mock_response = AsyncMock()
        mock_response.status_code = 200
        mock_response.raise_for_status = lambda: None
        mock_response.json = lambda: {"data": [{"b64_json": fake_b64}]}

        mock_client = AsyncMock()
        mock_client.post = AsyncMock(return_value=mock_response)
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)

        with patch("httpx.AsyncClient", return_value=mock_client):
            provider = GPTImageProvider(api_key="sk-test")
            result = await provider.generate("a sunset", "1024x1024", "medium")
            assert result == fake_image

    @pytest.mark.asyncio
    async def test_generate_http_error(self):
        import httpx

        mock_response = AsyncMock()
        mock_response.status_code = 429

        def raise_error():
            raise httpx.HTTPStatusError("Rate limited", request=AsyncMock(), response=mock_response)

        mock_response.raise_for_status = raise_error

        mock_client = AsyncMock()
        mock_client.post = AsyncMock(return_value=mock_response)
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)

        with patch("httpx.AsyncClient", return_value=mock_client):
            provider = GPTImageProvider(api_key="sk-test")
            with pytest.raises(httpx.HTTPStatusError):
                await provider.generate("a sunset")


class TestGenerateImageTool:
    @pytest.mark.asyncio
    async def test_tool_returns_base64(self):
        fake_image = b"\x89PNG" + b"\x00" * 50
        mock_provider = AsyncMock()
        mock_provider.generate.return_value = fake_image

        mgr = ProviderManager()
        mgr.register("test", mock_provider)

        tool = GenerateImageTool(provider_manager=mgr)
        result = await tool._arun("a cat")

        assert "[IMAGE:" in result
        assert "data:image/png;base64," in result
        assert mock_provider.generate.called

    @pytest.mark.asyncio
    async def test_tool_handles_error(self):
        mock_provider = AsyncMock()
        mock_provider.generate.side_effect = RuntimeError("API error")

        mgr = ProviderManager()
        mgr.register("test", mock_provider)

        tool = GenerateImageTool(provider_manager=mgr)
        result = await tool._arun("a cat")

        assert "图片生成失败" in result
