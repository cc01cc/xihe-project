import asyncio
import contextvars
import json
import os
from collections.abc import Awaitable, Callable
from datetime import timedelta
from typing import Any

from langchain_core.tools import BaseTool
from langchain_mcp_adapters.client import MultiServerMCPClient
from langchain_mcp_adapters.interceptors import MCPToolCallRequest
from langchain_mcp_adapters.sessions import StreamableHttpConnection
from loguru import logger
from mcp.client import streamable_http as _mcp_streamable_http

from xihe_agent.adapters.approval_tool import ApprovalAgentTool, ApprovalTerminalError
from xihe_agent.interfaces.context import AgentContext
from xihe_agent.interfaces.tool import BaseAgentTool, ToolSpec

DEFAULT_RETRY_INTERVAL = 2.0
DEFAULT_MAX_RETRIES = 0
# Local MCP (CP→Runtime) must return in seconds; a stuck GET/POST is a bug.
# Approval wait is user-bound and must NOT count against this budget — see
# ApprovalMCPInterceptor: short timeout applies only to the post-grant HTTP call.
# Post-grant MCP hop: Runtime write can outlast a bare 10–15s under Docker
# exec; keep a hard bound but allow grant→forward→result to complete.
def _parse_timeout_s(raw: str | None, default: float) -> float:
    """PLAN-301 M1 (decision #4): fail-closed timeout parsing.

    Invalid or non-positive values degrade to the default with a warning —
    a misconfigured timeout must never produce an unbounded wait.
    """
    if raw is None or raw == "":
        return default
    try:
        value = float(raw)
    except ValueError:
        logger.warning("Invalid timeout value {!r}; falling back to {}", raw, default)
        return default
    if value <= 0:
        logger.warning("Non-positive timeout value {!r}; falling back to {}", raw, default)
        return default
    return value


DEFAULT_MCP_TOOL_TIMEOUT_S = _parse_timeout_s(
    os.environ.get("XIHE_MCP_TOOL_TIMEOUT_S"), default=30.0
)
APPROVAL_GRANT_HEADER = "X-Xihe-Approval-Request-Id"
_ACTIVE_CONTEXT: contextvars.ContextVar[AgentContext | None] = contextvars.ContextVar(
    "xihe_active_mcp_context", default=None
)
# PLAN-292 T4: only Gateway-public mutation tools belong here. The Runtime's
# apply_patch/create_snapshot/revert_snapshot/cleanup_jobs are internal-only
# (never exposed via #[tool_router], PLAN-292 T3 decision) and write_file_binary
# does not exist as an MCP tool — listing them created false completeness.
REQUIRE_APPROVAL_TOOLS = frozenset({
    "write_file",
    "edit_file",
    "delete_file",
    "delete_directory",
    "move_file",
    "copy_file",
    "mkdir",
    "execute_command",
    "start_background_process",
    "cancel_background_process",
})


async def _disable_mcp_get_server_stream(
    self, client: Any, read_stream_writer: Any
) -> None:
    """CP logical MCP does not serve server-initiated GET SSE (returns 405).

    Stock Streamable HTTP client starts GET after initialize and retries on
    405, which races with POST tool responses and can stall call_tool for the
    full tool timeout (Host 2026-09-09). Direct POST tools/call is ~75ms.
    Disable the unused GET channel; tool results continue to arrive on POST.
    """
    logger.debug("Skipping MCP GET server stream (CP has no server-init SSE)")


_mcp_streamable_http.StreamableHTTPTransport.handle_get_stream = (
    _disable_mcp_get_server_stream
)


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
            # Post-approval Runtime call is local: fail fast if gateway stalls.
            # PLAN-301 M1: same parsed constant as the read-only path — the
            # approval hop does not change the execution time class.
            return await asyncio.wait_for(
                handler(request.override(headers=headers or None)),
                timeout=DEFAULT_MCP_TOOL_TIMEOUT_S,
            )

        return await handler(request.override(headers=headers or None))


class MCPAgentTool(BaseAgentTool):
    """Wraps a LangChain MCP `BaseTool` as a `BaseAgentTool`."""

    def __init__(
        self,
        tool: BaseTool,
        call_timeout_s: float | None = None,
    ) -> None:
        self._tool = tool
        self._call_timeout_s = (
            call_timeout_s if call_timeout_s is not None else DEFAULT_MCP_TOOL_TIMEOUT_S
        )

    @property
    def base_tool(self) -> BaseTool:
        """Return the underlying LangChain tool for LangGraph adapters."""
        return self._tool

    async def execute(self, input: dict[str, Any], context: AgentContext) -> dict[str, Any]:
        context_token = _ACTIVE_CONTEXT.set(context)
        started = asyncio.get_running_loop().time()
        try:
            payload = dict(input)
            # Workspace-relative paths only: models often send "/file.md".
            for key in ("path", "file_path"):
                val = payload.get(key)
                if isinstance(val, str) and val.startswith("/") and not val.startswith("//"):
                    if ".." not in val:
                        payload[key] = val[1:]
            # Approval tools block on the user for minutes; only the post-grant
            # MCP HTTP hop is bounded by DEFAULT_MCP_TOOL_TIMEOUT_S (interceptor).
            if self._tool.name in REQUIRE_APPROVAL_TOOLS:
                result = await self._tool.ainvoke(payload)
            else:
                # PLAN-301 M2 (decision #2): per-call override from the run
                # request (runtime_state.toolTimeoutOverrides) beats the
                # server/global default — a caller-specified timeout is a
                # stronger intent than any configured default.
                effective = self._call_timeout_s
                overrides = context.runtime_state.get("toolTimeoutOverrides") or {}
                if isinstance(overrides, dict) and self._tool.name in overrides:
                    try:
                        override_val = float(overrides[self._tool.name])
                        if override_val > 0:
                            effective = override_val
                    except (TypeError, ValueError):
                        logger.warning(
                            "Invalid toolTimeoutOverrides value for {}: {!r}; using default",
                            self._tool.name, overrides.get(self._tool.name),
                        )
                    result = await asyncio.wait_for(
                        self._tool.ainvoke(payload),
                        timeout=effective,
                    )
                else:
                    # PLAN-301 M3 (decision #3): cold-start grace — the first
                    # tool call after workspace materialization gets 3x, one
                    # shot, because the oneshot exec path pays container/image
                    # warm-up that can exceed the steady-state bound. Explicit
                    # per-call overrides skip the multiplier (stronger intent).
                    if not context.runtime_state.get("firstToolCallDone"):
                        effective = effective * 3
                    result = await asyncio.wait_for(
                        self._tool.ainvoke(payload),
                        timeout=effective,
                    )
                    context.runtime_state["firstToolCallDone"] = True
            elapsed_ms = int((asyncio.get_running_loop().time() - started) * 1000)
            logger.info(
                "[LIFECYCLE] service=agent event=mcp_tool_ok tool={} elapsedMs={}",
                self._tool.name,
                elapsed_ms,
            )
            return {"content": str(result)}
        except ApprovalTerminalError:
            raise
        except TimeoutError:
            elapsed_ms = int((asyncio.get_running_loop().time() - started) * 1000)
            logger.error(
                "[LIFECYCLE] service=agent event=mcp_tool_timeout tool={} timeoutS={} elapsedMs={}",
                self._tool.name,
                self._call_timeout_s,
                elapsed_ms,
            )
            return {
                "content": (
                    f"Tool error: MCP tool '{self._tool.name}' timed out after "
                    f"{self._call_timeout_s:.0f}s. The workspace gateway may be "
                    "unreachable or the tool session stalled."
                )
            }
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
                        # Bound ClientSession reads so a stuck POST/SSE cannot
                        # await a tool response forever (Host hang 2026-09-09).
                        session_kwargs={"read_timeout_seconds": timedelta(seconds=DEFAULT_MCP_TOOL_TIMEOUT_S)},
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
