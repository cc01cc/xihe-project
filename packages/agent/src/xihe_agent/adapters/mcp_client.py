import asyncio
import contextvars
import json
import os
from collections.abc import Awaitable, Callable
from datetime import timedelta
from typing import Any, NamedTuple

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

# PLAN-0308 M1（spec S1/S2）：本模块只做三条判断，不做任何计算——
# 下发值性质为 per-call → 用下发值（压过本模块 ENV）；
# 否则本模块 ENV 显式 → 用 ENV；
# 否则用下发值；都没有 → 代码默认。
# 会话读超时是"挂死兜底"（非权威），必须明显大于单次等待，避免抢先触发丢失署名。
SESSION_READ_HANG_BACKSTOP_S = 3600.0


def _env_override() -> float | None:
    """本模块 ENV 覆盖（`XIHE_MCP_TOOL_TIMEOUT_S`，调用时读取；非法值忽略）。"""
    raw = os.environ.get("XIHE_MCP_TOOL_TIMEOUT_S")
    if raw is None or raw == "":
        return None
    try:
        value = float(raw)
    except ValueError:
        logger.warning("Invalid XIHE_MCP_TOOL_TIMEOUT_S {!r}; ignoring", raw)
        return None
    if value <= 0:
        logger.warning("Non-positive XIHE_MCP_TOOL_TIMEOUT_S {!r}; ignoring", raw)
        return None
    return value


class ToolWait(NamedTuple):
    """一次工具调用的生效等待值 + 署名（字段口径 = PLAN-0308 spec S5）。"""

    seconds: float
    source: str  # env | cp | default
    value_origin: str | None  # per-call | config | None
    overridden_seconds: float | None
    tool_call_id: str | None = None

    def signature(self) -> str:
        parts = [f"layer=agent_wait effectiveSeconds={self.seconds:.0f}", f"source={self.source}"]
        if self.value_origin:
            parts.append(f"valueOrigin={self.value_origin}")
        if self.overridden_seconds is not None:
            parts.append(f"overriddenSeconds={self.overridden_seconds:.0f}")
        if self.tool_call_id:
            parts.append(f"toolCallId={self.tool_call_id}")
        return " ".join(parts)

    def timeout_signature(self) -> str:
        """自身到界时的署名：附 `origin=self`（spec S5.1 规则 2/3）。"""
        return f"{self.signature()} origin=self"


def _resolve_tool_wait(tool_name: str, context: "AgentContext | None") -> ToolWait:
    # 关联键（spec S5.1）：与 CP/Runtime 共用的 toolCallId（= 随请求透传的 operationItemId）。
    tool_call_id: str | None = None
    if context is not None:
        raw_id = context.metadata.get("operationItemId")
        if raw_id:
            tool_call_id = str(raw_id)
    delivered: float | None = None
    origin: str | None = None
    if context is not None:
        waits = context.runtime_state.get("toolWaits") or {}
        origins = context.runtime_state.get("toolWaitOrigins") or {}
        raw = waits.get(tool_name) if isinstance(waits, dict) else None
        if raw is None:
            # 系统工具统一值（CP 的 systemToolWait）：不依赖 per-tool 映射，
            # 冷缓存下仍可下发（spec S2.1；覆盖范围由 CP 的 budgetCoverage 标记）。
            raw = context.runtime_state.get("systemToolWait")
        if isinstance(raw, (int, float)) and not isinstance(raw, bool) and raw > 0:
            delivered = float(raw)
            if isinstance(origins, dict) and origins.get(tool_name) == "per-call":
                origin = "per-call"
            else:
                origin = "config"
    env = _env_override()
    if delivered is not None and origin == "per-call":
        return ToolWait(delivered, "cp", "per-call", env, tool_call_id)
    if env is not None:
        return ToolWait(env, "env", origin, delivered, tool_call_id)
    if delivered is not None:
        return ToolWait(delivered, "cp", origin, None, tool_call_id)
    return ToolWait(DEFAULT_MCP_TOOL_TIMEOUT_S, "default", None, None, tool_call_id)
APPROVAL_GRANT_HEADER = "X-Xihe-Approval-Request-Id"
# PLAN-0308 M1 T1.9（决策 #27/#28）：调用方 → CP 的 per-call 入站头。
# CP 下发原始 per-call 值（run payload 的 `toolTimeouts`），Agent 随对应工具调用携带；
# 值只由 CP 计算/校验，本模块不改写。CP 校验后以出站头 X-Xihe-Tool-Timeout-S/-Origin 转发 Runtime。
PER_CALL_TIMEOUT_HEADER = "X-Xihe-Tool-Timeout-Per-Call"


def _per_call_timeout_header(context: AgentContext | None, tool_name: str) -> dict[str, str]:
    """per-call 原始值 → 入站头（无 per-call 条目或值非法时不附带）。"""
    if context is None:
        return {}
    raw_map = context.runtime_state.get("toolTimeouts")
    raw = raw_map.get(tool_name) if isinstance(raw_map, dict) else None
    if isinstance(raw, (int, float)) and not isinstance(raw, bool):
        seconds = float(raw)
        if seconds > 0 and seconds.is_integer():
            return {PER_CALL_TIMEOUT_HEADER: str(int(seconds))}
    return {}

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
        # T1.9：per-call 值随工具调用单独携带（CP 校验后采纳为最高优先输入）。
        headers.update(_per_call_timeout_header(context, request.name))

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
            # PLAN-0308 M1: 与只读路径共用同一条判断链（下发值 / ENV / 默认）。
            post_wait = _resolve_tool_wait(request.name, context)
            # T1.8（spec S5.1）：审批工具的等待值同样打点（审批等待本身不设限，此界只作用于授权后的转发）。
            logger.info(
                "[LIFECYCLE] service=agent event=mcp_tool_post_grant tool={} toolCallId={}"
                + " waitS={} source={} valueOrigin={}",
                request.name,
                post_wait.tool_call_id or "-",
                post_wait.seconds,
                post_wait.source,
                post_wait.value_origin or "",
            )
            return await asyncio.wait_for(
                handler(request.override(headers=headers or None)),
                timeout=post_wait.seconds,
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
                if (
                    isinstance(val, str)
                    and val.startswith("/")
                    and not val.startswith("//")
                    and ".." not in val
                ):
                    payload[key] = val[1:]
            # Approval tools block on the user for minutes; only the post-grant
            # MCP HTTP hop is bounded by DEFAULT_MCP_TOOL_TIMEOUT_S (interceptor).
            wait = _resolve_tool_wait(self._tool.name, context)
            if self._tool.name in REQUIRE_APPROVAL_TOOLS:
                result = await self._tool.ainvoke(payload)
            else:
                # PLAN-0308 M1：等待值由 CP 计算（含余量与冷启动增量），本模块只执行；
                # 冷启动宽限不再本地乘 3（已由 CP 计入下发值）。
                # T1.8：toolCallId 与 CP/Runtime 共用，超时可跨三层串时间线（spec S5.1）。
                logger.info(
                    "[LIFECYCLE] service=agent event=mcp_tool_wait tool={} toolCallId={}"
                    + " waitS={} source={} valueOrigin={}",
                    self._tool.name,
                    wait.tool_call_id or "-",
                    wait.seconds,
                    wait.source,
                    wait.value_origin or "",
                )
                result = await asyncio.wait_for(
                    self._tool.ainvoke(payload),
                    timeout=wait.seconds,
                )
            elapsed_ms = int((asyncio.get_running_loop().time() - started) * 1000)
            # 下游（CP/Runtime）返回的错误以 "Tool error:" 前缀透传（与 CP 台账同一约定）：
            # 该跳未到界，只转发下游结论 → origin=downstream（spec S5.1 规则 2）。
            downstream_error = str(result).startswith("Tool error:")
            logger.info(
                "[LIFECYCLE] service=agent event=mcp_tool_ok tool={} toolCallId={} elapsedMs={} outcome={} origin={}",
                self._tool.name,
                wait.tool_call_id or "-",
                elapsed_ms,
                "error" if downstream_error else "ok",
                "downstream" if downstream_error else "-",
            )
            return {"content": str(result)}
        except ApprovalTerminalError:
            raise
        except TimeoutError:
            elapsed_ms = int((asyncio.get_running_loop().time() - started) * 1000)
            timed_out = _resolve_tool_wait(self._tool.name, context)
            logger.error(
                "[LIFECYCLE] service=agent event=mcp_tool_timeout tool={} {} elapsedMs={}",
                self._tool.name,
                timed_out.timeout_signature(),
                elapsed_ms,
            )
            return {
                "content": (
                    f"Tool error: MCP tool '{self._tool.name}' timed out after "
                    f"{timed_out.seconds:.0f}s ({timed_out.timeout_signature()})."
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
                        # 挂死兜底：单次等待的权威值由 CP 下发（可达 600+ 秒），
                        # 此处的会话读超时必须明显大于它，否则会抢先触发并丢失署名。
                        session_kwargs={
                            "read_timeout_seconds": timedelta(seconds=SESSION_READ_HANG_BACKSTOP_S)
                        },
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
