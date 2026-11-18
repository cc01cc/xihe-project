"""task-188 MVP⑤ S2 (D-1821): run-scoped team-task client — the runtime wiring
that turns the four agent-side team-task tools' injected callable into real
CP logical-MCP ``tools/call`` traffic.

Gray-release seam (G3-a): the client is built ONLY when CP is explicitly
configured (``XIHE_CP_URL``). Unconfigured, or any assembly failure, leaves
``metadata[TEAM_TASK_CLIENT_KEY]` absent — the four tools then answer
``TEAM_TASK_CLIENT_UNAVAILABLE``, exactly the pre-wiring behavior.

Transport follows :mod:`xihe_agent.adapters.mcp_client`'s established call
shape: a per-call short-lived fastmcp ``Client`` over
``StreamableHttpTransport`` against ``{CP_URL}/api/v1/mcp``, dynamic headers
from ``_context_headers``, and the CP-delivered wait bound enforced by
``asyncio.wait_for``. No discovery/initialize is needed: the four faces are
CP-owned, dispatch never leaves CP.

Wire adaptation (CP structuredContent → the frozen client contract of
``team_task_tools`):
  * success create/get/update: CP returns the flat 15-field TeamTaskView row,
    the client wraps it as ``{"task": row}``;
  * success list: CP returns ``{"tasks": [...]}`` — passed through;
  * ``isError``: CP carries only ``structuredContent.code`` (spec §5 keeps
    CP internals off the wire); the client raises :class:`TeamTaskMcpError`
    carrying that code verbatim on ``.code`` — the agent-side
    ``_problem_code`` duck-typing passes it through un-reclassified.
"""

from __future__ import annotations

import asyncio
import os
from collections.abc import Mapping
from typing import Any

from loguru import logger

from xihe_agent.adapters.mcp_client import (
    MCPClientManager,
    _context_headers,
    _resolve_tool_wait,
)
from xihe_agent.adapters.team_task_tools import TeamTaskClient

# The four CP-owned faces (ToolFaceRegistry V172); the coordinator is the only
# caller and always addresses one of these names.
TEAM_TASK_TOOLS = frozenset(
    {"team_task_create", "team_task_list", "team_task_get", "team_task_update"}
)

# Fallback when CP answered isError without a usable structured code: a
# transport/protocol bug is reported as such, never fabricated into a CP code.
CODE_MCP_ERROR = "TEAM_TASK_MCP_ERROR"
CODE_PROTOCOL = "TEAM_TASK_PROTOCOL"

_MCP_PATH = "/api/v1/mcp"


class TeamTaskMcpError(RuntimeError):
    """A CP team-task refusal (or client-side protocol violation) with the code.

    Duck-typed on purpose: :func:`xihe_agent.adapters.team_task_tools._problem_code`
    reads a non-empty string ``.code`` as the CP problem carrier — CP codes
    ride through verbatim, never reclassified.
    """

    def __init__(self, code: str, detail: str = "") -> None:
        self.code = code
        super().__init__(detail or code)


def resolve_team_task_mcp_url(environ: Mapping[str, str] | None = None) -> str | None:
    """The gray-release gate: wired only when CP is explicitly configured.

    ``XIHE_CP_URL`` absent/empty ⇒ ``None`` ⇒ the runner does not inject —
    the un-wired answer (TEAM_TASK_CLIENT_UNAVAILABLE) is today's behavior.
    The localhost default that :mod:`xihe_agent.app_state` applies for other
    mouths is deliberately NOT adopted here: an implicit endpoint would turn
    the four tools from "pure gain" into "surprise transport errors" on every
    host that never configured CP (G3-a 灰度判据).
    """
    env = os.environ if environ is None else environ
    raw = (env.get("XIHE_CP_URL") or "").strip()
    if not raw:
        return None
    return raw.rstrip("/") + _MCP_PATH


def _resolve_api_token() -> str | None:
    """服务鉴权令牌的单属主是 app_state（懒加载避免模块导入环与测试副作用）。"""
    from xihe_agent.app_state import CP_API_TOKEN

    return CP_API_TOKEN


def _error_text(result: Any) -> str:
    blocks = getattr(result, "content", None) or []
    parts = [getattr(block, "text", "") for block in blocks]
    return "\n".join(part for part in parts if part)


def _unwrap_result(tool: str, result: Any) -> dict[str, Any]:
    """fastmcp CallToolResult → the frozen client contract dict (or raise)."""
    if getattr(result, "is_error", False):
        structured = getattr(result, "structured_content", None)
        code = structured.get("code") if isinstance(structured, Mapping) else None
        if not isinstance(code, str) or not code:
            logger.warning(
                "[LIFECYCLE] service=agent event=team_task_mcp_error_without_code tool={}",
                tool,
            )
            code = CODE_MCP_ERROR
        raise TeamTaskMcpError(code, _error_text(result))
    structured = getattr(result, "structured_content", None)
    if not isinstance(structured, Mapping):
        # CP's team-task faces are STRUCTURED shape — a missing structuredContent
        # is a protocol violation on this hop, reported as our own code.
        raise TeamTaskMcpError(
            CODE_PROTOCOL, f"{tool} returned no structuredContent (CP wire shape changed?)"
        )
    if tool == "team_task_list":
        tasks = structured.get("tasks")
        if not isinstance(tasks, list):
            raise TeamTaskMcpError(CODE_PROTOCOL, f"{tool} structuredContent.tasks is not an array")
        return {"tasks": list(tasks)}
    # create/get/update: CP's canonical TeamTaskView row arrives flat — wrap it.
    return {"task": dict(structured)}


def build_team_task_client(
    context: Any,
    *,
    environ: Mapping[str, str] | None = None,
    api_token: str | None = None,
) -> TeamTaskClient | None:
    """Build the run-scoped team-task client callable; ``None` = stay gray.

    The returned closure binds the run's ``context`` by reference, so the
    per-call identity headers (``X-Session-Id` / ``X-Chat-Run-Id` /
    ``X-Tool-Call-Id``) are read at call time — ``toolCallId`` rotates with
    every tool invocation. ``api_token=None` resolves the process token from
    its single owner (``app_state.CP_API_TOKEN``) lazily.
    """
    mcp_url = resolve_team_task_mcp_url(environ)
    if mcp_url is None:
        return None
    if api_token is None:
        api_token = _resolve_api_token()
    workspace_id = None
    if context is not None:
        raw_ws = context.metadata.get("workspaceId")
        if raw_ws:
            workspace_id = str(raw_ws)
    manager = MCPClientManager(
        cp_url=mcp_url,
        server_name="cp",
        workspace_id=workspace_id,
        api_token=api_token,
    )

    async def client(tool: str, arguments: dict[str, Any]) -> dict[str, Any]:
        payload = dict(arguments) if isinstance(arguments, Mapping) else {}
        headers = _context_headers(context, tool, payload)
        wait = _resolve_tool_wait(tool, context)
        logger.info(
            "[LIFECYCLE] service=agent event=team_task_mcp_call tool={} toolCallId={} waitS={} source={}",
            tool,
            wait.tool_call_id or "-",
            wait.seconds,
            wait.source,
        )
        result = await asyncio.wait_for(
            manager.call_tool(tool, payload, headers),
            timeout=wait.seconds,
        )
        return _unwrap_result(tool, result)

    return client
