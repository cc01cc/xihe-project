import asyncio
from collections.abc import AsyncIterator
from datetime import date
from typing import Any

from langchain.agents import create_agent as create_react_agent
from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import BaseMessage, HumanMessage, SystemMessage
from langchain_core.tools import BaseTool
from loguru import logger

from xihe_agent.agent.prompts import XIHE_SYSTEM_PROMPT

DEFAULT_MAX_ITERATIONS = 4
DEFAULT_RETRY_COUNT = 3
DEFAULT_RETRY_DELAY = 1.0

# Track seen tool_call IDs for dedup across events
_seen_tool_ids: set[str] = set()


def format_system_message(user_name: str = "User", instructions: str = "") -> SystemMessage:
    return SystemMessage(
        content=XIHE_SYSTEM_PROMPT.format(
            user_name=user_name,
            current_date=date.today().isoformat(),
            instructions=instructions or "xihe Agent Framework",
        )
    )


def reset_dedup() -> None:
    """Reset the dedup set for a new conversation."""
    _seen_tool_ids.clear()


def is_tool_call_duplicate(tool_call_id: str) -> bool:
    """Check if a tool_call_id has already been processed."""
    if tool_call_id in _seen_tool_ids:
        return True
    _seen_tool_ids.add(tool_call_id)
    return False


async def stream_agent_events(
    model: BaseChatModel,
    tools: list[BaseTool],
    input_text: str,
    chat_history: list[BaseMessage] | None = None,
    user_name: str = "User",
    instructions: str = "",
    max_iterations: int = DEFAULT_MAX_ITERATIONS,
    retry_count: int = DEFAULT_RETRY_COUNT,
) -> AsyncIterator[dict[str, Any]]:
    system_message = format_system_message(user_name=user_name, instructions=instructions)

    agent = create_react_agent(
        model,
        tools=tools,
        system_prompt=system_message,
    )

    msgs: list[BaseMessage] = list(chat_history or [])
    msgs.append(HumanMessage(content=input_text))
    inputs: dict[str, Any] = {"messages": msgs}

    reset_dedup()
    last_error: Exception | None = None

    for attempt in range(retry_count):
        try:
            async for event in agent.astream_events(
                inputs,
                version="v2",
            ):
                # Dedup parallel tool calls (DESIGN-013)
                if event.get("event") == "on_tool_start":
                    tool_call_id = event.get("run_id", "")
                    if tool_call_id and is_tool_call_duplicate(tool_call_id):
                        continue

                yield event
            return  # Success, exit retry loop
        except Exception as e:
            last_error = e
            if attempt < retry_count - 1:
                delay = DEFAULT_RETRY_DELAY * (2 ** attempt)
                logger.warning("Agent stream failed (attempt %d/%d), retrying in %.1fs: %s",
                               attempt + 1, retry_count, delay, e)
                await asyncio.sleep(delay)
            else:
                logger.error("Agent stream failed after %d attempts", retry_count, exc_info=e)

    if last_error:
        raise last_error
