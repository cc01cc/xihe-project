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
    name: str,
    system_prompt: str,
) -> Any:
    """Create a named ReAct agent graph; failure returns ``None`` (frozen)."""
    logger.debug("Building graph for '%s' with %d tool(s)", name, len(tools))
    try:
        return create_react_agent(
            model,
            tools=tools,
            name=name,
            system_prompt=system_prompt,
        )
    except Exception as e:
        logger.error("Failed to create graph for worker '%s': %s", name, e, exc_info=True)
        return None
