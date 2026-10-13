"""Direct, single-attempt HTTP senders and native response parsers.

Protocol references are recorded in PLAN-0439 T0.3 evidence. No SDK body
reconstruction, automatic retry or provider-name protocol inference occurs.
"""

from __future__ import annotations

import asyncio
import copy
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import urlsplit

import httpx

from xihe_agent.llm.api_request import ApiRequestError, ChatApiType, strict_json, validate_body


@dataclass
class NativeResponse:
    text: str = ""
    records: list[dict[str, Any]] = field(default_factory=list)
    calls: list[dict[str, Any]] = field(default_factory=list)
    usage: dict[str, int] = field(default_factory=dict)


def _object(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ApiRequestError("LLM_PROVIDER_INVALID_RESPONSE", 502)
    return value


def _array(value: Any) -> list[Any]:
    if not isinstance(value, list):
        raise ApiRequestError("LLM_PROVIDER_INVALID_RESPONSE", 502)
    return value


def _text(value: Any) -> str:
    if not isinstance(value, str):
        raise ApiRequestError("LLM_PROVIDER_INVALID_RESPONSE", 502)
    return value


def _call(call_id: Any, name: Any, arguments: Any) -> dict[str, Any]:
    if not isinstance(call_id, str) or not call_id or not isinstance(name, str) or not name:
        raise ApiRequestError("LLM_PROVIDER_INVALID_RESPONSE", 502)
    try:
        args = strict_json(arguments) if isinstance(arguments, str) else arguments
    except ApiRequestError as exc:
        raise ApiRequestError("LLM_PROVIDER_INVALID_RESPONSE", 502) from exc
    if not isinstance(args, dict):
        raise ApiRequestError("LLM_PROVIDER_INVALID_RESPONSE", 502)
    return {"id": call_id, "name": name, "args": args, "type": "tool_call"}


def parse_response(data: Any, api_type: ChatApiType) -> NativeResponse:
    data = _object(data)
    if data.get("error"):
        raise ApiRequestError("LLM_PROVIDER_ERROR", 502)
    result = NativeResponse()
    if api_type.id == "openai-chat-completions":
        choices = _array(data.get("choices"))
        if len(choices) != 1:
            raise ApiRequestError("LLM_PROVIDER_INVALID_RESPONSE", 502)
        choice = _object(choices[0])
        if not choice.get("finish_reason"):
            raise ApiRequestError("LLM_PROVIDER_INVALID_RESPONSE", 502)
        message = _object(choice.get("message"))
        if message.get("role") != "assistant":
            raise ApiRequestError("LLM_PROVIDER_INVALID_RESPONSE", 502)
        result.records = [copy.deepcopy(message)]
        content = message.get("content")
        if content is not None:
            result.text = _text(content)
        for call in _array(message.get("tool_calls", [])):
            call = _object(call)
            function = _object(call.get("function"))
            if call.get("type") != "function":
                raise ApiRequestError("LLM_PROVIDER_INVALID_RESPONSE", 502)
            result.calls.append(_call(call.get("id"), function.get("name"), function.get("arguments")))
        usage = _object(data.get("usage") or {})
        result.usage = {
            "input_tokens": int(usage.get("prompt_tokens", 0)),
            "output_tokens": int(usage.get("completion_tokens", 0)),
        }
    elif api_type.id == "anthropic-messages":
        blocks = _array(data.get("content"))
        if data.get("role") != "assistant" or not data.get("stop_reason"):
            raise ApiRequestError("LLM_PROVIDER_INVALID_RESPONSE", 502)
        result.records = [{"role": "assistant", "content": copy.deepcopy(blocks)}]
        for block in blocks:
            block = _object(block)
            if block.get("type") == "text":
                result.text += _text(block.get("text"))
            elif block.get("type") == "tool_use":
                result.calls.append(_call(block.get("id"), block.get("name"), block.get("input")))
            elif block.get("type") == "thinking":
                _text(block.get("thinking"))
                _text(block.get("signature"))
            elif block.get("type") != "redacted_thinking":
                raise ApiRequestError("LLM_PROVIDER_INVALID_RESPONSE", 502)
        usage = _object(data.get("usage") or {})
        result.usage = {
            "input_tokens": int(usage.get("input_tokens", 0)),
            "output_tokens": int(usage.get("output_tokens", 0)),
        }
    else:
        if data.get("status") != "completed":
            raise ApiRequestError("LLM_PROVIDER_INVALID_RESPONSE", 502)
        records = _array(data.get("output"))
        result.records = copy.deepcopy(records)
        for item in records:
            item = _object(item)
            if item.get("type") == "message":
                if item.get("role") != "assistant":
                    raise ApiRequestError("LLM_PROVIDER_INVALID_RESPONSE", 502)
                for block in _array(item.get("content")):
                    block = _object(block)
                    if block.get("type") == "output_text":
                        result.text += _text(block.get("text"))
            elif item.get("type") == "function_call":
                result.calls.append(_call(item.get("call_id"), item.get("name"), item.get("arguments")))
            elif item.get("type") != "reasoning":
                raise ApiRequestError("LLM_PROVIDER_INVALID_RESPONSE", 502)
        usage = _object(data.get("usage") or {})
        result.usage = {
            "input_tokens": int(usage.get("input_tokens", 0)),
            "output_tokens": int(usage.get("output_tokens", 0)),
        }
    result.usage["total_tokens"] = sum(result.usage.values())
    return result


class StreamParser:
    def __init__(self, api_type: ChatApiType):
        self.api_type = api_type
        self.complete = False
        self.message: dict[str, Any] = {"role": "assistant", "content": ""}
        self.calls: dict[int, dict[str, Any]] = {}
        self.blocks: dict[int, dict[str, Any]] = {}
        self.open_blocks: set[int] = set()
        self.usage: dict[str, Any] = {}
        self.finish: str | None = None
        self.response: dict[str, Any] | None = None
        self.started = False

    def feed(self, event: str, raw: str) -> tuple[str, str]:
        if self.complete:
            raise ApiRequestError("LLM_PROVIDER_INVALID_RESPONSE", 502)
        if raw == "[DONE]" and self.api_type.id == "openai-chat-completions":
            self.finish = self.finish or "stop"
            self.complete = True
            return "", ""
        try:
            data = _object(strict_json(raw))
            return self._feed(event, data)
        except (KeyError, TypeError, ValueError, IndexError) as exc:
            raise ApiRequestError("LLM_PROVIDER_INVALID_RESPONSE", 502) from exc
        except ApiRequestError as exc:
            if exc.code in {"INVALID_JSON", "DUPLICATE_JSON_KEY"}:
                raise ApiRequestError("LLM_PROVIDER_INVALID_RESPONSE", 502) from exc
            raise

    def _feed(self, event: str, data: dict[str, Any]) -> tuple[str, str]:
        if (
            data.get("error")
            or event == "error"
            or data.get("type") in {"error", "response.failed", "response.incomplete"}
        ):
            raise ApiRequestError("LLM_PROVIDER_ERROR", 502)
        if self.api_type.id == "openai-chat-completions":
            if "usage" in data and data["usage"] is not None:
                self.usage = _object(data["usage"])
            choices = _array(data.get("choices"))
            if not choices:
                return "", ""
            if len(choices) != 1 or choices[0].get("index", 0) != 0:
                raise ApiRequestError("LLM_PROVIDER_INVALID_RESPONSE", 502)
            choice = _object(choices[0])
            delta = _object(choice.get("delta", {}))
            if delta.get("role", "assistant") != "assistant":
                raise ApiRequestError("LLM_PROVIDER_INVALID_RESPONSE", 502)
            text = delta.get("content") or ""
            _text(text)
            self.message["content"] += text
            for call in _array(delta.get("tool_calls", [])):
                index = call.get("index")
                if type(index) is not int:
                    raise ApiRequestError("LLM_PROVIDER_INVALID_RESPONSE", 502)
                target = self.calls.setdefault(
                    index, {"id": "", "type": "function", "function": {"name": "", "arguments": ""}}
                )
                if call.get("id"):
                    target["id"] = call["id"]
                function = _object(call.get("function", {}))
                for field in ("name", "arguments"):
                    target["function"][field] += _text(function.get(field, ""))
            if choice.get("finish_reason"):
                self.finish = _text(choice["finish_reason"])
            return text, ""
        if self.api_type.id == "anthropic-messages":
            kind = data.get("type")
            if event and event != kind:
                raise ApiRequestError("LLM_PROVIDER_INVALID_RESPONSE", 502)
            if kind == "message_start":
                if self.started:
                    raise ApiRequestError("LLM_PROVIDER_INVALID_RESPONSE", 502)
                self.started = True
                self.usage = _object(data["message"].get("usage", {})).copy()
            elif kind == "content_block_start":
                index = data["index"]
                if not self.started or type(index) is not int or index in self.blocks:
                    raise ApiRequestError("LLM_PROVIDER_INVALID_RESPONSE", 502)
                self.blocks[index] = copy.deepcopy(_object(data["content_block"]))
                self.open_blocks.add(index)
            elif kind == "content_block_delta":
                index = data["index"]
                if index not in self.open_blocks:
                    raise ApiRequestError("LLM_PROVIDER_INVALID_RESPONSE", 502)
                block = self.blocks[index]
                delta = _object(data["delta"])
                delta_type = delta.get("type")
                if delta_type == "text_delta" and block.get("type") == "text":
                    text = _text(delta["text"])
                    block["text"] = block.get("text", "") + text
                    return text, ""
                if delta_type == "input_json_delta" and block.get("type") == "tool_use":
                    block["_partial_json"] = block.get("_partial_json", "") + _text(delta["partial_json"])
                elif delta_type == "thinking_delta" and block.get("type") == "thinking":
                    text = _text(delta["thinking"])
                    block["thinking"] = block.get("thinking", "") + text
                    return "", text
                elif delta_type == "signature_delta" and block.get("type") == "thinking":
                    block["signature"] = block.get("signature", "") + _text(delta["signature"])
                else:
                    raise ApiRequestError("LLM_PROVIDER_INVALID_RESPONSE", 502)
            elif kind == "content_block_stop":
                index = data["index"]
                if index not in self.open_blocks:
                    raise ApiRequestError("LLM_PROVIDER_INVALID_RESPONSE", 502)
                self.open_blocks.remove(index)
                block = self.blocks[index]
                if "_partial_json" in block:
                    block["input"] = strict_json(block.pop("_partial_json"))
            elif kind == "message_delta":
                self.finish = data.get("delta", {}).get("stop_reason")
                self.usage.update(_object(data.get("usage", {})))
            elif kind == "message_stop":
                if not self.started or self.open_blocks or not self.finish:
                    raise ApiRequestError("LLM_PROVIDER_INVALID_RESPONSE", 502)
                self.complete = True
            elif kind != "ping":
                raise ApiRequestError("LLM_PROVIDER_INVALID_RESPONSE", 502)
            return "", ""
        kind = data.get("type")
        if event and event != kind:
            raise ApiRequestError("LLM_PROVIDER_INVALID_RESPONSE", 502)
        if kind == "response.output_text.delta":
            return _text(data.get("delta")), ""
        if kind in {"response.reasoning_text.delta", "response.reasoning_summary_text.delta"}:
            return "", _text(data.get("delta"))
        if kind == "response.completed":
            self.response = _object(data.get("response"))
            self.complete = True
        elif not isinstance(kind, str) or not kind.startswith("response."):
            raise ApiRequestError("LLM_PROVIDER_INVALID_RESPONSE", 502)
        return "", ""

    def result(self) -> NativeResponse:
        if not self.complete:
            raise ApiRequestError("LLM_PROVIDER_STREAM_TRUNCATED", 502)
        if self.api_type.id == "openai-chat-completions":
            if self.calls:
                self.message["tool_calls"] = [self.calls[i] for i in sorted(self.calls)]
            return parse_response(
                {"choices": [{"message": self.message, "finish_reason": self.finish}], "usage": self.usage},
                self.api_type,
            )
        if self.api_type.id == "anthropic-messages":
            return parse_response(
                {
                    "role": "assistant",
                    "content": [self.blocks[i] for i in sorted(self.blocks)],
                    "stop_reason": self.finish,
                    "usage": self.usage,
                },
                self.api_type,
            )
        return parse_response(self.response, self.api_type)


class ApiSender:
    def __init__(self, api_type: ChatApiType, grant: dict[str, Any], request_id: str, timeout: float):
        self.api_type = api_type
        self.request_id = request_id
        self.timeout = timeout
        base = grant.get("baseUrl")
        key = grant.get("apiKey")
        if (
            grant.get("operation") != "chat"
            or grant.get("apiTypeId") != api_type.id
            or grant.get("apiTypeVersion") != api_type.version
        ):
            raise ApiRequestError("API_TYPE_OPERATION_MISMATCH")
        if not isinstance(base, str) or not base or (key is not None and not isinstance(key, str)):
            raise ApiRequestError("PROVIDER_CONNECTION_UNAVAILABLE", 503)
        parsed = urlsplit(base)
        if (
            parsed.scheme not in {"http", "https"}
            or not parsed.netloc
            or parsed.query
            or parsed.fragment
            or parsed.username
        ):
            raise ApiRequestError("PROVIDER_CONNECTION_UNAVAILABLE", 503)
        if not parsed.path.rstrip("/").endswith("/v1"):
            raise ApiRequestError("PROVIDER_CONNECTION_UNAVAILABLE", 503)
        self.url = base.rstrip("/") + api_type.path
        self.headers = {"Content-Type": "application/json", "X-Request-Id": request_id}
        if api_type.id == "anthropic-messages":
            self.headers["anthropic-version"] = "2023-06-01"
            if key:
                self.headers["x-api-key"] = key
        elif api_type.id == "mimo-responses" and key:
            self.headers["api-key"] = key
        elif key:
            self.headers["Authorization"] = f"Bearer {key}"

    async def stream(self, body: dict[str, Any]) -> AsyncIterator[tuple[str, str, NativeResponse | None]]:
        validate_body(body, self.api_type)
        # No retry loop, redirect replay or SDK retry. Total deadline covers reading
        # the entire response, independently of HTTPX's per-hop timeout.
        try:
            async with asyncio.timeout(self.timeout), httpx.AsyncClient(follow_redirects=False) as client:  # noqa: SIM117 -- client owns nested streamed response
                async with client.stream(
                    "POST", self.url, headers=self.headers, json=body, timeout=self.timeout
                ) as response:
                    if not 200 <= response.status_code < 300:
                        code = (
                            "LLM_CREDENTIALS_INVALID"
                            if response.status_code in {401, 403}
                            else "LLM_PROVIDER_UNREACHABLE"
                            if response.status_code >= 500
                            else "LLM_REQUEST_REJECTED"
                        )
                        raise ApiRequestError(code, 502)
                    if not body.get("stream", False):
                        raw = await response.aread()
                        try:
                            result = parse_response(strict_json(raw.decode("utf-8")), self.api_type)
                        except ApiRequestError as exc:
                            if exc.code in {"INVALID_JSON", "DUPLICATE_JSON_KEY"}:
                                raise ApiRequestError("LLM_PROVIDER_INVALID_RESPONSE", 502) from exc
                            raise
                        except (UnicodeError, ValueError, TypeError, KeyError) as exc:
                            raise ApiRequestError("LLM_PROVIDER_INVALID_RESPONSE", 502) from exc
                        yield result.text, "", result
                        return
                    if "text/event-stream" not in response.headers.get("content-type", ""):
                        raise ApiRequestError("LLM_PROVIDER_INVALID_RESPONSE", 502)
                    parser = StreamParser(self.api_type)
                    event = ""
                    data: list[str] = []
                    async for line in response.aiter_lines():
                        if line == "":
                            if data:
                                text, reasoning = parser.feed(event, "\n".join(data))
                                if text or reasoning:
                                    yield text, reasoning, None
                                if parser.complete:
                                    yield "", "", parser.result()
                                    return
                            event, data = "", []
                        elif line.startswith("data:"):
                            data.append(line[5:].removeprefix(" "))
                        elif line.startswith("event:"):
                            event = line[6:].strip()
                        elif line.startswith(":") or line.startswith(("id:", "retry:")):
                            continue
                        else:
                            raise ApiRequestError("LLM_PROVIDER_INVALID_RESPONSE", 502)
                    raise ApiRequestError("LLM_PROVIDER_STREAM_TRUNCATED", 502)
        except (TimeoutError, httpx.TimeoutException) as exc:
            raise ApiRequestError("LLM_PROVIDER_TIMEOUT", 504) from exc
        except httpx.HTTPError as exc:
            raise ApiRequestError("LLM_PROVIDER_UNREACHABLE", 502) from exc
