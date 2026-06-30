"""Tests for adapters/mcp_client.py - MCP client manager."""
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from loguru import logger

from xihe_agent.adapters.mcp_client import MCPClientManager


class TestMCPClientManager:
    @pytest.fixture
    def manager(self):
        return MCPClientManager(
            cp_url="http://localhost:12631",
            server_name="cp",
            workspace_id="ws-1",
        )

    @pytest.fixture
    def log_sink(self):
        """Capture loguru output in a list for assertions."""
        messages = []
        sink_id = logger.add(messages.append, level="INFO")
        yield messages
        logger.remove(sink_id)

    def test_initial_state(self, manager):
        assert manager.initialized is False
        assert manager.tools == []
        assert manager.server_name == "cp"

    @pytest.mark.asyncio
    async def test_initialize_sets_initialized(self, manager):
        with patch(
            "xihe_agent.adapters.mcp_client.MultiServerMCPClient"
        ) as mock_client_cls:
            mock_client_cls.return_value.get_tools = AsyncMock(return_value=[])

            await manager.initialize()

        assert manager.initialized is True

    @pytest.mark.asyncio
    async def test_tools_property_empty_before_init(self, manager):
        assert manager.tools == []

    @pytest.mark.asyncio
    async def test_initialize_populates_tools(self, manager):
        mock_tool = MagicMock()
        mock_tool.name = "test_tool"

        with patch(
            "xihe_agent.adapters.mcp_client.MultiServerMCPClient"
        ) as mock_client_cls:
            mock_client_cls.return_value.get_tools = AsyncMock(return_value=[mock_tool])

            await manager.initialize()

        assert len(manager.tools) == 1
        assert manager.tools[0].name == "test_tool"

    @pytest.mark.asyncio
    async def test_initialize_logs_formatted_tool_count(self, manager, log_sink):
        mock_tool = MagicMock()
        mock_tool.name = "test_tool"

        with patch(
            "xihe_agent.adapters.mcp_client.MultiServerMCPClient"
        ) as mock_client_cls:
            mock_client_cls.return_value.get_tools = AsyncMock(return_value=[mock_tool])

            await manager.initialize()

        text = "\n".join(log_sink)
        assert "MCP initialized: 1 tools from ['test_tool']" in text
        assert "%d" not in text

    @pytest.mark.asyncio
    async def test_ensure_ready_logs_formatted_retry_message(self, manager, log_sink):
        manager.retry_interval = 0.0
        manager.max_retries = 1

        with patch(
            "xihe_agent.adapters.mcp_client.MultiServerMCPClient"
        ) as mock_client_cls:
            mock_client_cls.return_value.get_tools = AsyncMock(
                side_effect=ConnectionError("refused")
            )

            with pytest.raises(ConnectionError):
                await manager.ensure_ready()

        text = "\n".join(log_sink)
        assert "MCP init attempt 1 failed: refused" in text
        assert "%d" not in text
        assert "%s" not in text
