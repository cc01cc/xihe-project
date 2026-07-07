import asyncio
from typing import Any

from langchain_core.tools import BaseTool
from langchain_mcp_adapters.client import MultiServerMCPClient
from langchain_mcp_adapters.sessions import StreamableHttpConnection
from loguru import logger

from xihe_agent.interfaces.context import AgentContext
from xihe_agent.interfaces.tool import BaseAgentTool, ToolSpec

DEFAULT_RETRY_INTERVAL = 2.0
DEFAULT_MAX_RETRIES = 0


class MCPAgentTool(BaseAgentTool):
    """Wraps a LangChain MCP `BaseTool` as a `BaseAgentTool`."""

    def __init__(self, tool: BaseTool) -> None:
        self._tool = tool

    @property
    def base_tool(self) -> BaseTool:
        """Return the underlying LangChain tool for LangGraph adapters."""
        return self._tool

    async def execute(self, input: dict[str, Any], context: AgentContext) -> dict[str, Any]:
        try:
            result = await self._tool.ainvoke(input)
            return {"content": str(result)}
        except Exception as e:
            logger.warning("MCP tool {} failed: {}", self._tool.name, e)
            return {"content": f"Tool error: {e}"}

    @property
    def spec(self) -> ToolSpec:
        return ToolSpec(
            name=self._tool.name,
            description=self._tool.description or "",
            input_schema=self._tool.args_schema.model_json_schema() if self._tool.args_schema else {},
        )


class MCPClientManager:
    _client: MultiServerMCPClient | None = None
    _tools: list[BaseAgentTool] = []
    _initialized: bool = False
    _lock: asyncio.Lock = asyncio.Lock()

    def __init__(
        self,
        cp_url: str,
        server_name: str = "cp",
        workspace_id: str | None = None,
        retry_interval: float = DEFAULT_RETRY_INTERVAL,
        max_retries: int = DEFAULT_MAX_RETRIES,
    ):
        self.cp_url = cp_url
        self.server_name = server_name
        self.workspace_id = workspace_id
        self.retry_interval = retry_interval
        self.max_retries = max_retries

    @property
    def tools(self) -> list[BaseAgentTool]:
        return self._tools

    @property
    def initialized(self) -> bool:
        return self._initialized

    async def initialize(self) -> None:
        async with self._lock:
            if self._initialized:
                return
            headers: dict[str, Any] | None = None
            if self.workspace_id:
                headers = {"X-Workspace-Id": self.workspace_id}
            self._client = MultiServerMCPClient(
                {
                    self.server_name: StreamableHttpConnection(
                        transport="streamable_http",
                        url=self.cp_url,
                        headers=headers,
                    ),
                }
            )
            raw_tools = await self._client.get_tools(server_name=self.server_name)
            self._tools = [MCPAgentTool(t) for t in raw_tools]
            self._initialized = True
            logger.info(
                "MCP initialized: {} tools from {}",
                len(self._tools),
                [t.spec.name for t in self._tools],
            )

    async def reinitialize(self) -> None:
        async with self._lock:
            self._initialized = False
            self._client = None
            self._tools = []
        await self.initialize()

    async def ensure_ready(self) -> None:
        attempt = 0
        while True:
            try:
                await self.initialize()
                return
            except Exception as exc:
                attempt += 1
                if self.max_retries > 0 and attempt > self.max_retries:
                    raise
                logger.warning(
                    "MCP init attempt {} failed: {}. Retrying in {:.1f}s...",
                    attempt,
                    exc,
                    self.retry_interval,
                )
                await asyncio.sleep(self.retry_interval)
