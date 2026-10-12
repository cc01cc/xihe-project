"""Strict API request templates. Stored source is never changed or repaired."""

from __future__ import annotations

import copy
import json
import math
import re
from dataclasses import dataclass
from typing import Any


class ApiRequestError(RuntimeError):
    """Safe, classified failure; never includes provider body or credentials."""

    def __init__(self, code: str, status: int = 400):
        self.code = {
            "LLM_PROVIDER_INVALID_RESPONSE": "AGENT_STREAM_FAILED",
            "LLM_PROVIDER_STREAM_TRUNCATED": "AGENT_STREAM_FAILED",
            "LLM_PROVIDER_TIMEOUT": "LLM_PROVIDER_UNREACHABLE",
            "LLM_PROVIDER_ERROR": "AGENT_STREAM_FAILED",
        }.get(code, code)
        self.status = status
        super().__init__(self.code)

    @property
    def terminal_code(self) -> str:
        if self.code in {
            "INVALID_JSON",
            "DUPLICATE_JSON_KEY",
            "INVALID_REQUEST_SHAPE",
            "MALFORMED_XH_TOKEN",
            "UNKNOWN_VARIABLE",
            "MISSING_VARIABLE",
            "WRONG_VARIABLE_TYPE",
            "WRONG_VARIABLE_LOCATION",
            "VARIABLE_IN_OBJECT_KEY",
            "RUNTIME_FIELD_CONFLICT",
        }:
            return "CONTEXT_BUILD_FAILED"
        return self.code


@dataclass(frozen=True)
class ChatApiType:
    id: str
    path: str
    input_field: str
    version: int = 1


CHAT_TYPES = {
    "openai-chat-completions": ChatApiType("openai-chat-completions", "/chat/completions", "messages"),
    "anthropic-messages": ChatApiType("anthropic-messages", "/messages", "messages"),
    "mimo-responses": ChatApiType("mimo-responses", "/responses", "input"),
}
VARIABLES = {"user_input": str, "agent_instructions": str, "model": str, "tools": list, "conversation_history": list}


def chat_type(type_id: Any, version: Any, operation: Any = "chat") -> ChatApiType:
    if operation != "chat":
        raise ApiRequestError("API_TYPE_OPERATION_MISMATCH")
    result = CHAT_TYPES.get(type_id) if isinstance(type_id, str) else None
    if result is None or type(version) is not int or version != result.version:
        raise ApiRequestError("PROVIDER_API_TYPE_UNSUPPORTED")
    return result


def strict_json(source: str) -> Any:
    def pairs(items: list[tuple[str, Any]]) -> dict[str, Any]:
        result: dict[str, Any] = {}
        for key, value in items:
            if key in result:
                raise ApiRequestError("DUPLICATE_JSON_KEY")
            result[key] = value
        return result

    def constant(_value: str) -> Any:
        raise ApiRequestError("INVALID_JSON")

    def decimal(value: str) -> float:
        result = float(value)
        if not math.isfinite(result):
            raise ApiRequestError("INVALID_JSON")
        return result

    try:
        return json.loads(source, object_pairs_hook=pairs, parse_constant=constant, parse_float=decimal)
    except (ValueError, TypeError, RecursionError) as exc:
        raise ApiRequestError("INVALID_JSON") from exc


def tokenize(value: str) -> list[tuple[str, str]]:
    parts: list[tuple[str, str]] = []
    literal = ""
    i = 0
    while i < len(value):
        escaped = value.startswith("$${", i)
        if not escaped and not value.startswith("${", i):
            literal += value[i]
            i += 1
            continue
        start = i + (3 if escaped else 2)
        end = value.find("}", start)
        name = value[start:end] if end >= 0 else value[start:]
        is_xh = name == "xh" or name.startswith("xh.")
        if end < 0:
            if is_xh and not escaped:
                raise ApiRequestError("MALFORMED_XH_TOKEN")
            literal += value[i:]
            break
        if escaped:
            literal += "${" + name + "}"
        elif is_xh:
            if not re.fullmatch(r"xh\.[a-z_]+", name):
                raise ApiRequestError("MALFORMED_XH_TOKEN")
            key = name[3:]
            if key not in VARIABLES:
                raise ApiRequestError("UNKNOWN_VARIABLE")
            if literal:
                parts.append(("literal", literal))
                literal = ""
            parts.append(("variable", key))
        else:
            literal += value[i : end + 1]
        i = end + 1
    if literal:
        parts.append(("literal", literal))
    return parts


def render_request(source: str, api_type: ChatApiType, values: dict[str, Any]) -> dict[str, Any]:
    parsed = strict_json(source)
    if not isinstance(parsed, dict):
        raise ApiRequestError("INVALID_REQUEST_SHAPE")

    def resolve(name: str) -> Any:
        if name not in values:
            raise ApiRequestError("MISSING_VARIABLE")
        result = values[name]
        if not isinstance(result, VARIABLES[name]):
            raise ApiRequestError("WRONG_VARIABLE_TYPE")
        return copy.deepcopy(result)

    def walk(node: Any, path: tuple[Any, ...]) -> Any:
        if isinstance(node, str):
            output = ""
            for kind, name in tokenize(node):
                if kind == "literal":
                    output += name
                    continue
                if VARIABLES[name] is not str:
                    raise ApiRequestError("WRONG_VARIABLE_LOCATION")
                if name == "model" and (path != ("model",) or node != "${xh.model}"):
                    raise ApiRequestError("WRONG_VARIABLE_LOCATION")
                output += resolve(name)
            return output
        if isinstance(node, list):
            output_list: list[Any] = []
            for index, item in enumerate(node):
                parts = tokenize(item) if isinstance(item, str) else []
                if len(parts) == 1 and parts[0][0] == "variable" and parts[0][1] in {"tools", "conversation_history"}:
                    name = parts[0][1]
                    allowed = ("tools",) if name == "tools" else (api_type.input_field,)
                    if path != allowed:
                        raise ApiRequestError("WRONG_VARIABLE_LOCATION")
                    output_list.extend(resolve(name))
                else:
                    output_list.append(walk(item, (*path, index)))
            return output_list
        if isinstance(node, dict):
            result = {}
            for key, value in node.items():
                if any(kind == "variable" for kind, _ in tokenize(key)):
                    raise ApiRequestError("VARIABLE_IN_OBJECT_KEY")
                if not path:
                    if key == "model" and value != "${xh.model}":
                        raise ApiRequestError("RUNTIME_FIELD_CONFLICT")
                    if key == "tools" and (
                        not isinstance(value, list) or not value or any(item != "${xh.tools}" for item in value)
                    ):
                        raise ApiRequestError("RUNTIME_FIELD_CONFLICT")
                    if key.lower().replace("_", "").replace("-", "") in {
                        "apikey",
                        "authorization",
                        "credentials",
                        "credential",
                        "endpoint",
                        "headers",
                        "baseurl",
                    }:
                        raise ApiRequestError("RUNTIME_FIELD_CONFLICT")
                result[key] = walk(value, (*path, key))
            return result
        return node

    result = walk(parsed, ())
    validate_body(result, api_type)
    return result


def validate_body(body: dict[str, Any], api_type: ChatApiType) -> None:
    if not isinstance(body.get("model"), str) or not body["model"]:
        raise ApiRequestError("INVALID_REQUEST_SHAPE")
    if not isinstance(body.get(api_type.input_field), list) or not body[api_type.input_field]:
        raise ApiRequestError("INVALID_REQUEST_SHAPE")
    if "stream" in body and type(body["stream"]) is not bool:
        raise ApiRequestError("INVALID_REQUEST_SHAPE")
    if body.get("n", 1) != 1:
        raise ApiRequestError("INVALID_REQUEST_SHAPE")
    for record in body[api_type.input_field]:
        if not isinstance(record, dict):
            raise ApiRequestError("INVALID_REQUEST_SHAPE")
        if api_type.id == "mimo-responses" and record.get("type") in {
            "function_call",
            "function_call_output",
            "reasoning",
        }:
            if record["type"] != "reasoning" and not isinstance(record.get("call_id"), str):
                raise ApiRequestError("INVALID_REQUEST_SHAPE")
            continue
        roles = (
            {"user", "assistant"}
            if api_type.id == "anthropic-messages"
            else {"user", "assistant", "system", "developer", "tool"}
        )
        if record.get("role") not in roles:
            raise ApiRequestError("INVALID_REQUEST_SHAPE")
        content = record.get("content")
        if not isinstance(content, (str, list)) and not (
            record.get("role") == "assistant" and record.get("tool_calls")
        ):
            raise ApiRequestError("INVALID_REQUEST_SHAPE")
        if record.get("role") == "tool" and not isinstance(record.get("tool_call_id"), str):
            raise ApiRequestError("INVALID_REQUEST_SHAPE")
    if api_type.id == "anthropic-messages" and (type(body.get("max_tokens")) is not int or body["max_tokens"] < 1):
        raise ApiRequestError("INVALID_REQUEST_SHAPE")
    if api_type.id == "mimo-responses" and any(
        key in body for key in ("previous_response_id", "background", "context_management")
    ):
        raise ApiRequestError("INVALID_REQUEST_SHAPE")


def validate_snapshot(data: dict[str, Any]) -> tuple[ChatApiType, dict[str, Any]]:
    forbidden = {
        "agentprincipalid",
        "principalid",
        "agentpermissionid",
        "agentpermissions",
        "permissionsnapshot",
        "permissionsnapshotid",
        "grant",
        "grants",
        "grantids",
        "permission",
        "permissions",
        "permissionids",
        "perms",
        "permsnapshot",
        "capability",
        "capabilities",
        "capabilityids",
        "roleid",
        "roleids",
    }

    def authority_fields(value: Any) -> bool:
        if isinstance(value, dict):
            return any(
                str(key).replace("_", "").lower() in forbidden or authority_fields(item) for key, item in value.items()
            )
        return isinstance(value, list) and any(authority_fields(item) for item in value)

    if (
        authority_fields(data)
        or not isinstance(data.get("content"), str)
        or not isinstance(data.get("instructions", ""), str)
    ):
        raise ApiRequestError("INVALID_REQUEST")
    snapshot = data.get("contextTemplateSnapshot")
    if not isinstance(snapshot, dict) or not isinstance(snapshot.get("template"), dict):
        raise ApiRequestError("API_TYPE_REBIND_REQUIRED", 409)
    template = snapshot["template"]
    api_type = chat_type(snapshot.get("apiTypeId"), snapshot.get("apiTypeVersion"))
    if (
        snapshot.get("layer") not in {"instance", "workspace", "user"}
        or not isinstance(snapshot.get("templateId"), str)
        or type(snapshot.get("version")) is not int
        or snapshot["version"] < 1
        or snapshot.get("templateId") != template.get("id")
        or type(template.get("version")) is not int
        or snapshot.get("version") != template.get("version")
        or api_type.id != template.get("apiTypeId")
        or type(template.get("apiTypeVersion")) is not int
        or api_type.version != template.get("apiTypeVersion")
        or template.get("status") != "published"
        or not isinstance(template.get("bodySource"), str)
        or not data.get("providerConnectionId")
        or snapshot.get("providerConnectionId") != data.get("providerConnectionId")
        or type(data.get("connectionRevision")) is not int
        or type(snapshot.get("connectionRevision")) is not int
        or snapshot.get("connectionRevision") != data.get("connectionRevision")
        or not data.get("provider")
        or not data.get("model")
        or not data.get("credentialLease")
    ):
        raise ApiRequestError("API_TYPE_TEMPLATE_MISMATCH", 409)
    return api_type, snapshot
