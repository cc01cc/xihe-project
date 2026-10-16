"""Fail-closed filtering for tool outputs crossing a Run boundary."""

from __future__ import annotations

import copy
from collections.abc import Sequence
from dataclasses import replace
from typing import Any

from xihe_agent.interfaces.message import Message, TextMessage
from xihe_agent.interfaces.tool import (
    ACQUIRE_CREDENTIAL_TOOL_NAME,
    CREDENTIAL_DELIVERED_PLACEHOLDER,
    UNSAFE_DURABLE_TOOL_RESULT_PLACEHOLDER,
)

_NATIVE_API_TYPES = frozenset({"openai-chat-completions", "anthropic-messages", "mimo-responses"})


def mask_native_tool_outputs(api_type_id: str, records: Sequence[dict[str, Any]]) -> list[dict[str, Any]]:
    """Preserve native pairing while replacing every result body.

    Existing carriers lack trusted schema provenance to prove that an output
    matches a currently registered checkpoint-safe schema. Unknown native
    families therefore produce an empty, safe history segment.
    """
    if api_type_id not in _NATIVE_API_TYPES:
        return []

    safe_records = copy.deepcopy(list(records))
    credential_call_ids: set[str] = set()
    for record in safe_records:
        if not isinstance(record, dict):
            continue
        if api_type_id == "openai-chat-completions":
            calls = record.get("tool_calls")
            if isinstance(calls, list):
                for call in calls:
                    if not isinstance(call, dict):
                        continue
                    function = call.get("function")
                    if isinstance(function, dict) and function.get("name") == ACQUIRE_CREDENTIAL_TOOL_NAME:
                        credential_call_ids.add(str(call.get("id", "")))
        elif api_type_id == "anthropic-messages":
            blocks = record.get("content")
            if isinstance(blocks, list):
                for block in blocks:
                    if (
                        isinstance(block, dict)
                        and block.get("type") == "tool_use"
                        and block.get("name") == ACQUIRE_CREDENTIAL_TOOL_NAME
                    ):
                        credential_call_ids.add(str(block.get("id", "")))
        elif record.get("type") == "function_call" and record.get("name") == ACQUIRE_CREDENTIAL_TOOL_NAME:
            credential_call_ids.add(str(record.get("call_id", "")))

    for record in safe_records:
        if not isinstance(record, dict):
            continue
        if api_type_id == "openai-chat-completions":
            if record.get("role") in {"tool", "function"}:
                call_id = str(record.get("tool_call_id", record.get("id", "")))
                record["content"] = (
                    CREDENTIAL_DELIVERED_PLACEHOLDER
                    if call_id in credential_call_ids
                    else UNSAFE_DURABLE_TOOL_RESULT_PLACEHOLDER
                )
        elif api_type_id == "anthropic-messages":
            blocks = record.get("content")
            if isinstance(blocks, list):
                for index, block in enumerate(blocks):
                    if not isinstance(block, dict) or block.get("type") != "tool_result":
                        continue
                    call_id = str(block.get("tool_use_id", ""))
                    placeholder = (
                        CREDENTIAL_DELIVERED_PLACEHOLDER
                        if call_id in credential_call_ids
                        else UNSAFE_DURABLE_TOOL_RESULT_PLACEHOLDER
                    )
                    masked = copy.deepcopy(block)
                    if isinstance(block.get("content"), list):
                        masked["content"] = [{"type": "text", "text": placeholder}]
                    else:
                        masked["content"] = placeholder
                    blocks[index] = masked
        elif record.get("type") == "function_call_output":
            call_id = str(record.get("call_id", ""))
            record["output"] = (
                CREDENTIAL_DELIVERED_PLACEHOLDER
                if call_id in credential_call_ids
                else UNSAFE_DURABLE_TOOL_RESULT_PLACEHOLDER
            )
    return safe_records


def mask_historical_messages(messages: Sequence[Message]) -> list[Message]:
    """Redact projected history before templates or a Provider can consume it."""
    safe: list[Message] = []
    for message in messages:
        if not isinstance(message, TextMessage):
            safe.append(message)
            continue
        updated = message
        if message.role == "tool":
            content = (
                CREDENTIAL_DELIVERED_PLACEHOLDER
                if message.tool_name == ACQUIRE_CREDENTIAL_TOOL_NAME
                else UNSAFE_DURABLE_TOOL_RESULT_PLACEHOLDER
            )
            updated = replace(
                updated,
                content=content,
                truncated=False,
                artifact_ref="",
                artifact_status="",
                size_bytes=None,
                error_code="",
                legacy_normalized=False,
            )
        if updated.native_records is not None:
            updated = replace(
                updated,
                native_records=tuple(mask_native_tool_outputs(updated.api_type_id, updated.native_records)),
            )
        safe.append(updated)
    return safe
