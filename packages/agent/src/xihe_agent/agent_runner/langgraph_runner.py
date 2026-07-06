"""LangGraph-based AgentRunner implementation."""

from collections.abc import AsyncIterator
from datetime import datetime
from typing import Any
from uuid import uuid4

from langchain.agents import create_agent as create_react_agent
from langchain_core.messages import (
    AIMessage,
    BaseMessage,
    HumanMessage,
    SystemMessage,
    ToolMessage,
)
from langchain_core.tools import BaseTool
from loguru import logger
from pydantic import BaseModel, create_model

from xihe_agent.interfaces.agent_runner import AgentEvent, AgentRunner, RunnerConfig
from xihe_agent.interfaces.context import AgentContext
from xihe_agent.interfaces.event import Event
from xihe_agent.interfaces.event_store import EventStore
from xihe_agent.interfaces.message import Message
from xihe_agent.interfaces.tool import BaseAgentTool, ToolSpec


def _build_args_schema(spec: ToolSpec) -> type[BaseModel]:
    """Build a Pydantic model from a JSON Schema for LangGraph."""
    schema = spec.input_schema
    if not schema or not isinstance(schema, dict):
        return BaseModel
    properties = schema.get("properties", {})
    required = set(schema.get("required", []))
    fields: dict[str, Any] = {}
    for name, prop in properties.items():
        default = ... if name in required else None
        fields[name] = (str, default)
    return create_model(f"{spec.name}Input", **fields)


class LCToolAdapter(BaseTool):
    """Wraps a `BaseAgentTool` so LangGraph can invoke it."""

    def __init__(self, tool: BaseAgentTool, context: AgentContext, event_store: EventStore | None):
        super().__init__(
            name=tool.spec.name,
            description=tool.spec.description,
            args_schema=_build_args_schema(tool.spec),
        )
        self._tool = tool
        self._context = context
        self._event_store = event_store

    async def _arun(self, **kwargs: Any) -> str:
        call_id = str(uuid4())
        await self._append_tool_called(call_id, kwargs)
        result = await self._tool.execute(kwargs, self._context)
        await self._append_tool_result(call_id, result)
        return str(result.get("content", result))

    def _run(self, **kwargs: Any) -> str:
        raise NotImplementedError("Use async run")

    async def _append_tool_called(self, call_id: str, input: dict[str, Any]) -> None:
        if self._event_store is None:
            return
        try:
            await self._event_store.append(
                Event(
                    aggregate_id=self._context.aggregate_id,
                    sequence=0,
                    type="tool.called",
                    payload={
                        "call_id": call_id,
                        "tool_name": self._tool.spec.name,
                        "tool_input": input,
                    },
                    created_at=datetime.now(datetime.UTC),
                )
            )
        except Exception as e:
            logger.warning("Failed to append tool.called event: {}", e)

    async def _append_tool_result(self, call_id: str, result: dict[str, Any]) -> None:
        if self._event_store is None:
            return
        try:
            await self._event_store.append(
                Event(
                    aggregate_id=self._context.aggregate_id,
                    sequence=0,
                    type="tool.result",
                    payload={
                        "call_id": call_id,
                        "tool_name": self._tool.spec.name,
                        "result": result,
                    },
                    created_at=datetime.now(datetime.UTC),
                )
            )
        except Exception as e:
            logger.warning("Failed to append tool.result event: {}", e)


class LangGraphRunner(AgentRunner):
    """AgentRunner backed by LangGraph `create_react_agent`."""

    def __init__(
        self,
        model_factory,
        event_store: EventStore | None = None,
    ):
        self._model_factory = model_factory
        self._event_store = event_store

    async def stream(
        self,
        messages: list[Message],
        config: RunnerConfig,
    ) -> AsyncIterator[AgentEvent]:
        context = config.context or AgentContext.empty(aggregate_id=str(uuid4()))
        await self._append_prompt_admitted(messages, context)

        model = self._model_factory(config.model)
        tools = [self._adapt_tool(t, context) for t in config.tools]

        system_messages = self._build_system_messages(config, context)
        langchain_messages = list(system_messages)
        langchain_messages.extend(_to_langchain_messages(messages))

        agent = create_react_agent(
            model,
            tools=tools,
        )

        inputs = {"messages": langchain_messages}
        seen_tool_ids: set[str] = set()

        try:
            async for raw_event in agent.astream_events(inputs, version="v2"):
                for event in self._translate_raw_event(raw_event, seen_tool_ids):
                    yield event
        except Exception as e:
            logger.error("LangGraph stream failed", exc_info=e)
            yield AgentEvent(type="error", data={"error": str(e)})

    async def create_agent(
        self,
        tools: list[BaseAgentTool],
        config: RunnerConfig,
    ) -> str:
        return str(uuid4())

    async def reset(self, agent_id: str) -> None:
        if self._event_store is None:
            return
        try:
            await self._event_store.append(
                Event(
                    aggregate_id=agent_id,
                    sequence=0,
                    type="runtime.state_cleared",
                    payload={"agent_id": agent_id, "reason": "reset"},
                    created_at=datetime.now(datetime.UTC),
                )
            )
        except Exception as e:
            logger.warning("Failed to append runtime.state_cleared event: {}", e)

    async def _append_prompt_admitted(self, messages: list[Message], context: AgentContext) -> None:
        if self._event_store is None:
            return
        for message in messages:
            try:
                await self._event_store.append(
                    Event(
                        aggregate_id=context.aggregate_id,
                        sequence=0,
                        type="prompt.admitted",
                        payload={"message": {"role": message.role, "content": message.content}},
                        created_at=datetime.now(datetime.UTC),
                    )
                )
            except Exception as e:
                logger.warning("Failed to append prompt.admitted event: {}", e)

    def _build_system_messages(
        self,
        config: RunnerConfig,
        context: AgentContext,
    ) -> list[SystemMessage]:
        messages: list[SystemMessage] = []
        if context.epoch and context.epoch.system_messages:
            for text in context.epoch.system_messages:
                messages.append(SystemMessage(content=text))
        elif config.system_prompt:
            messages.append(SystemMessage(content=config.system_prompt))
        return messages

    def _adapt_tool(self, tool: BaseAgentTool, context: AgentContext) -> BaseTool:
        return LCToolAdapter(tool, context, self._event_store)

    def _translate_raw_event(
        self,
        raw_event: dict[str, Any],
        seen_tool_ids: set[str],
    ) -> list[AgentEvent]:
        event_type = raw_event.get("event", "")
        name = raw_event.get("name", "")
        data = raw_event.get("data", {})
        run_id = raw_event.get("run_id", "")
        result: list[AgentEvent] = []

        if event_type == "on_chat_model_stream":
            chunk = data.get("chunk")
            if chunk and hasattr(chunk, "content") and chunk.content:
                result.append(AgentEvent(
                    type="token",
                    data={"content": chunk.content, "type": "token", "run_id": run_id},
                ))

        elif event_type == "on_chat_model_end":
            output = data.get("output")
            if isinstance(output, BaseMessage) and output.content:
                result.append(AgentEvent(
                    type="token",
                    data={"content": output.content, "type": "token", "run_id": run_id},
                ))

        elif event_type == "on_chain_end" and name == "LangGraph":
            result.append(AgentEvent(type="done", data={"type": "done", "run_id": run_id}))

        elif event_type == "on_tool_start":
            if run_id and run_id in seen_tool_ids:
                return result
            if run_id:
                seen_tool_ids.add(run_id)
            tool_input = data.get("input", "")
            result.append(AgentEvent(
                type="tool_call",
                data={
                    "tool": name,
                    "arguments": tool_input if isinstance(tool_input, dict) else {},
                    "type": "tool_call",
                    "run_id": run_id,
                },
            ))

        elif event_type == "on_tool_end":
            tool_output = data.get("output")
            if isinstance(tool_output, ToolMessage):
                formatted = tool_output.content
            else:
                formatted = str(tool_output or "")
            result.append(AgentEvent(
                type="tool_result",
                data={"tool": name, "result": formatted, "type": "tool_result", "run_id": run_id},
            ))

        elif event_type == "on_llm_error":
            error = data.get("error", str(data))
            result.append(AgentEvent(type="error", data={"error": str(error), "type": "error", "run_id": run_id}))

        return result


def _to_langchain_messages(messages: list[Message]) -> list[BaseMessage]:
    result: list[BaseMessage] = []
    for msg in messages:
        if msg.role == "human":
            result.append(HumanMessage(content=msg.content))
        elif msg.role == "ai":
            result.append(AIMessage(content=msg.content))
        elif msg.role == "system":
            result.append(SystemMessage(content=msg.content))
        elif msg.role == "tool":
            result.append(ToolMessage(content=msg.content, tool_call_id=""))
    return result
