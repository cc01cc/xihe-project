"""LangChain adapter consuming a rendered API body without rebuilding it."""

from __future__ import annotations

import copy
import json
from collections.abc import AsyncIterator, Sequence
from typing import Any, cast

from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessage, AIMessageChunk, BaseMessage, HumanMessage, SystemMessage, ToolMessage
from langchain_core.messages.ai import UsageMetadata
from langchain_core.outputs import ChatGeneration, ChatGenerationChunk, ChatResult
from pydantic import PrivateAttr

from xihe_agent.interfaces.message import Message
from xihe_agent.interfaces.tool import BaseAgentTool
from xihe_agent.llm.api_request import ApiRequestError, ChatApiType, render_request
from xihe_agent.llm.api_sender import ApiSender, NativeResponse


def native_tools(tools: Sequence[BaseAgentTool], api_type: ChatApiType) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    for tool in tools:
        spec = tool.spec
        function = {"name": spec.name, "description": spec.description, "parameters": copy.deepcopy(spec.input_schema)}
        if api_type.id == "anthropic-messages":
            result.append(
                {"name": spec.name, "description": spec.description, "input_schema": copy.deepcopy(spec.input_schema)}
            )
        elif api_type.id == "mimo-responses":
            result.append({"type": "function", **function, "strict": False})
        else:
            result.append({"type": "function", "function": function})
    return result


def native_message(message: BaseMessage, api_type: ChatApiType) -> list[dict[str, Any]]:
    if isinstance(message, AIMessage):
        preserved = message.additional_kwargs.get("nativeRecords")
        if isinstance(preserved, list):
            if (
                message.additional_kwargs.get("apiTypeId") != api_type.id
                or message.additional_kwargs.get("apiTypeVersion") != api_type.version
            ):
                raise ApiRequestError("API_TYPE_TEMPLATE_MISMATCH", 409)
            return copy.deepcopy(preserved)
        calls = message.tool_calls
        if api_type.id == "anthropic-messages":
            blocks: list[dict[str, Any]] = [{"type": "text", "text": message.content}] if message.content else []
            blocks.extend(
                {"type": "tool_use", "id": call["id"], "name": call["name"], "input": call["args"]} for call in calls
            )
            return [{"role": "assistant", "content": blocks}]
        if api_type.id == "mimo-responses":
            result: list[dict[str, Any]] = (
                [
                    {
                        "type": "message",
                        "role": "assistant",
                        "content": [{"type": "output_text", "text": message.content}],
                    }
                ]
                if message.content
                else []
            )
            result.extend(
                {
                    "type": "function_call",
                    "call_id": call["id"],
                    "name": call["name"],
                    "arguments": json.dumps(call["args"], ensure_ascii=False),
                }
                for call in calls
            )
            return result
        entry: dict[str, Any] = {"role": "assistant", "content": message.content or None}
        if calls:
            entry["tool_calls"] = [
                {
                    "type": "function",
                    "id": call["id"],
                    "function": {"name": call["name"], "arguments": json.dumps(call["args"], ensure_ascii=False)},
                }
                for call in calls
            ]
        return [entry]
    if isinstance(message, ToolMessage):
        if api_type.id == "anthropic-messages":
            return [
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "tool_result",
                            "tool_use_id": message.tool_call_id,
                            "content": message.content,
                            "is_error": message.status == "error",
                        }
                    ],
                }
            ]
        if api_type.id == "mimo-responses":
            return [{"type": "function_call_output", "call_id": message.tool_call_id, "output": message.content}]
        return [{"role": "tool", "tool_call_id": message.tool_call_id, "content": message.content}]
    role = "user" if isinstance(message, HumanMessage) else "system"
    if api_type.id == "anthropic-messages" and isinstance(message, SystemMessage):
        # Anthropic has no system role in messages. Historical system facts are
        # data inside a user block, not a newly granted system instruction.
        return [{"role": "user", "content": [{"type": "text", "text": str(message.content)}]}]
    return [{"role": role, "content": message.content}]


def native_history(messages: Sequence[Message], api_type: ChatApiType) -> list[dict[str, Any]]:
    # Reuse existing durable pairing/missing-result rules only for history;
    # the template-authored request body never passes through this converter.
    from xihe_agent.agent_runner.langgraph_runner import to_langchain_messages

    result: list[dict[str, Any]] = []
    pending: list[Message] = []

    def flush() -> None:
        result.extend(
            record for message in to_langchain_messages(pending) for record in native_message(message, api_type)
        )
        pending.clear()

    for message in messages:
        records = getattr(message, "native_records", None)
        if records is None:
            pending.append(message)
            continue
        flush()
        if (
            getattr(message, "api_type_id", "") != api_type.id
            or getattr(message, "api_type_version", None) != api_type.version
        ):
            raise ApiRequestError("API_TYPE_TEMPLATE_MISMATCH", 409)
        result.extend(copy.deepcopy(records))
    flush()
    return result


def durable_native_carrier(model: ApiChatModel, limit: int) -> dict[str, Any]:
    """Bound only tool payloads; signatures and reasoning remain exact."""
    from xihe_agent.agent_runner.tool_adapter import bound_tool_preview
    from xihe_agent.interfaces.context import bound_tool_arguments, compact_json
    from xihe_agent.llm.api_request import strict_json

    records = model.native_records
    for record in records:
        if model.api_type.id == "openai-chat-completions":
            for call in record.get("tool_calls", []):
                function = call["function"]
                function["arguments"] = compact_json(bound_tool_arguments(strict_json(function["arguments"])))
            if record.get("role") == "tool":
                record["content"], _ = bound_tool_preview(str(record.get("content", "")), None)
        elif model.api_type.id == "anthropic-messages":
            for block in record.get("content", []):
                if not isinstance(block, dict):
                    continue
                if block.get("type") == "tool_use":
                    block["input"] = bound_tool_arguments(block.get("input"))
                elif block.get("type") == "tool_result":
                    block["content"], _ = bound_tool_preview(str(block.get("content", "")), None)
        else:
            if record.get("type") == "function_call":
                record["arguments"] = compact_json(bound_tool_arguments(strict_json(record["arguments"])))
            elif record.get("type") == "function_call_output":
                record["output"], _ = bound_tool_preview(str(record.get("output", "")), None)
    carrier = {"apiTypeId": model.api_type.id, "apiTypeVersion": model.api_type.version, "nativeRecords": records}
    if len(compact_json(carrier)) > limit:
        raise ApiRequestError("CONTEXT_BUILD_FAILED")
    return carrier


class ApiChatModel(BaseChatModel):
    """One per Run; the redeemed grant and rendered base stay in memory only."""

    _api_type: ChatApiType = PrivateAttr()
    _sender: ApiSender = PrivateAttr()
    _base: dict[str, Any] = PrivateAttr()
    _initial_count: int | None = PrivateAttr(default=None)
    _tool_names: set[str] = PrivateAttr(default_factory=set)
    _native_turns: list[dict[str, Any]] = PrivateAttr(default_factory=list)
    _current_suffix: list[dict[str, Any]] = PrivateAttr(default_factory=list)

    def __init__(
        self,
        *,
        api_type: ChatApiType,
        grant: dict[str, Any],
        body_source: str,
        values: dict[str, Any],
        request_id: str,
        timeout: float,
    ):
        super().__init__(cache=False)
        self._api_type = api_type
        self._sender = ApiSender(api_type, grant, request_id, timeout)
        self._base = render_request(body_source, api_type, values)
        self._tool_names = {
            str(tool.get("function", tool).get("name"))
            for tool in self._base.get("tools", [])
            if isinstance(tool, dict)
        }

    @property
    def native_records(self) -> list[dict[str, Any]]:
        return copy.deepcopy(self._native_turns)

    @property
    def api_type(self) -> ChatApiType:
        return self._api_type

    @property
    def _llm_type(self) -> str:
        return "xihe-api-request"

    def bind_tools(self, tools: Sequence[Any], *, tool_choice: Any = None, **kwargs: Any) -> ApiChatModel:
        # Tools were rendered from CP-authorized ToolSpecs. LangChain binding
        # must never overwrite the template or grant additional definitions.
        names = {tool.name for tool in tools if hasattr(tool, "name")}
        if not self._tool_names.issubset(names):
            raise ApiRequestError("RUNTIME_FIELD_CONFLICT")
        return self

    def _body(self, messages: list[BaseMessage]) -> dict[str, Any]:
        if self._initial_count is None:
            self._initial_count = len(messages)
        if len(messages) < self._initial_count:
            raise ApiRequestError("INVALID_REQUEST_SHAPE")
        body = copy.deepcopy(self._base)
        suffix = messages[self._initial_count :]
        if any(not isinstance(message, (AIMessage, ToolMessage)) for message in suffix):
            raise ApiRequestError("INVALID_REQUEST_SHAPE")
        self._current_suffix = [record for message in suffix for record in native_message(message, self._api_type)]
        body[self._api_type.input_field].extend(copy.deepcopy(self._current_suffix))
        return body

    def _check_response(self, response: NativeResponse) -> None:
        if any(call["name"] not in self._tool_names for call in response.calls):
            raise ApiRequestError("TOOL_NOT_AUTHORIZED", 403)
        self._native_turns = copy.deepcopy([*self._current_suffix, *response.records])

    def _generate(
        self, messages: list[BaseMessage], stop: list[str] | None = None, run_manager: Any = None, **kwargs: Any
    ) -> ChatResult:
        raise ApiRequestError("ASYNC_CHAT_REQUIRED")

    async def _agenerate(
        self, messages: list[BaseMessage], stop: list[str] | None = None, run_manager: Any = None, **kwargs: Any
    ) -> ChatResult:
        result = None
        async for _text, _reasoning, final in self._sender.stream(self._body(messages)):
            if final is not None:
                result = final
        if result is None:
            raise ApiRequestError("LLM_PROVIDER_INVALID_RESPONSE", 502)
        self._check_response(result)
        message = AIMessage(
            content=result.text,
            tool_calls=result.calls,
            usage_metadata=cast(UsageMetadata, result.usage),
            additional_kwargs={
                "nativeRecords": result.records,
                "apiTypeId": self._api_type.id,
                "apiTypeVersion": self._api_type.version,
            },
        )
        return ChatResult(generations=[ChatGeneration(message=message)])

    async def _astream(
        self, messages: list[BaseMessage], stop: list[str] | None = None, run_manager: Any = None, **kwargs: Any
    ) -> AsyncIterator[ChatGenerationChunk]:
        async for text, reasoning, result in self._sender.stream(self._body(messages)):
            if text or reasoning:
                yield ChatGenerationChunk(
                    message=AIMessageChunk(
                        content=text or reasoning,
                        response_metadata={"reasoning_content": reasoning} if reasoning else {},
                    )
                )
            if result is not None:
                self._check_response(result)
                # Native records include thinking/signature/reasoning and provider
                # IDs. One final chunk supplies tool calls without re-emitting text.
                yield ChatGenerationChunk(
                    message=AIMessageChunk(
                        content="",
                        usage_metadata=cast(UsageMetadata, result.usage),
                        additional_kwargs={
                            "nativeRecords": result.records,
                            "apiTypeId": self._api_type.id,
                            "apiTypeVersion": self._api_type.version,
                        },
                        tool_call_chunks=[
                            {
                                "name": call["name"],
                                "args": json.dumps(call["args"], ensure_ascii=False),
                                "id": call["id"],
                                "index": index,
                                "type": "tool_call_chunk",
                            }
                            for index, call in enumerate(result.calls)
                        ],
                    )
                )
