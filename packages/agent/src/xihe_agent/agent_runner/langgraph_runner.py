"""LangGraph-based AgentRunner implementation."""

import asyncio
from collections.abc import AsyncIterator
from datetime import UTC, datetime
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

from xihe_agent.adapters.approval_tool import APPROVAL_EVENT_SINK_KEY, ApprovalTerminalError
from xihe_agent.adapters.sse_adapter import LangGraphEventAdapter
from xihe_agent.interfaces.agent_runner import AgentEvent, AgentRunner, RunnerConfig
from xihe_agent.interfaces.context import AgentContext
from xihe_agent.interfaces.event import Event
from xihe_agent.interfaces.event_adapter import EventAdapter
from xihe_agent.interfaces.event_store import EventStore
from xihe_agent.interfaces.message import Message, TextMessage
from xihe_agent.interfaces.tool import BaseAgentTool, ToolSpec
from xihe_agent.interfaces.usage import RunUsage

# PLAN-294 decision #8: assembly-layer backstop. The projection snapshot may
# exceed the target window before auto-compaction has ever run; truncate to
# the most recent N historical messages (plus the current turn) so a single
# request cannot blow the window. Normal sessions never hit this — compaction
# is the real governance; this is the fuse.
HISTORY_TRUNCATION_LIMIT = 20


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
        previous_item_id = self._context.metadata.get("operationItemId")
        self._context.metadata["operationItemId"] = call_id
        try:
            result = await self._tool.execute(kwargs, self._context)
            await self._append_tool_result(call_id, result)
            return str(result.get("content", result))
        finally:
            if previous_item_id is None:
                self._context.metadata.pop("operationItemId", None)
            else:
                self._context.metadata["operationItemId"] = previous_item_id

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
                        "operation_id": self._context.metadata.get("operationId"),
                        "operation_item_id": call_id,
                    },
                    created_at=datetime.now(UTC),
                )
            )
        except ApprovalTerminalError:
            raise
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
                        "operation_id": self._context.metadata.get("operationId"),
                        "operation_item_id": call_id,
                    },
                    created_at=datetime.now(UTC),
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
        event_adapter: EventAdapter | None = None,
    ):
        self._model_factory = model_factory
        self._event_store = event_store
        self._event_adapter = event_adapter or LangGraphEventAdapter()

    async def stream(
        self,
        messages: list[Message],
        config: RunnerConfig,
    ) -> AsyncIterator[AgentEvent]:
        context = config.context or AgentContext.empty(aggregate_id=str(uuid4()))
        await self._append_prompt_admitted(messages, context)

        usage = RunUsage()
        approval_events: asyncio.Queue[AgentEvent] = asyncio.Queue()

        async def publish_approval(payload: dict[str, Any]) -> None:
            await approval_events.put(AgentEvent(type="approval_request", data=payload))

        context.metadata[APPROVAL_EVENT_SINK_KEY] = publish_approval

        model = self._model_factory(config.model)
        tools = [self._adapt_tool(t, context) for t in config.tools]

        # PLAN-294 M1 (decision #1): the projection snapshot is the canonical
        # conversation history (compaction already applied by CP). The caller's
        # `messages` list carries only the current turn's prompt; historical
        # turns come from the snapshot so multi-turn context reaches the LLM.
        history = context.messages
        if len(history) > HISTORY_TRUNCATION_LIMIT:
            history = history[-HISTORY_TRUNCATION_LIMIT:]
        assembled = [*history, *messages]

        system_messages = self._build_system_messages(config, context)
        langchain_messages = list(system_messages)
        langchain_messages.extend(_to_langchain_messages(assembled))

        agent = create_react_agent(
            model,
            tools=tools,
        )

        inputs = {"messages": langchain_messages}
        seen_tool_ids: set[str] = set()
        cancel_event = config.cancel_event
        cancelled = False
        assistant_parts: list[str] = []

        try:
            raw_stream = agent.astream_events(inputs, version="v2").__aiter__()
            raw_task = asyncio.create_task(raw_stream.__anext__())
            approval_task = asyncio.create_task(approval_events.get())
            cancel_wait_task: asyncio.Task[bool] | None = (
                asyncio.create_task(cancel_event.wait()) if cancel_event is not None else None
            )
            try:
                while True:
                    wait_set: set[asyncio.Task[Any]] = {raw_task, approval_task}
                    if cancel_wait_task is not None:
                        wait_set.add(cancel_wait_task)
                    completed, _ = await asyncio.wait(
                        wait_set,
                        return_when=asyncio.FIRST_COMPLETED,
                    )
                    # PLAN-290 M0.3: cancel wins over in-flight tokens/tools so a
                    # hung MCP tool or stream cannot keep the run alive.
                    if cancel_wait_task is not None and cancel_wait_task in completed:
                        cancelled = True
                        logger.info("LangGraph stream cancelled via cancel_event")
                        break
                    if approval_task in completed:
                        yield approval_task.result()
                        approval_task = asyncio.create_task(approval_events.get())
                    if raw_task in completed:
                        try:
                            raw_event = raw_task.result()
                        except StopAsyncIteration:
                            break
                        for event in self._translate_raw_event(raw_event, seen_tool_ids, usage):
                            if event.type == "token" and event.data.get("hint") != "reasoning":
                                content = event.data.get("content")
                                if isinstance(content, str):
                                    assistant_parts.append(content)
                            yield event
                        raw_task = asyncio.create_task(raw_stream.__anext__())
            finally:
                for task in (raw_task, approval_task, cancel_wait_task):
                    if task is not None and not task.done():
                        task.cancel()
                await asyncio.gather(raw_task, approval_task, return_exceptions=True)
                if cancel_wait_task is not None:
                    await asyncio.gather(cancel_wait_task, return_exceptions=True)
                aclose = getattr(raw_stream, "aclose", None)
                if aclose is not None:
                    await aclose()
        except ApprovalTerminalError as e:
            # Approval gate terminations (rejected/expired) are structured
            # terminal outcomes, not stream failures: propagate the code so the
            # SSE relay can emit error(APPROVAL_REJECTED|APPROVAL_EXPIRED).
            logger.info("LangGraph stream terminated by approval gate: code={}", e.code)
            yield AgentEvent(type="error", data={"error": str(e), "code": e.code})
        except Exception as e:
            logger.error("LangGraph stream failed", exc_info=e)
            yield AgentEvent(type="error", data={"error": str(e)})
        finally:
            context.metadata.pop(APPROVAL_EVENT_SINK_KEY, None)
            usage.finish()
            # PLAN-294 M1 (decisions #2/#6): persist the assistant reply into
            # the context event store — the UI-facing messages table (CP side)
            # and the event-sourced projection must share the same history.
            # Only successful, non-cancelled runs carry a durable reply.
            if not cancelled and assistant_parts and self._event_store is not None:
                try:
                    await self._event_store.append(
                        Event(
                            aggregate_id=context.aggregate_id,
                            sequence=0,
                            type="assistant.responded",
                            payload={
                                "message": {"role": "ai", "content": "".join(assistant_parts)},
                                "runId": context.metadata.get("runId"),
                            },
                            created_at=datetime.now(UTC),
                        )
                    )
                except Exception as e:
                    logger.warning("Failed to append assistant.responded event: {}", e)
            if cancelled:
                yield AgentEvent(
                    type="error",
                    data={"error": "Run cancelled", "code": "cancelled"},
                )
            yield AgentEvent(type="usage", data=usage.to_event_payload())

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
                    created_at=datetime.now(UTC),
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
                        created_at=datetime.now(UTC),
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
        usage: RunUsage | None = None,
    ) -> list[AgentEvent]:
        translated = self._event_adapter.translate(raw_event)
        if translated is None:
            return []
        events = [translated] if isinstance(translated, AgentEvent) else translated

        # Track usage from events
        if usage:
            for event in events:
                if event.type == "tool_call":
                    usage.record_tool_call()
                elif event.type == "tool_result":
                    usage.record_tool_result()
                elif event.type == "token":
                    usage.record_turn()
                elif event.type == "llm_usage":
                    # PLAN-294 decisions #13/#14: provider-reported counts are
                    # aggregated across model turns; the newest value wins for
                    # source tagging (a run is single-model per request).
                    usage.record_llm_usage(
                        input_tokens=event.data.get("inputTokens", 0),
                        output_tokens=event.data.get("outputTokens", 0),
                    )
                    usage.source = str(event.data.get("source", "real"))

        # Dedup parallel tool calls (DESIGN-013)
        result: list[AgentEvent] = []
        for event in events:
            if event.type == "tool_call":
                run_id = event.data.get("run_id", "")
                if run_id and run_id in seen_tool_ids:
                    continue
                if run_id:
                    seen_tool_ids.add(run_id)
            result.append(event)
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
