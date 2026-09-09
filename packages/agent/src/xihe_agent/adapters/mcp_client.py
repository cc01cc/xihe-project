import asyncio
import contextvars
import json
from collections.abc import Awaitable, Callable
from typing import Any

from langchain_core.tools import BaseTool
from langchain_mcp_adapters.client import MultiServerMCPClient
from langchain_mcp_adapters.interceptors import MCPToolCallRequest
from langchain_mcp_adapters.sessions import StreamableHttpConnection
from loguru import logger

from xihe_agent.adapters.approval_tool import ApprovalAgentTool, ApprovalTerminalError
from xihe_agent.interfaces.context import AgentContext
from xihe_agent.interfaces.tool import BaseAgentTool, ToolSpec

DEFAULT_RETRY_INTERVAL = 2.0
DEFAULT_MAX_RETRIES = 0
APPROVAL_GRANT_HEADER = "X-Xihe-Approval-Request-Id"
_ACTIVE_CONTEXT: contextvars.ContextVar[AgentContext | None] = contextvars.ContextVar(
    "xihe_active_mcp_context", default=None
)
REQUIRE_APPROVAL_TOOLS = frozenset({
    "write_file",
    "write_file_binary",
    "edit_file",
    "delete_file",
    "delete_directory",
    "move_file",
    "copy_file",
    "mkdir",
    "execute_command",
    "start_background_process",
    "cancel_background_process",
    "apply_patch",
    "create_snapshot",
    "revert_snapshot",
})


class ApprovalMCPInterceptor:
    """Request approval before a sensitive MCP call and attach its one-shot grant."""

    def __init__(self, approval_tool: ApprovalAgentTool) -> None:
        self._approval_tool = approval_tool

    async def __call__(
        self,
        request: MCPToolCallRequest,
        handler: Callable[[MCPToolCallRequest], Awaitable[Any]],
    ) -> Any:
        context = _ACTIVE_CONTEXT.get()
        headers: dict[str, str] = {}
        if context is not None:
            metadata = context.metadata
            session_id = metadata.get("sessionId")
            run_id = metadata.get("runId")
            operation_id = metadata.get("operationId")
            if session_id:
                headers["X-Session-Id"] = str(session_id)
            if run_id:
                headers["X-Chat-Run-Id"] = str(run_id)
            if operation_id:
                headers["X-Operation-Id"] = str(operation_id)
            operation_item_id = metadata.get("operationItemId")
            if operation_item_id:
                headers["X-Operation-Item-Id"] = str(operation_item_id)

        if request.name in REQUIRE_APPROVAL_TOOLS:
            if context is None:
                return await handler(request.override(headers=headers or None))
            details = json.dumps(
                {"tool": request.name, "arguments": request.args},
                ensure_ascii=False,
                sort_keys=True,
                separators=(",", ":"),
            )
            approval = await self._approval_tool.execute(
                {
                    "tool": request.name,
                    "action": f"Execute {request.name}",
                    "details": details,
                },
                context,
            )
            grant_id = approval.get("requestId")
            if not isinstance(grant_id, str) or not grant_id:
                raise ApprovalTerminalError("Approval did not return a grant requestId")
            headers[APPROVAL_GRANT_HEADER] = grant_id

        return await handler(request.override(headers=headers or None))


class MCPAgentTool(BaseAgentTool):
    """Wraps a LangChain MCP `BaseTool` as a `BaseAgentTool`."""

    def __init__(self, tool: BaseTool) -> None:
        self._tool = tool

    @property
    def base_tool(self) -> BaseTool:
        """Return the underlying LangChain tool for LangGraph adapters."""
        return self._tool

    async def execute(self, input: dict[str, Any], context: AgentContext) -> dict[str, Any]:
        context_token = _ACTIVE_CONTEXT.set(context)
        try:
            result = await self._tool.ainvoke(input)
            return {"content": str(result)}
        except ApprovalTerminalError:
            raise
        except Exception as e:
            logger.warning("MCP tool {} failed: {}", self._tool.name, e)
            return {"content": f"Tool error: {e}"}
        finally:
            _ACTIVE_CONTEXT.reset(context_token)

    @property
    def spec(self) -> ToolSpec:
        args_schema = self._tool.args_schema
        if isinstance(args_schema, dict):
            input_schema = args_schema
        elif args_schema:
            input_schema = args_schema.model_json_schema()
        else:
            input_schema = {}
        return ToolSpec(
            name=self._tool.name,
            description=self._tool.description or "",
            input_schema=input_schema,
        )


class MCPClientManager:
    def __init__(
        self,
        cp_url: str,
        server_name: str = "cp",
        workspace_id: str | None = None,
        api_token: str | None = None,
        approval_tool: ApprovalAgentTool | None = None,
        retry_interval: float = DEFAULT_RETRY_INTERVAL,
        max_retries: int = DEFAULT_MAX_RETRIES,
    ):
        self.cp_url = cp_url
        self.server_name = server_name
        self.workspace_id = workspace_id
        self.api_token = api_token
        self.approval_tool = approval_tool
        self.retry_interval = retry_interval
        self.max_retries = max_retries
        self._client: MultiServerMCPClient | None = None
        self._tools: list[BaseAgentTool] = []
        self._initialized = False
        self._lock = asyncio.Lock()

    @property
    def tools(self) -> list[BaseAgentTool]:
        return self._tools

    @property
    def initialized(self) -> bool:
        return self._initialized

    async def initialize(self, workspace_id: str | None = None) -> None:
        async with self._lock:
            if self._initialized:
                if workspace_id and workspace_id != self.workspace_id:
                    raise ValueError("MCP client is already initialized for another workspace")
                return
            if workspace_id:
                self.workspace_id = workspace_id
            if not self.workspace_id:
                raise ValueError("XIHE_WORKSPACE_ID is required for MCP initialization")
            headers: dict[str, Any] | None = None
            if self.workspace_id or self.api_token:
                headers = {}
                if self.workspace_id:
                    headers["X-Workspace-Id"] = self.workspace_id
                if self.api_token:
                    headers["Authorization"] = f"Bearer {self.api_token}"
            self._client = MultiServerMCPClient(
                {
                    self.server_name: StreamableHttpConnection(
                        transport="streamable_http",
                        url=self.cp_url,
                        headers=headers,
                    ),
                },
                tool_interceptors=(
                    [ApprovalMCPInterceptor(self.approval_tool)]
                    if self.approval_tool is not None
                    else []
                ),
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
        max_retries = self.max_retries if self.max_retries > 0 else 5
        backoff = self.retry_interval
        max_backoff = 30.0
        while True:
            try:
                await self.initialize()
                logger.info("[LIFECYCLE] service=agent event=mcp_init_ok toolsCount={} attempt={}", len(self._tools), attempt + 1)
                return
            except Exception as exc:
                attempt += 1
                if attempt > max_retries:
                    logger.warning("[LIFECYCLE] service=agent event=mcp_giving_up maxRetries={} lastError={}", max_retries, exc)
                    return
                logger.warning(
                    "[LIFECYCLE] service=agent event=mcp_init_failed error={} attempt={}/{} retryIn={:.1f}s",
                    exc, attempt, max_retries, backoff,
                )
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, max_backoff)
