import asyncio
from collections.abc import AsyncIterator
from datetime import date

from langchain_core.messages import SystemMessage
from loguru import logger

from xihe_agent.agent.prompts import XIHE_SYSTEM_PROMPT
from xihe_agent.interfaces.agent_runner import AgentEvent, AgentRunner, RunnerConfig
from xihe_agent.interfaces.message import Message, TextMessage

DEFAULT_MAX_ITERATIONS = 4
DEFAULT_RETRY_COUNT = 3
DEFAULT_RETRY_DELAY = 1.0


def format_system_message(user_name: str = "User", instructions: str = "") -> SystemMessage:
    return SystemMessage(
        content=XIHE_SYSTEM_PROMPT.format(
            user_name=user_name,
            current_date=date.today().isoformat(),
            instructions=instructions or "xihe Agent Framework",
        )
    )


async def stream_agent_events(
    runner: AgentRunner,
    config: RunnerConfig,
    input_text: str,
    chat_history: list[Message] | None = None,
    retry_count: int = DEFAULT_RETRY_COUNT,
    retry_delay: float = DEFAULT_RETRY_DELAY,
) -> AsyncIterator[AgentEvent]:
    """Stream AgentEvents through an AgentRunner (PLAN-033 abstraction)."""
    messages: list[Message] = list(chat_history or [])
    messages.append(TextMessage(role="human", content=input_text))

    last_error: Exception | None = None
    for attempt in range(retry_count):
        try:
            async for event in runner.stream(messages, config):
                yield event
            return
        except Exception as e:
            last_error = e
            if attempt < retry_count - 1:
                delay = retry_delay * (2 ** attempt)
                logger.warning("Agent stream failed (attempt %d/%d), retrying in %.1fs: %s",
                               attempt + 1, retry_count, delay, e)
                await asyncio.sleep(delay)
            else:
                logger.error("Agent stream failed after %d attempts", retry_count, exc_info=e)

    if last_error:
        raise last_error
