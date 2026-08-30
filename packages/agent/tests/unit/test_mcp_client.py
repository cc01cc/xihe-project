"""Tests for adapters/mcp_client.py - MCP client manager."""
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from loguru import logger

from xihe_agent import main
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
        assert manager.tools[0].spec.name == "test_tool"

    @pytest.mark.asyncio
    async def test_initialize_can_bind_request_workspace_before_discovery(self):
        manager = MCPClientManager(
            cp_url="http://localhost:12631",
            server_name="cp",
        )
        with patch(
            "xihe_agent.adapters.mcp_client.MultiServerMCPClient"
        ) as mock_client_cls:
            mock_client_cls.return_value.get_tools = AsyncMock(return_value=[])

            await manager.initialize(workspace_id="request-workspace")

        connection = mock_client_cls.call_args.args[0]["cp"]
        assert manager.workspace_id == "request-workspace"
        assert connection["headers"]["X-Workspace-Id"] == "request-workspace"

    @pytest.mark.asyncio
    async def test_initialize_configures_only_the_cp_logical_endpoint(self, manager):
        with patch(
            "xihe_agent.adapters.mcp_client.MultiServerMCPClient"
        ) as mock_client_cls:
            mock_client_cls.return_value.get_tools = AsyncMock(return_value=[])

            await manager.initialize()

        config = mock_client_cls.call_args.args[0]
        connection = config["cp"]
        assert connection["url"] == "http://localhost:12631"
        assert connection["url"].endswith("12631")
        assert "remote" not in connection["url"]
        assert connection["headers"]["X-Workspace-Id"] == "ws-1"

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

            # ensure_ready now returns (gives up) instead of raising
            await manager.ensure_ready()

        text = "\n".join(log_sink)
        assert "[LIFECYCLE] service=agent event=mcp_init_failed" in text
        assert "attempt=1/1" in text
        assert "[LIFECYCLE] service=agent event=mcp_giving_up" in text
        assert "maxRetries=1" in text

    @pytest.mark.asyncio
    async def test_chat_without_workspace_does_not_initialize_mcp(self, monkeypatch):
        mock_manager = MagicMock()
        mock_manager.initialized = False
        mock_manager.workspace_id = None
        mock_manager.initialize = AsyncMock()
        mock_manager.tools = []
        monkeypatch.setattr(main, "mcp_manager", mock_manager)

        assert await main._get_mcp_tools(None) == []
        mock_manager.initialize.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_chat_with_workspace_initializes_mcp_on_demand(self, monkeypatch):
        mock_manager = MagicMock()
        mock_manager.initialized = False
        mock_manager.workspace_id = None
        mock_manager.initialize = AsyncMock()
        mock_manager.tools = []
        monkeypatch.setattr(main, "mcp_manager", mock_manager)

        assert await main._get_mcp_tools("request-workspace") == []
        mock_manager.initialize.assert_awaited_once_with(workspace_id="request-workspace")

    @pytest.mark.asyncio
    async def test_chat_skips_mcp_for_a_different_bound_workspace(self, monkeypatch):
        mock_manager = MagicMock()
        mock_manager.initialized = True
        mock_manager.workspace_id = "bound-workspace"
        mock_manager.initialize = AsyncMock()
        mock_manager.tools = []
        monkeypatch.setattr(main, "mcp_manager", mock_manager)

        assert await main._get_mcp_tools("other-workspace") == []
        mock_manager.initialize.assert_not_awaited()
