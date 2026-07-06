"""Agent module public interfaces.

This package defines the abstraction layer introduced by PLAN-033 and PLAN-035.
All concrete LangChain / LangGraph types should stay behind these interfaces.
"""

from xihe_agent.interfaces.agent_runner import AgentEvent, AgentRunner, RunnerConfig
from xihe_agent.interfaces.event import Event, EventType
from xihe_agent.interfaces.event_adapter import EventAdapter
from xihe_agent.interfaces.event_store import EventStore
from xihe_agent.interfaces.llm import LLMProvider
from xihe_agent.interfaces.message import Message, MessageRole
from xihe_agent.interfaces.tool import BaseAgentTool, ToolSpec

__all__ = [
    "AgentEvent",
    "AgentRunner",
    "BaseAgentTool",
    "Event",
    "EventAdapter",
    "EventStore",
    "EventType",
    "LLMProvider",
    "Message",
    "MessageRole",
    "RunnerConfig",
    "ToolSpec",
]
