import json
from collections.abc import AsyncIterator
from typing import Any

from langchain_core.messages import BaseMessage, ToolMessage

from xihe_agent.interfaces.agent_runner import AgentEvent
from xihe_agent.interfaces.event_adapter import EventAdapter

FINAL_CHAIN_NAME = "LangGraph"


def render_sse(event: str, data: dict[str, Any]) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


class LangGraphEventAdapter(EventAdapter):
    """Translates LangGraph `astream_events` payloads into `AgentEvent`."""

    def __init__(self) -> None:
        self._streamed_runs: set[str] = set()

    def translate(self, raw_event: dict[str, Any]) -> AgentEvent | list[AgentEvent] | None:
        event_type = raw_event.get("event", "")
        name = raw_event.get("name", "")
        data = raw_event.get("data", {})
        run_id = raw_event.get("run_id", "")

        if event_type == "on_chat_model_stream":
            chunk = data.get("chunk")
            if chunk is None:
                return None
            if hasattr(chunk, "content") and chunk.content:
                event_data: dict[str, Any] = {
                    "content": chunk.content,
                    "type": "token",
                    "run_id": run_id,
                }
                if hasattr(chunk, "response_metadata") and chunk.response_metadata:
                    reasoning = chunk.response_metadata.get("reasoning_content")
                    if reasoning:
                        event_data["hint"] = "reasoning"
                if run_id:
                    self._streamed_runs.add(run_id)
                return AgentEvent(type="token", data=event_data)

        if event_type == "on_chat_model_end":
            streamed = bool(run_id and run_id in self._streamed_runs)
            if run_id:
                self._streamed_runs.discard(run_id)
            if streamed:
                return None
            output = data.get("output")
            if isinstance(output, BaseMessage):
                content = output.content or ""
                if content:
                    return AgentEvent(
                        type="token",
                        data={"content": content, "type": "token", "run_id": run_id},
                    )

        if event_type == "on_chain_end" and name == FINAL_CHAIN_NAME:
            return AgentEvent(type="done", data={"type": "done", "run_id": run_id})

        if event_type == "on_tool_start":
            tool_input = data.get("input", "")
            return AgentEvent(
                type="tool_call",
                data={
                    "tool": name,
                    "arguments": tool_input if isinstance(tool_input, dict) else {},
                    "type": "tool_call",
                    "run_id": run_id,
                },
            )

        if event_type == "on_tool_end":
            tool_output = data.get("output")
            if isinstance(tool_output, ToolMessage):
                formatted = tool_output.content
            else:
                formatted = str(tool_output or "")
            return AgentEvent(
                type="tool_result",
                data={"tool": name, "result": formatted, "type": "tool_result", "run_id": run_id},
            )

        if event_type == "on_llm_error":
            error = data.get("error", str(data))
            return AgentEvent(type="error", data={"error": str(error), "type": "error", "run_id": run_id})

        return None


async def translate_events(
    raw_stream: AsyncIterator[dict[str, Any]],
) -> AsyncIterator[str]:
    adapter = LangGraphEventAdapter()
    async for raw_event in raw_stream:
        translated = adapter.translate(raw_event)
        if translated is None:
            continue
        events = [translated] if isinstance(translated, AgentEvent) else translated
        for event in events:
            yield render_sse(event.type, event.data)
