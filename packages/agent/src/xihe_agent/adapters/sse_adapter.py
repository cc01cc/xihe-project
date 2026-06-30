import json
from collections.abc import AsyncIterator
from typing import Any

from langchain_core.messages import BaseMessage, ToolMessage

FINAL_CHAIN_NAME = "LangGraph"


def render_sse(event: str, data: dict[str, Any]) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


async def translate_events(
    raw_stream: AsyncIterator[dict[str, Any]],
) -> AsyncIterator[str]:
    async for event in raw_stream:
        event_type = event.get("event", "")
        name = event.get("name", "")
        data = event.get("data", {})
        run_id = event.get("run_id", "")

        if event_type == "on_chat_model_stream":
            chunk = data.get("chunk")
            if chunk is None:
                continue
            if hasattr(chunk, "content") and chunk.content:
                yield render_sse(
                    "token",
                    {"content": chunk.content, "type": "token", "run_id": run_id},
                )

        elif event_type == "on_chat_model_end":
            output = data.get("output")
            if isinstance(output, BaseMessage):
                content = output.content or ""
                if content:
                    yield render_sse(
                        "token",
                        {"content": content, "type": "token", "run_id": run_id},
                    )

        elif event_type == "on_chain_end" and name == FINAL_CHAIN_NAME:
            yield render_sse("done", {"type": "done", "run_id": run_id})

        elif event_type == "on_tool_start":
            tool_input = data.get("input", "")
            yield render_sse(
                "tool_exec_started",
                {
                    "tool": name,
                    "arguments": tool_input if isinstance(tool_input, dict) else {},
                    "type": "tool_exec_started",
                    "run_id": run_id,
                },
            )

        elif event_type == "on_tool_end":
            tool_output = data.get("output")
            if isinstance(tool_output, ToolMessage):
                formatted = tool_output.content
            else:
                formatted = str(tool_output or "")
            yield render_sse(
                "tool_exec_done",
                {
                    "tool": name,
                    "result": formatted,
                    "type": "tool_exec_done",
                    "run_id": run_id,
                },
            )

        elif event_type == "on_llm_error":
            error = data.get("error", str(data))
            yield render_sse(
                "error",
                {"error": str(error), "type": "error", "run_id": run_id},
            )
