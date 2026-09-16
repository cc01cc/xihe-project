import asyncio
import json
import os
import warnings
from datetime import datetime
from typing import Any, NamedTuple

import mcp.types as _mcp_types
from fastmcp import Client
from fastmcp.client.transports import StreamableHttpTransport
from langchain_core._api import LangChainBetaWarning
from langchain_core.tools import BaseTool
from loguru import logger
from mcp.shared.exceptions import MCPError

from xihe_agent.adapters.approval_tool import (
    ApprovalAgentTool,
    ApprovalProtocolError,
    ApprovalRetryFailedError,
    ApprovalTerminalError,
    is_valid_approval_request_id,
    parse_approval_expiry,
)
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


# PLAN-0337 M2：审批触发权归 CP。本模块**不再持有**需审批工具的本地清单，也不做任何
# 前置判定——工具分类与「是否需要人工确认」的唯一权威是 CP（`ToolFaceRegistry` + 闸门）。
# 首个调用直达 CP 闸门；闸门以 409 APPROVAL_REQUIRED 返回时由 `_retry_after_gate` 处理。


# PLAN-0328 T1.9（post-gate）：CP MCP 闸门对无有效 grant 的 ASK 返回 HTTP 409，
# 其 RFC 9457 扩展必须以 JSON-RPC error.data 形态到达本模块（fastmcp 4.x/mcp 2.x
# 传输层会丢弃非 JSON-RPC 错误体并合成为通用 -32603；这不是本模块可调整的）。
# 本模块只消费安全扩展（requestId/tool/expiresAt），永不记录错误体或工具参数原文。
APPROVAL_REQUIRED_CODE = "APPROVAL_REQUIRED"
_APPROVAL_PROBLEM_WRAPPER_KEYS = ("problem", "error", "data")


class ApprovalGateSignal(NamedTuple):
    """CP 闸门 409 的安全扩展：post-gate 等待与一次性重试所需字段。"""

    request_id: str
    tool: str
    expires_at: datetime


def _mcp_error_from(exc: BaseException) -> MCPError | None:
    """在异常链（最多 4 层、防环）上寻找 MCPError。"""
    candidate: BaseException | None = exc
    seen: set[int] = set()
    depth = 0
    while candidate is not None and depth < 4 and id(candidate) not in seen:
        if isinstance(candidate, MCPError):
            return candidate
        seen.add(id(candidate))
        candidate = candidate.__cause__ or candidate.__context__
        depth += 1
    return None


def _approval_problem_from_data(data: Any) -> dict[str, Any] | None:
    """从 JSON-RPC error.data 提取 problem 字典（容忍 JSON 字符串与多层包裹键）。"""
    if isinstance(data, str):
        try:
            data = json.loads(data)
        except ValueError:
            return None
    if not isinstance(data, dict):
        return None
    problem: dict[str, Any] = data
    for _ in range(4):
        if problem.get("code"):
            return problem
        nested: dict[str, Any] | None = None
        for key in _APPROVAL_PROBLEM_WRAPPER_KEYS:
            candidate = problem.get(key)
            if isinstance(candidate, dict):
                nested = candidate
                break
        if nested is None:
            return problem
        problem = nested
    return problem


def classify_approval_gate_failure(exc: BaseException, tool_name: str) -> ApprovalGateSignal | None:
    """识别 CP MCP 闸门的 409 APPROVAL_REQUIRED 并解析其安全扩展。

    返回 None 表示该失败不是审批闸门信号（调用方维持既有 downstream 错误路径）。
    识别为审批信号但扩展缺失/畸形/不匹配时抛 ApprovalProtocolError：调用方必须
    fail-closed——不得注册等待者、不得重试、不得把原始错误体写入日志。
    """
    mcp_error = _mcp_error_from(exc)
    if mcp_error is None:
        return None
    problem = _approval_problem_from_data(mcp_error.data)
    code = problem.get("code") if problem is not None else None
    message = str(getattr(mcp_error, "message", "") or "")
    if code != APPROVAL_REQUIRED_CODE and message != APPROVAL_REQUIRED_CODE:
        return None
    if problem is None:
        raise ApprovalProtocolError("CP gate approval signal carried no usable payload")
    if code != APPROVAL_REQUIRED_CODE:
        raise ApprovalProtocolError("CP gate approval signal code mismatch")
    if problem.get("status") not in (None, 409):
        raise ApprovalProtocolError("CP gate approval signal status is not 409")
    request_id = problem.get("approvalRequestId")
    if not is_valid_approval_request_id(request_id):
        raise ApprovalProtocolError("CP gate approval signal approvalRequestId is invalid")
    signal_tool = problem.get("tool")
    if isinstance(signal_tool, str) and signal_tool and signal_tool != tool_name:
        raise ApprovalProtocolError("CP gate approval signal tool does not match the call")
    retry_header = problem.get("retryHeader")
    if isinstance(retry_header, str) and retry_header and retry_header != APPROVAL_GRANT_HEADER:
        raise ApprovalProtocolError("CP gate approval signal retry header does not match")
    return ApprovalGateSignal(
        request_id=request_id,
        tool=tool_name,
        expires_at=parse_approval_expiry(problem.get("expiresAt")),
    )


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
            # PLAN-0337 M2：单一派发路径。是否弹窗由 CP 闸门判定；本模块不预判、不预取 grant，
            # 仅在闸门返回 409 APPROVAL_REQUIRED 时等待决定并携 grant 重试一次（_retry_after_gate）。
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
            result = await self._dispatch(payload, headers, context, wait)
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

    async def _dispatch(
        self,
        payload: dict[str, Any],
        headers: dict[str, str],
        context: AgentContext,
        wait: ToolWait,
    ) -> Any:
        """执行一次 MCP 调用，并在 CP 闸门 409 时进入 post-gate 等待（T1.9）。

        正常路径与既有行为完全一致（单次调用 + 授权等待值界）；仅当异常被识别为
        CP 闸门批准信号时才转为「等待推送决定 → 恰好重试一次」。
        """
        try:
            return await asyncio.wait_for(
                self._manager.call_tool(self._tool.name, payload, headers),
                timeout=wait.seconds,
            )
        except Exception as exc:
            signal = classify_approval_gate_failure(exc, self._tool.name)
            if signal is None:
                raise
            return await self._retry_after_gate(signal, payload, headers, context, wait)

    async def _retry_after_gate(
        self,
        signal: ApprovalGateSignal,
        payload: dict[str, Any],
        headers: dict[str, str],
        context: AgentContext,
        wait: ToolWait,
    ) -> Any:
        """等待 CP 推送的用户决定，然后携 grant 头重试同一次 MCP 调用（仅一次）。

        - PLAN-0337 M2：本模块不再有本地前置审批，故不存在"重复申请本地 grant"；
        - 拒绝/过期按既有终态错误上抛；
        - 重试侧任何失败（第二次 409/403、grant 不匹配、传输错误）一律 fail-closed，
          绝不成环。
        """
        approval_tool = self._manager.approval_tool
        if approval_tool is None:
            raise ApprovalProtocolError("CP gate approval requires a local approval coordinator")
        tool_call_id = ""
        raw_id = context.metadata.get("operationItemId") if context is not None else None
        if raw_id:
            tool_call_id = str(raw_id)
        logger.info(
            "[LIFECYCLE] service=agent event=mcp_tool_gate_wait tool={} toolCallId={}"
            + " approvalRequestId={} expiresAt={}",
            self._tool.name,
            tool_call_id or "-",
            signal.request_id,
            signal.expires_at.isoformat(),
        )
        approved = await approval_tool.await_external_approval(
            signal.request_id, self._tool.name, signal.expires_at, context
        )
        if approved is not True:
            raise ApprovalTerminalError(f"Approval gate did not release: {signal.request_id}")
        retry_headers = {**headers, APPROVAL_GRANT_HEADER: signal.request_id}
        try:
            result = await asyncio.wait_for(
                self._manager.call_tool(self._tool.name, payload, retry_headers),
                timeout=wait.seconds,
            )
        except ApprovalTerminalError:
            raise
        except Exception as exc:
            # 只记录异常类型：错误体/参数原文不得入日志。
            logger.error(
                "[LIFECYCLE] service=agent event=mcp_tool_gate_retry_failed tool={} toolCallId={}"
                + " approvalRequestId={} errorType={}",
                self._tool.name,
                tool_call_id or "-",
                signal.request_id,
                type(exc).__name__,
            )
            raise ApprovalRetryFailedError(
                f"Approval gate retry failed after grant {signal.request_id}"
            ) from exc
        logger.info(
            "[LIFECYCLE] service=agent event=mcp_tool_gate_retry_ok tool={} toolCallId={}"
            + " approvalRequestId={}",
            self._tool.name,
            tool_call_id or "-",
            signal.request_id,
        )
        return result

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
