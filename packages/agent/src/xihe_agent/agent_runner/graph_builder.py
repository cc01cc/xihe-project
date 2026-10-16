"""Shared LangGraph graph builders.

PLAN-0473 M1 (spec/agent-module-boundaries.md): direct `create_react_agent`
calls are centralized here; `registry.py` and `supervisor.py` build their
graphs through this module. Behavior is moved verbatim (failure → None,
same tool adaptation).
"""

from typing import Any

from langchain.agents import create_agent as create_react_agent
from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.tools import BaseTool
from loguru import logger

from xihe_agent.adapters.mcp_client import MCPAgentTool
from xihe_agent.agent_runner.tool_adapter import LCToolAdapter
from xihe_agent.interfaces.context import AgentContext
from xihe_agent.interfaces.tool import BaseAgentTool


def adapt_agent_tools(tools: list[BaseAgentTool]) -> list[BaseTool]:
    """Adapt ``BaseAgentTool`` instances to LangChain ``BaseTool`` for create_react_agent."""
    adapted: list[BaseTool] = []
    for tool in tools:
        if isinstance(tool, MCPAgentTool):
            adapted.append(tool.base_tool)
        elif isinstance(tool, BaseTool):
            adapted.append(tool)
        else:
            adapted.append(LCToolAdapter(tool, AgentContext.empty(""), None))
    return adapted


def build_react_graph(
    model: BaseChatModel,
    tools: list[BaseTool],
    *,
    name: str | None = None,
    system_prompt: str | None = None,
    checkpointer: Any | None = None,
) -> Any:
    """Create a ReAct agent graph; failure returns ``None`` (frozen).

    ``name`` / ``system_prompt`` are optional so the chat runner can keep
    passing its system messages through ``inputs`` (PLAN-0492 T1.2 routes
    the runner through this module without changing graph behavior).
    """
    logger.debug("Building graph for '%s' with %d tool(s)", name or "<unnamed>", len(tools))
    kwargs: dict[str, Any] = {}
    if name is not None:
        kwargs["name"] = name
    if system_prompt is not None:
        kwargs["system_prompt"] = system_prompt
    if checkpointer is not None:
        kwargs["checkpointer"] = checkpointer
    try:
        return create_react_agent(
            model,
            tools=tools,
            **kwargs,
        )
    except Exception as e:
        logger.error("Failed to create graph for worker '%s': %s", name or "<unnamed>", e, exc_info=True)
        return None
