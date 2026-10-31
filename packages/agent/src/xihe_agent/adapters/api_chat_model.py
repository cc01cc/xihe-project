"""LangChain adapter consuming a rendered API body without rebuilding it."""

from __future__ import annotations

import copy
import json
from collections.abc import AsyncIterator, Callable, Sequence
from typing import Any, cast

from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessage, AIMessageChunk, BaseMessage, HumanMessage, SystemMessage, ToolMessage
from langchain_core.messages.ai import UsageMetadata
from langchain_core.outputs import ChatGeneration, ChatGenerationChunk, ChatResult
from loguru import logger
from pydantic import PrivateAttr

from xihe_agent.agent_runner.credential_handoff import (
    CredentialHandoffError,
    RunScopedCredentialHandoff,
    StreamingSecretRedactor,
)
from xihe_agent.interfaces.message import Message
from xihe_agent.interfaces.tool import ACQUIRE_CREDENTIAL_TOOL_NAME, BaseAgentTool
from xihe_agent.llm.api_request import ApiRequestError, ChatApiType, render_request
from xihe_agent.llm.api_sender import NATIVE_USAGE_COUNTERS, ApiSender, NativeResponse
from xihe_agent.llm.transport_metrics import TransportEventSink, TransportMetricsCollector
from xihe_agent.llm.vision_render import apply_image_parts


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
    from xihe_agent.interfaces.history_safety import mask_historical_messages, mask_native_tool_outputs

    result: list[dict[str, Any]] = []
    pending: list[Message] = []
    safe_messages = mask_historical_messages(messages)

    def flush() -> None:
        result.extend(
            record for message in to_langchain_messages(pending) for record in native_message(message, api_type)
        )
        pending.clear()

    for message in safe_messages:
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
        result.extend(mask_native_tool_outputs(api_type.id, records))
    flush()
    return result


def durable_native_carrier(model: ApiChatModel, limit: int) -> dict[str, Any]:
    """Bound tool-call arguments and replace tool-result bodies before append.

    Credential results retain their fixed credential placeholder. Other results
    use a generic placeholder because durable history lacks trusted schema
    provenance for cross-Run reuse.
    """
    from xihe_agent.interfaces.context import bound_tool_arguments, compact_json
    from xihe_agent.interfaces.history_safety import mask_native_tool_outputs
    from xihe_agent.llm.api_request import strict_json

    records = copy.deepcopy(model.native_records)
    for record in records:
        if model.api_type.id == "openai-chat-completions":
            for call in record.get("tool_calls", []):
                function = call["function"]
                function["arguments"] = compact_json(bound_tool_arguments(strict_json(function["arguments"])))
        elif model.api_type.id == "anthropic-messages":
            for block in record.get("content", []):
                if not isinstance(block, dict):
                    continue
                if block.get("type") == "tool_use":
                    block["input"] = bound_tool_arguments(block.get("input"))
        else:
            if record.get("type") == "function_call":
                record["arguments"] = compact_json(bound_tool_arguments(strict_json(record["arguments"])))
    records = mask_native_tool_outputs(model.api_type.id, records)
    carrier = {"apiTypeId": model.api_type.id, "apiTypeVersion": model.api_type.version, "nativeRecords": records}
    if len(compact_json(carrier)) > limit:
        raise ApiRequestError("CONTEXT_BUILD_FAILED")
    return carrier


class ApiChatModel(BaseChatModel):
    """One per Run; the redeemed grant and rendered base stay in memory only."""

    _api_type: ChatApiType = PrivateAttr()
    _sender: ApiSender = PrivateAttr()
    _base: dict[str, Any] = PrivateAttr()
    _body_source: str = PrivateAttr()
    _values: dict[str, Any] = PrivateAttr()
    _initial_count: int | None = PrivateAttr(default=None)
    _tool_names: set[str] = PrivateAttr(default_factory=set)
    _native_turns: list[dict[str, Any]] = PrivateAttr(default_factory=list)
    _current_suffix: list[dict[str, Any]] = PrivateAttr(default_factory=list)
    _credential_handoff: RunScopedCredentialHandoff | None = PrivateAttr(default=None)
    _include_initial_messages: bool = PrivateAttr(default=False)
    # PLAN-0416 T2.3: budget estimation over the final serialized native body,
    # taken once per dispatched provider step, plus the provider counters each
    # step actually returned (absent counters stay unknown, never 0).
    _token_estimator: Callable[[dict[str, Any]], int] | None = PrivateAttr(default=None)
    _step_estimates: list[int] = PrivateAttr(default_factory=list)
    _provider_usage: dict[str, int] = PrivateAttr(default_factory=dict)
    _provider_reported: set[str] = PrivateAttr(default_factory=set)
    # PLAN-0523 decisions #9/#12: per-model sampling overrides resolved from the
    # layer `modelParams` map, applied onto every rendered step body.
    _sampling_overrides: dict[str, Any] | None = PrivateAttr(default=None)
    _image_data_urls: list[str] = PrivateAttr(default_factory=list)

    def __init__(
        self,
        *,
        api_type: ChatApiType,
        grant: dict[str, Any],
        body_source: str,
        values: dict[str, Any],
        request_id: str,
        timeout: float,
        token_estimator: Callable[[dict[str, Any]], int] | None = None,
        transport_sink: TransportEventSink | None = None,
        include_initial_messages: bool = False,
        sampling_overrides: dict[str, Any] | None = None,
        image_data_urls: list[str] | None = None,
    ):
        super().__init__(cache=False)
        # PLAN-0605 decision B: renderer post-transform payload. Data URLs live in
        # memory only for this Run and are never logged or persisted.
        self._image_data_urls = list(image_data_urls or [])
        self._api_type = api_type
        # PLAN-0508: the per-Run collector sequences transport attempts; the
        # sink is the runner-provided relay into the existing event stream.
        collector = TransportMetricsCollector(transport_sink) if transport_sink is not None else None
        self._sender = ApiSender(api_type, grant, request_id, timeout, collector=collector)
        self._base = render_request(body_source, api_type, values)
        self._body_source = body_source
        self._values = copy.deepcopy(values)
        self._token_estimator = token_estimator
        self._include_initial_messages = bool(include_initial_messages)
        self._sampling_overrides = dict(sampling_overrides) if sampling_overrides else None
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
    def estimated_input_tokens(self) -> int:
        """Run aggregate of the per-step native body estimate (PLAN-0416 T2.3)."""
        return sum(self._step_estimates)

    @property
    def estimated_step_count(self) -> int:
        return len(self._step_estimates)

    @property
    def provider_usage_totals(self) -> dict[str, int]:
        """Provider counters summed over the steps that reported them."""
        return dict(self._provider_usage)

    @property
    def provider_reported(self) -> set[str]:
        return set(self._provider_reported)

    @property
    def provider_unknown(self) -> set[str]:
        """Counters no dispatched step reported — unknown, not 0."""
        return set(NATIVE_USAGE_COUNTERS) - self._provider_reported

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

    def set_credential_handoff(self, handoff: RunScopedCredentialHandoff) -> None:
        """Attach the current Run's volatile credential channel explicitly."""
        self._credential_handoff = handoff

    def _body(self, messages: list[BaseMessage]) -> dict[str, Any]:
        if self._initial_count is None:
            self._initial_count = 0 if self._include_initial_messages else len(messages)
        if len(messages) < self._initial_count:
            raise ApiRequestError("INVALID_REQUEST_SHAPE")
        # RAG stays in its independent template data slot on every step; it is
        # never appended to baseline instructions or admitted durable messages.
        body = render_request(self._body_source, self._api_type, self._values)
        suffix = messages[self._initial_count :]
        if any(not isinstance(message, (HumanMessage, SystemMessage, AIMessage, ToolMessage)) for message in suffix):
            raise ApiRequestError("INVALID_REQUEST_SHAPE")
        self._current_suffix = [record for message in suffix for record in native_message(message, self._api_type)]
        if self._credential_handoff is None:
            if any(
                isinstance(message, ToolMessage) and message.name == ACQUIRE_CREDENTIAL_TOOL_NAME
                for message in messages
            ):
                raise CredentialHandoffError("Credential handoff is unavailable")
            provider_messages = messages
        else:
            # Inspect the whole state, including the initial prefix. On Agent
            # restart it contains only the durable placeholder; with no current
            # Run-local value that continuation must fail closed.
            provider_messages = self._credential_handoff.hydrate_for_request(messages)
        provider_suffix = provider_messages[self._initial_count :]
        provider_records = [
            record for message in provider_suffix for record in native_message(message, self._api_type)
        ]
        body[self._api_type.input_field].extend(copy.deepcopy(provider_records))
        # PLAN-0523 decisions #9/#12: model-level sampling wins over template
        # literals; unset keys keep whatever the template/provider defaults to.
        if self._sampling_overrides:
            body.update(self._sampling_overrides)
        # PLAN-0605: template renders text; the apiType renderer injects image parts
        # for the current turn (no-op unless images were dispatched for this run).
        return apply_image_parts(body, self._api_type.id, self._image_data_urls)

    def _dispatch_body(self, messages: list[BaseMessage]) -> dict[str, Any]:
        """Final native body for this provider step, estimated before dispatch.

        PLAN-0416 T2.3: the estimate covers the complete serialized body the
        provider receives (tools/history/RAG/instructions/current input). It is
        an observation only — no threshold is invented and no request is
        replayed from the result.
        """
        body = self._body(messages)
        if self._token_estimator is None:
            return body
        estimated = self._token_estimator(body)
        self._step_estimates.append(estimated)
        logger.info(
            "[LIFECYCLE] service=agent event=native_request_estimated requestId={} step={} estimatedTokens={}",
            self._sender.request_id,
            len(self._step_estimates),
            estimated,
        )
        return body

    def _check_response(self, response: NativeResponse) -> None:
        if self._credential_handoff is not None:
            self._credential_handoff.reject_secret_echo(
                [response.text, response.calls, response.records]
            )
        if any(call["name"] not in self._tool_names for call in response.calls):
            raise ApiRequestError("TOOL_NOT_AUTHORIZED", 403)
        for name, value in response.provider_usage.items():
            self._provider_usage[name] = self._provider_usage.get(name, 0) + value
            self._provider_reported.add(name)
        self._native_turns = copy.deepcopy([*self._current_suffix, *response.records])

    def _generate(
        self, messages: list[BaseMessage], stop: list[str] | None = None, run_manager: Any = None, **kwargs: Any
    ) -> ChatResult:
        raise ApiRequestError("ASYNC_CHAT_REQUIRED")

    async def _agenerate(
        self, messages: list[BaseMessage], stop: list[str] | None = None, run_manager: Any = None, **kwargs: Any
    ) -> ChatResult:
        result = None
        async for _text, _reasoning, final in self._sender.stream(self._dispatch_body(messages)):
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
        secrets = self._credential_handoff.secrets_for_stream_filter() if self._credential_handoff else ()
        text_redactor = StreamingSecretRedactor(secrets)
        reasoning_redactor = StreamingSecretRedactor(secrets)
        async for text, reasoning, result in self._sender.stream(self._dispatch_body(messages)):
            if result is not None:
                # A complete provider response can contain a credential even
                # when its stream chunks did not; reject it before callbacks or
                # graph state observe the final message.
                self._check_response(result)
            safe_text = text_redactor.feed(text or "")
            safe_reasoning = reasoning_redactor.feed(reasoning or "")
            if safe_text or safe_reasoning:
                yield ChatGenerationChunk(
                    message=AIMessageChunk(
                        content=safe_text or safe_reasoning,
                        response_metadata={"reasoning_content": safe_reasoning} if safe_reasoning else {},
                    )
                )
            if result is not None:
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
        safe_text_tail = text_redactor.finish()
        safe_reasoning_tail = reasoning_redactor.finish()
        if safe_text_tail or safe_reasoning_tail:
            yield ChatGenerationChunk(
                message=AIMessageChunk(
                    content=safe_text_tail or safe_reasoning_tail,
                    response_metadata={"reasoning_content": safe_reasoning_tail} if safe_reasoning_tail else {},
                )
            )

