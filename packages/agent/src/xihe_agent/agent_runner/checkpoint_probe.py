"""Synthetic M0 probe that exercises only the CP-backed saver contract."""

from __future__ import annotations

import hashlib
from datetime import UTC, datetime
from time import time_ns
from typing import Any
from uuid import UUID, uuid4

from langchain_core.messages import HumanMessage, ToolMessage
from langgraph.checkpoint.base import empty_checkpoint

from xihe_agent.agent_runner.checkpoint_saver import CpAgentCheckpointSaver
from xihe_agent.app_state import CP_API_TOKEN, CP_URL
from xihe_agent.interfaces.tool import (
    ACQUIRE_CREDENTIAL_TOOL_NAME,
    CHECKPOINT_SAFE_OUTPUT_PREFIX,
    CHECKPOINT_SAFE_OUTPUT_SCHEMA_KEY,
    CHECKPOINT_SAFE_OUTPUT_SUFFIX,
    CHECKPOINT_SAFE_PROBE_SCHEMA_VERSION,
    CHECKPOINT_SAFE_PROBE_TOOL_NAME,
    CREDENTIAL_DELIVERED_PLACEHOLDER,
)

_CREDENTIAL_CANARY = "checkpoint-probe-credential-canary"
_SAFE_PROBE_CONTENT = CHECKPOINT_SAFE_OUTPUT_PREFIX + '{"status":"ok"}' + CHECKPOINT_SAFE_OUTPUT_SUFFIX


def _safe_state_fingerprint(saver: CpAgentCheckpointSaver, checkpoint: Any, pending_writes: Any) -> str:
    payload_type, payload = saver.serde.dumps_typed(
        {
            "checkpoint": checkpoint,
            "pendingWrites": pending_writes or [],
        }
    )
    return hashlib.sha256(payload_type.encode("utf-8") + b"\0" + payload).hexdigest()


async def run_checkpoint_saver_probe(
    *,
    session_id: UUID,
    user_id: UUID,
    workspace_id: UUID,
    thread_id: str | None = None,
    checkpoint_id: str | None = None,
    probe_id: UUID | None = None,
) -> dict[str, Any]:
    if checkpoint_id is not None and (thread_id is None or probe_id is None):
        raise ValueError("checkpoint recovery scope is invalid")
    if checkpoint_id is None and (thread_id is not None or probe_id is not None):
        raise ValueError("checkpoint round-trip scope is invalid")
    isolated_probe_id = probe_id or uuid4()
    saver_args = {
        "cp_url": CP_URL,
        "service_token": CP_API_TOKEN,
        "session_id": str(session_id),
        "user_id": str(user_id),
        "workspace_id": str(workspace_id),
        "probe_id": str(isolated_probe_id),
    }
    if checkpoint_id is not None:
        return await run_checkpoint_saver_recovery_probe(
            saver_args=saver_args,
            thread_id=thread_id,
            checkpoint_id=checkpoint_id,
            probe_id=str(isolated_probe_id),
        )
    saver = await CpAgentCheckpointSaver.create(**saver_args)
    base_config = {"configurable": {"thread_id": saver.thread_id, "checkpoint_ns": ""}}

    first_message = HumanMessage(content="Synthetic checkpoint probe message", id="probe-human-message-1")
    first = empty_checkpoint()
    first["id"] = f"{time_ns():032x}"
    first["ts"] = datetime.now(UTC).isoformat()
    first["channel_values"] = {"messages": [first_message]}
    first["channel_versions"] = {"messages": 1}
    first["versions_seen"] = {}
    first_config = await saver.aput(base_config, first, {"source": "input", "step": 0}, {})

    second = empty_checkpoint()
    second["id"] = f"{time_ns():032x}"
    second["ts"] = datetime.now(UTC).isoformat()
    second["channel_values"] = {
        "messages": [
            first_message,
            ToolMessage(
                content=_SAFE_PROBE_CONTENT,
                tool_call_id="probe-call",
                name=CHECKPOINT_SAFE_PROBE_TOOL_NAME,
                id="probe-tool-message-1",
                additional_kwargs={
                    CHECKPOINT_SAFE_OUTPUT_SCHEMA_KEY: CHECKPOINT_SAFE_PROBE_SCHEMA_VERSION,
                },
            ),
            ToolMessage(
                content=_CREDENTIAL_CANARY,
                tool_call_id="credential-probe-call",
                name=ACQUIRE_CREDENTIAL_TOOL_NAME,
                id="credential-probe-message-1",
            ),
        ]
    }
    second["channel_versions"] = {"messages": 2}
    second["versions_seen"] = {"model": {"messages": 1}}
    second_config = await saver.aput(first_config, second, {"source": "loop", "step": 1}, {})
    await saver.aput_writes(
        second_config,
        [
            (
                "messages",
                ToolMessage(
                    content=_SAFE_PROBE_CONTENT,
                    # The graph-facing safe result keeps its untrusted-data envelope.
                    tool_call_id="pending-probe-call",
                    name=CHECKPOINT_SAFE_PROBE_TOOL_NAME,
                    id="pending-probe-message-1",
                    additional_kwargs={
                        CHECKPOINT_SAFE_OUTPUT_SCHEMA_KEY: CHECKPOINT_SAFE_PROBE_SCHEMA_VERSION,
                    },
                ),
            )
        ],
        task_id="checkpoint-saver-probe-safe-task",
        task_path="",
    )
    await saver.aput_writes(
        second_config,
        [
            (
                "messages",
                ToolMessage(
                    content=_CREDENTIAL_CANARY,
                    tool_call_id="credential-pending-call",
                    name=ACQUIRE_CREDENTIAL_TOOL_NAME,
                    id="credential-pending-message-1",
                ),
            )
        ],
        task_id="checkpoint-saver-probe-credential-task",
        task_path="",
    )

    loaded_first = await saver.aget_tuple(first_config)
    loaded_second = await saver.aget_tuple(second_config)
    if loaded_first is None or loaded_second is None:
        raise RuntimeError("checkpoint round-trip failed")
    listed = [item async for item in saver.alist(base_config, limit=10)]
    limited = [item async for item in saver.alist(base_config, limit=1)]
    before_latest = [item async for item in saver.alist(base_config, before=second_config, limit=1)]
    filtered = [item async for item in saver.alist(base_config, filter={"source": "loop"}, limit=10)]
    messages = loaded_second.checkpoint.get("channel_values", {}).get("messages", [])
    state_matches = (
        loaded_first.checkpoint.get("id") == first["id"]
        and loaded_second.checkpoint.get("id") == second["id"]
        and len(messages) == 3
        and isinstance(messages[0], HumanMessage)
        and messages[0].content == first_message.content
        and messages[0].id == first_message.id
        and isinstance(messages[1], ToolMessage)
        and messages[1].content == _SAFE_PROBE_CONTENT
        and messages[1].id == "probe-tool-message-1"
        and isinstance(messages[2], ToolMessage)
        and messages[2].content == CREDENTIAL_DELIVERED_PLACEHOLDER
        and messages[2].id == "credential-probe-message-1"
        and len(loaded_second.pending_writes or []) == 2
        and all(write[1] == "messages" for write in (loaded_second.pending_writes or []))
        and any(
            isinstance(write[2], ToolMessage)
            and write[2].id == "pending-probe-message-1"
            and write[2].content == _SAFE_PROBE_CONTENT
            for write in (loaded_second.pending_writes or [])
        )
        and any(
            isinstance(write[2], ToolMessage)
            and write[2].id == "credential-pending-message-1"
            and write[2].content == CREDENTIAL_DELIVERED_PLACEHOLDER
            for write in (loaded_second.pending_writes or [])
        )
    )
    return {
        "operation": "round-trip",
        "threadId": saver.thread_id,
        "lineageId": saver.lineage_id,
        "probeId": isolated_probe_id,
        "traceMetadata": saver.trace_metadata,
        "schemaVersion": saver.schema_version,
        "checkpointIds": [str(first["id"]), str(second["id"])],
        "listedCheckpointIds": [str(item.checkpoint["id"]) for item in listed],
        "limitedCheckpointIds": [str(item.checkpoint["id"]) for item in limited],
        "beforeLatestCheckpointIds": [str(item.checkpoint["id"]) for item in before_latest],
        "filteredCheckpointIds": [str(item.checkpoint["id"]) for item in filtered],
        "pendingWrites": len(loaded_second.pending_writes or []),
        "stateMatches": bool(state_matches),
        "credentialCanaryAbsent": _CREDENTIAL_CANARY
        not in repr((loaded_second.checkpoint, loaded_second.pending_writes)),
        "stateFingerprint": _safe_state_fingerprint(
            saver,
            loaded_second.checkpoint,
            loaded_second.pending_writes,
        ),
    }


async def run_checkpoint_saver_recovery_probe(
    *, saver_args: dict[str, Any], thread_id: str, checkpoint_id: str, probe_id: str
) -> dict[str, Any]:
    saver = await CpAgentCheckpointSaver.attach(thread_id=thread_id, **saver_args)
    if saver.thread_id != thread_id or saver.trace_metadata.get("probeId") != probe_id:
        raise RuntimeError("checkpoint recovery changed the graph thread")
    requested_config = {
        "configurable": {
            "thread_id": saver.thread_id,
            "checkpoint_ns": "",
            "checkpoint_id": checkpoint_id,
        }
    }
    base_config = {"configurable": {"thread_id": saver.thread_id, "checkpoint_ns": ""}}
    loaded = await saver.aget_tuple(requested_config)
    latest = await saver.aget_tuple(base_config)
    listed = [item async for item in saver.alist(base_config, limit=10)]
    if loaded is None or latest is None:
        raise RuntimeError("checkpoint recovery failed")
    limited = [item async for item in saver.alist(base_config, limit=1)]
    before_latest = (
        [item async for item in saver.alist(base_config, before=listed[0].config, limit=1)] if listed else []
    )
    filtered = [item async for item in saver.alist(base_config, filter={"source": "loop"}, limit=10)]
    messages = latest.checkpoint.get("channel_values", {}).get("messages", [])
    state_matches = (
        str(loaded.checkpoint.get("id")) == checkpoint_id
        and str(latest.checkpoint.get("id")) == checkpoint_id
        and len(messages) == 3
        and isinstance(messages[0], HumanMessage)
        and messages[0].content == "Synthetic checkpoint probe message"
        and messages[0].id == "probe-human-message-1"
        and isinstance(messages[1], ToolMessage)
        and messages[1].content == _SAFE_PROBE_CONTENT
        and messages[1].id == "probe-tool-message-1"
        and isinstance(messages[2], ToolMessage)
        and messages[2].content == CREDENTIAL_DELIVERED_PLACEHOLDER
        and messages[2].id == "credential-probe-message-1"
        and len(loaded.pending_writes or []) == 2
        and all(write[1] == "messages" for write in (loaded.pending_writes or []))
        and any(
            isinstance(write[2], ToolMessage)
            and write[2].id == "pending-probe-message-1"
            and write[2].content == _SAFE_PROBE_CONTENT
            for write in (loaded.pending_writes or [])
        )
        and any(
            isinstance(write[2], ToolMessage)
            and write[2].id == "credential-pending-message-1"
            and write[2].content == CREDENTIAL_DELIVERED_PLACEHOLDER
            for write in (loaded.pending_writes or [])
        )
        and len(listed) >= 2
        and str(listed[0].checkpoint.get("id")) == checkpoint_id
        and str(listed[-1].checkpoint.get("id")) != checkpoint_id
        and len(limited) == 1
        and len(before_latest) == 1
        and len(filtered) == 1
    )
    return {
        "operation": "recover",
        "threadId": saver.thread_id,
        "lineageId": saver.lineage_id,
        "probeId": probe_id,
        "traceMetadata": saver.trace_metadata,
        "schemaVersion": saver.schema_version,
        "recoveredCheckpointId": str(loaded.checkpoint["id"]),
        "checkpointIds": [str(item.checkpoint["id"]) for item in reversed(listed)],
        "listedCheckpointIds": [str(item.checkpoint["id"]) for item in listed],
        "limitedCheckpointIds": [str(item.checkpoint["id"]) for item in limited],
        "beforeLatestCheckpointIds": [str(item.checkpoint["id"]) for item in before_latest],
        "filteredCheckpointIds": [str(item.checkpoint["id"]) for item in filtered],
        "listedCheckpointCount": len(listed),
        "pendingWrites": len(loaded.pending_writes or []),
        "stateMatches": bool(state_matches),
        "credentialCanaryAbsent": _CREDENTIAL_CANARY not in repr((loaded.checkpoint, loaded.pending_writes)),
        "stateFingerprint": _safe_state_fingerprint(saver, latest.checkpoint, latest.pending_writes),
    }
