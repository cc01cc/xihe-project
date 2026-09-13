import asyncio
import json
import os
import warnings
from typing import Any, NamedTuple

import mcp.types as _mcp_types
from fastmcp import Client
from fastmcp.client.transports import StreamableHttpTransport
from langchain_core._api import LangChainBetaWarning
from langchain_core.tools import BaseTool
from loguru import logger

from xihe_agent.adapters.approval_tool import ApprovalAgentTool, ApprovalTerminalError
from xihe_agent.interfaces.context import AgentContext
from xihe_agent.interfaces.tool import BaseAgentTool, ToolSpec

# PLAN-0308 M2（决策 #34）：客户端栈迁移到 `langchain[mcp]`（fastmcp 4.x + mcp 2.x）。
# `langchain.mcp` 处于 beta（导入时发一次 LangChainBetaWarning），本模块按路线 C
# 有意采用该命名空间，导入期抑制该警告。
with warnings.catch_warnings():
    warnings.simplefilter("ignore", LangChainBetaWarning)
    from langchain.mcp import as_langchain_tool

# 目标协议世代：2026-07-28（无会话/每请求独立信封）。CP 出站已固定声明该版本
# （决策 #34），Runtime rmcp 全版本支持；客户端以版本串直接采纳、免 server/discover 探测。
STATELESS_PROTOCOL_VERSION = "2026-07-28"

DEFAULT_RETRY_INTERVAL = 2.0
DEFAULT_MAX_RETRIES = 0


# Local MCP (CP→Runtime) must return in seconds; a stuck POST is a bug, and the
# authoritative per-call bound is `asyncio.wait_for` in MCPAgentTool (see spec S2).
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
# 权威等待界由 `asyncio.wait_for` 承担；传输层读超时显式设为挂死兜底
# （3600s，位于所有逻辑授权值之外），避免 SDK 默认值抢先于授权值
# （T3.1：fastmcp 不传 timeout 时 SDK 默认 read=300s，会被误当"无限"）。
# 发现/初始化路径不经 wait_for 包裹（持锁、非逐调用），单独用短界，
# 避免兜底把发现挂死窗口从 300s 放大到 3600s（评审修复）。
SESSION_READ_HANG_BACKSTOP_S = 3600.0
DISCOVERY_READ_TIMEOUT_S = 30.0


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


def _context_headers(context: AgentContext | None, tool_name: str) -> dict[str, str]:
    """上下文动态头（原 ApprovalMCPInterceptor 职责，决策 #34 迁移后由本模块直接构造）。"""
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
    headers.update(_per_call_timeout_header(context, tool_name))
    return headers


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


def _result_text(result: Any) -> str:
    """fastmcp CallToolResult → LLM 可见文本（文本块拼接；无文本时退结构化内容/原始内容）。

    `is_error=True` 且文本未带 `Tool error:` 前缀时补前缀，保持与 CP/Runtime
    台账同一约定（spec S5.1：下游结论透传，本跳未到界）。
    """
    blocks = getattr(result, "content", None) or []
    parts = [block.text for block in blocks if isinstance(block, _mcp_types.TextContent)]
    if parts:
        text = "\n".join(parts)
    else:
        structured = getattr(result, "structured_content", None)
        if structured is not None:
            text = json.dumps(structured, ensure_ascii=False)
        else:
            text = str(blocks)
    if getattr(result, "is_error", False) and not text.startswith("Tool error:"):
        text = f"Tool error: {text}"
    return text


class MCPAgentTool(BaseAgentTool):
    """A discovered MCP tool; executes through a per-call fastmcp `Client`.

    PLAN-0308 决策 #34：`langchain.mcp` 不提供逐调用头通道（transport 头仅在
    构造期静态注入），而审批 grant / per-call 超时 / 运行上下文头必须随调用变化，
    因此执行路径改用「逐调用构造短生命周期 Client（携带当期头集合）」；发现期
    的 LangChain 工具仅保留给 registry/supervisor 直连路径（`base_tool`）。
    """

    def __init__(self, tool: BaseTool, manager: "MCPClientManager") -> None:
        self._tool = tool
        self._manager = manager

    @property
    def base_tool(self) -> BaseTool:
        """Return the LangChain tool for LangGraph adapters (registry/supervisor path)."""
        return self._tool

    async def execute(self, input: dict[str, Any], context: AgentContext) -> dict[str, Any]:
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
            headers = _context_headers(context, self._tool.name)
            if self._tool.name in REQUIRE_APPROVAL_TOOLS:
                grant_id = await self._request_approval(payload, context)
                if grant_id:
                    headers[APPROVAL_GRANT_HEADER] = grant_id
                # Post-approval Runtime call is local: fail fast if gateway stalls.
                # The approval wait itself is user-bound and must NOT count here.
                post_wait = _resolve_tool_wait(self._tool.name, context)
                # T1.8（spec S5.1）：审批工具的等待值同样打点。
                # 2026-09-13 E2E（V3）：补 grantId —— grant 即 CP 审批请求 id，而
                # CP 账本条目键 = 审批请求 id、Runtime 注册表键 = 该条目键，
                # 三跳时间线可据此串起（Agent grantId ↔ CP item ↔ Runtime exec）。
                logger.info(
                    "[LIFECYCLE] service=agent event=mcp_tool_post_grant tool={} toolCallId={}"
                    + " grantId={} waitS={} source={} valueOrigin={}",
                    self._tool.name,
                    post_wait.tool_call_id or "-",
                    grant_id or "-",
                    post_wait.seconds,
                    post_wait.source,
                    post_wait.value_origin or "",
                )
                result = await asyncio.wait_for(
                    self._manager.call_tool(self._tool.name, payload, headers),
                    timeout=post_wait.seconds,
                )
            else:
                # PLAN-0308 M1：等待值由 CP 计算（含余量与冷启动增量），本模块只执行；
                # T1.8：toolCallId 与 CP/Runtime 共用，超时可跨三层串时间线（spec S5.1）。
                wait = _resolve_tool_wait(self._tool.name, context)
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
                    self._manager.call_tool(self._tool.name, payload, headers),
                    timeout=wait.seconds,
                )
            elapsed_ms = int((asyncio.get_running_loop().time() - started) * 1000)
            content = _result_text(result)
            wait = _resolve_tool_wait(self._tool.name, context)
            # 下游（CP/Runtime）返回的错误以 "Tool error:" 前缀透传（与 CP 台账同一约定）：
            # 该跳未到界，只转发下游结论 → origin=downstream（spec S5.1 规则 2）。
            downstream_error = content.startswith("Tool error:")
            logger.info(
                "[LIFECYCLE] service=agent event=mcp_tool_ok tool={} toolCallId={} elapsedMs={} outcome={} origin={}",
                self._tool.name,
                wait.tool_call_id or "-",
                elapsed_ms,
                "error" if downstream_error else "ok",
                "downstream" if downstream_error else "-",
            )
            return {"content": content}
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

    async def _request_approval(self, payload: dict[str, Any], context: AgentContext) -> str | None:
        """审批门控工具：请求一次性 grant 并返回 requestId（无审批工具/上下文时跳过）。"""
        approval_tool = self._manager.approval_tool
        if approval_tool is None or context is None:
            return None
        details = json.dumps(
            {"tool": self._tool.name, "arguments": payload},
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        )
        approval = await approval_tool.execute(
            {
                "tool": self._tool.name,
                "action": f"Execute {self._tool.name}",
                "details": details,
            },
            context,
        )
        grant_id = approval.get("requestId")
        if not isinstance(grant_id, str) or not grant_id:
            raise ApprovalTerminalError("Approval did not return a grant requestId")
        return grant_id

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
        max_retries: float = DEFAULT_MAX_RETRIES,
    ):
        self.cp_url = cp_url
        self.server_name = server_name
        self.workspace_id = workspace_id
        self.api_token = api_token
        self.approval_tool = approval_tool
        self.retry_interval = retry_interval
        self.max_retries = max_retries
        self._discovery_client: Client | None = None
        self._tools: list[BaseAgentTool] = []
        self._initialized = False
        self._lock = asyncio.Lock()

    @property
    def tools(self) -> list[BaseAgentTool]:
        return self._tools

    @property
    def initialized(self) -> bool:
        return self._initialized

    def _static_headers(self) -> dict[str, str]:
        headers: dict[str, str] = {}
        if self.workspace_id:
            headers["X-Workspace-Id"] = self.workspace_id
        if self.api_token:
            headers["Authorization"] = f"Bearer {self.api_token}"
        return headers

    def request_headers(self, dynamic: dict[str, str]) -> dict[str, str]:
        """静态头（workspace/服务鉴权）+ 逐调用动态头的合并结果。"""
        return {**self._static_headers(), **dynamic}

    def new_client(
        self, headers: dict[str, str], timeout: float = SESSION_READ_HANG_BACKSTOP_S
    ) -> Client:
        """构造一个携带指定头集合的 fastmcp 客户端（跨调用不复用，见决策 #34）。

        `timeout` = 传输层读超时兜底：逐调用路径用 3600s（位于授权值之外）；
        发现/初始化路径传 {@link DISCOVERY_READ_TIMEOUT_S}（短界，防持锁挂死）。
        """
        transport = StreamableHttpTransport(self.cp_url, headers=headers)
        return Client(
            transport,
            name=self.server_name,
            mode=STATELESS_PROTOCOL_VERSION,
            timeout=timeout,
        )

    async def call_tool(self, name: str, arguments: dict[str, Any], headers: dict[str, str]) -> Any:
        """逐调用执行 tools/call：短生命周期 Client + 当期头集合（静态头在此合并）。

        `raise_on_error=False` 保留 `isError` 结果供上层归因（downstream 分类），
        与迁移前 langchain-mcp-adapters 的处置口径一致（spec S5.1）。
        """
        merged = self.request_headers(headers)
        async with self.new_client(merged) as client:
            return await client.call_tool(name, arguments, raise_on_error=False)

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
            headers = self._static_headers()
            discovery = self.new_client(headers, timeout=DISCOVERY_READ_TIMEOUT_S)
            async with discovery:
                raw_tools = await discovery.list_tools()
                lc_tools = [await as_langchain_tool(tool, discovery) for tool in raw_tools]
            self._discovery_client = discovery
            self._tools = [MCPAgentTool(tool, self) for tool in lc_tools]
            self._initialized = True
            logger.info(
                "MCP initialized: {} tools from {}",
                len(self._tools),
                [t.spec.name for t in self._tools],
            )

    async def reinitialize(self) -> None:
        async with self._lock:
            self._initialized = False
            self._discovery_client = None
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
