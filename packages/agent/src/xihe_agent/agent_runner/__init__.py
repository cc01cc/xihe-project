"""Agent runner implementations with lazy heavy-runtime exports."""

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from xihe_agent.agent_runner.langgraph_runner import LangGraphRunner


def __getattr__(name: str):
    if name == "LangGraphRunner":
        from xihe_agent.agent_runner.langgraph_runner import LangGraphRunner

        return LangGraphRunner
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")

__all__ = ["LangGraphRunner"]
