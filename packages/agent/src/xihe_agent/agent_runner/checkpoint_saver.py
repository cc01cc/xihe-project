"""CP-mediated LangGraph checkpoint saver.

The Agent serializes checkpoint values with the locked LangGraph serializer and
transports opaque bytes to Control Plane. It never receives PostgreSQL settings
or opens a database connection.
"""

from __future__ import annotations

import asyncio
import base64
import json
import math
from collections.abc import AsyncIterator, Callable, Iterator, Mapping, Sequence
from importlib.metadata import PackageNotFoundError, version
from threading import Event
from typing import Any, cast
from urllib.parse import quote

import httpx
from langchain_core.messages import AIMessage, BaseMessage, HumanMessage, SystemMessage, ToolMessage
from langchain_core.runnables import RunnableConfig
from langgraph.checkpoint.base import (
    WRITES_IDX_MAP,
    BaseCheckpointSaver,
    ChannelVersions,
    Checkpoint,
    CheckpointMetadata,
    CheckpointTuple,
)
from loguru import logger

from xihe_agent.interfaces.tool import (
    ACQUIRE_CREDENTIAL_TOOL_NAME,
    CHECKPOINT_SAFE_OUTPUT_PREFIX,
    CHECKPOINT_SAFE_OUTPUT_SCHEMA_KEY,
    CHECKPOINT_SAFE_OUTPUT_SUFFIX,
    CHECKPOINT_SAFE_PROBE_SCHEMA,
    CHECKPOINT_SAFE_PROBE_TOOL_NAME,
    CREDENTIAL_DELIVERED_PLACEHOLDER,
    CREDENTIAL_HANDOFF_REQUIRED_KEY,
    CheckpointSafeToolSchema,
    ToolSpec,
    strict_json_loads,
)


class CheckpointStoreError(RuntimeError):
    """A generic saver failure that deliberately excludes request/response data."""


class CheckpointUnsafeStateError(CheckpointStoreError):
    """The current graph state is usable in memory but unsafe to persist."""


class CheckpointNotFoundError(CheckpointStoreError):
    """The referenced graph checkpoint is not (yet) visible to CP.

    ``put`` and ``put_writes`` are separate requests; a write can reach CP before
    the checkpoint insert is visible, which CP correctly rejects with 404 (the
    writes table has an FK to the checkpoint row). Callers retry briefly rather
    than aborting the whole run.
    """


# `schemaVersion` on a CP lineage is the Agent graph-state schema version. It is
# intentionally separate from Flyway's database schema version.
SUPPORTED_STATE_SCHEMA_VERSION = 1
SUPPORTED_LANGGRAPH_CHECKPOINT_VERSIONS = {2, 4}
SAFE_REACT_CONTROL_CHANNELS = {
    "__start__",
    "branch:to:model",
    "branch:to:tools",
    "branch:to:__end__",
}
# The LangGraph saver API includes a method named ``list``; inside
# ``CpAgentCheckpointSaver`` that method shadows the builtin for annotations written
# in the class body. Bind the builtin once at module scope so those annotations stay
# valid and keep their element types (otherwise mypy degrades them to an unusable
# ``list?[...]`` partial type).
_BuiltinList = list


SAFE_REACT_NODE_NAMES = {"__input__", "__start__", "__end__", "__interrupt__", "model", "tools"}
# PLAN-0510（2026-10-16 用户裁定 A+）：LangGraph 内部任务调度通道承载 `Send`（"下一步派哪些
# 任务"），与设计里已刻意置空的 `pending_sends` 同类——不写入 checkpoint（恢复时由框架按图
# 状态重算），但每次跳过都要留痕，便于核查"确实只跳过了框架调度信息"。
FRAMEWORK_SCHEDULING_CHANNELS = {"__pregel_tasks"}

# Bounded readiness retry for pending writes whose checkpoint is not yet visible
# to CP (see CheckpointNotFoundError). Total wait ~5s across the attempts.
_PENDING_WRITE_NOT_FOUND_RETRIES = 6
_PENDING_WRITE_NOT_FOUND_BACKOFF_SECONDS = 0.25


def _log_framework_channel_skip(channel: Any, value: Any) -> None:
    logger.info(
        "[LIFECYCLE] service=agent event=checkpoint_framework_channel_skipped"
        " channel={} valueType={} reason=framework_scheduling",
        channel,
        type(value).__name__,
    )


class CpAgentCheckpointSaver(BaseCheckpointSaver[str]):
    """A single-session BaseCheckpointSaver backed by CP internal endpoints."""

    _LIST_PAGE_SIZE = 2

    def __init__(
        self,
        *,
        cp_url: str,
        service_token: str,
        session_id: str,
        user_id: str,
        workspace_id: str,
        source_run_id: str | None = None,
        probe_id: str | None = None,
        producer_version: str | None = None,
        event_sequence_provider: Callable[[], int] | None = None,
        tool_specs: Sequence[ToolSpec] = (),
        checkpoint_safe_schemas: Mapping[str, CheckpointSafeToolSchema] | None = None,
        serde: Any | None = None,
    ) -> None:
        super().__init__(serde=serde)
        self._base_url = cp_url.rstrip("/") + "/internal/v1/agent/checkpoints"
        self._headers = {"Authorization": f"Bearer {service_token}"}
        self._owner = {
            "sessionId": session_id,
            "userId": user_id,
            "workspaceId": workspace_id,
        }
        self._source_run_id = source_run_id
        self._probe_id = probe_id
        self._producer_version = producer_version or _installed_producer_version()
        self._event_sequence_provider = event_sequence_provider
        self._checkpoint_safe_schemas = {CHECKPOINT_SAFE_PROBE_TOOL_NAME: CHECKPOINT_SAFE_PROBE_SCHEMA}
        for spec in tool_specs:
            if not isinstance(spec, ToolSpec):
                raise ValueError("checkpoint-safe tool registration is invalid")
            if spec.checkpoint_safe_schema is None:
                continue
            existing = self._checkpoint_safe_schemas.get(spec.name)
            if existing is not None and existing != spec.checkpoint_safe_schema:
                raise ValueError("checkpoint-safe tool schema registration conflicts")
            self._checkpoint_safe_schemas[spec.name] = spec.checkpoint_safe_schema
        for name, schema in (checkpoint_safe_schemas or {}).items():
            if not isinstance(name, str) or not name or not isinstance(schema, CheckpointSafeToolSchema):
                raise ValueError("checkpoint-safe tool schema registration is invalid")
            existing = self._checkpoint_safe_schemas.get(name)
            if existing is not None and existing != schema:
                raise ValueError("checkpoint-safe tool schema registration conflicts")
            self._checkpoint_safe_schemas[name] = schema
        self._thread_id: str | None = None
        self._lineage_id: str | None = None
        self._schema_version: int | None = None
        self._trace_metadata: dict[str, Any] | None = None
        self._unsafe_state_seen = Event()

    @classmethod
    async def create(cls, **kwargs: Any) -> CpAgentCheckpointSaver:
        saver = cls(**kwargs)
        body = {
            **saver._owner,
            "sourceRunId": saver._source_run_id,
            "probeId": saver._probe_id,
            "producerVersion": saver._producer_version,
        }
        result = await saver._arequest("POST", "/lineages", json=body)
        saver._accept_lineage(
            result,
            expected_thread_id=None,
            expected_source_run_id=saver._source_run_id,
            expected_probe_id=saver._probe_id,
            check_source_run_id=True,
            check_producer_version=False,
        )
        return saver

    @classmethod
    async def attach(cls, *, thread_id: str, **kwargs: Any) -> CpAgentCheckpointSaver:
        """Rebind a new Agent process to an existing CP-owned lineage."""
        saver = cls(**kwargs)
        result = await saver._arequest(
            "GET",
            f"/lineages/{quote(thread_id, safe='')}",
            params={**saver._owner, "sourceRunId": saver._source_run_id, "probeId": saver._probe_id},
        )
        saver._accept_lineage(
            result,
            expected_thread_id=thread_id,
            expected_source_run_id=saver._source_run_id,
            expected_probe_id=saver._probe_id,
            check_source_run_id=True,
            check_producer_version=False,
        )
        return saver

    def _accept_lineage(
        self,
        result: dict[str, Any],
        *,
        expected_thread_id: str | None,
        expected_source_run_id: str | None,
        expected_probe_id: str | None,
        check_source_run_id: bool,
        check_producer_version: bool,
    ) -> None:
        if (
            not isinstance(result, dict)
            or type(result.get("schemaVersion")) is not int
            or result["schemaVersion"] != SUPPORTED_STATE_SCHEMA_VERSION
        ):
            raise CheckpointStoreError("CP checkpoint state schema is unsupported")
        source_run_id = result.get("sourceRunId")
        probe_id = result.get("probeId")
        if (
            result.get("sessionId") != self._owner["sessionId"]
            or (check_source_run_id and source_run_id != expected_source_run_id)
            or probe_id != expected_probe_id
            or result.get("userId") != self._owner["userId"]
            or result.get("workspaceId") != self._owner["workspaceId"]
            or (expected_thread_id is not None and result.get("threadId") != expected_thread_id)
            or not result.get("branchId")
            or not result.get("createdAt")
            or not result.get("lineageId")
            or not result.get("threadId")
            or not result.get("producerVersion")
            or (check_producer_version and result.get("producerVersion") != self._producer_version)
        ):
            raise CheckpointStoreError("CP checkpoint lineage scope mismatch")
        self._thread_id = str(result["threadId"])
        self._lineage_id = str(result["lineageId"])
        self._source_run_id = str(source_run_id) if source_run_id is not None else None
        self._probe_id = str(probe_id) if probe_id is not None else None
        self._schema_version = result["schemaVersion"]
        self._producer_version = str(result["producerVersion"])
        self._trace_metadata = {
            "lineageId": self._lineage_id,
            "sourceRunId": self._source_run_id,
            "probeId": self._probe_id,
            "sessionId": self._owner["sessionId"],
            "branchId": str(result["branchId"]),
            "userId": self._owner["userId"],
            "workspaceId": self._owner["workspaceId"],
            "stateSchemaVersion": self._schema_version,
            "createdAt": str(result["createdAt"]),
            "producerVersion": self._producer_version,
        }

    @property
    def thread_id(self) -> str:
        if self._thread_id is None:
            raise CheckpointStoreError("CP checkpoint lineage is not initialized")
        return self._thread_id

    @property
    def lineage_id(self) -> str:
        if self._lineage_id is None:
            raise CheckpointStoreError("CP checkpoint lineage is not initialized")
        return self._lineage_id

    @property
    def schema_version(self) -> int:
        if self._schema_version is None:
            raise CheckpointStoreError("CP checkpoint lineage is not initialized")
        return self._schema_version

    @property
    def trace_metadata(self) -> dict[str, Any]:
        if self._trace_metadata is None:
            raise CheckpointStoreError("CP checkpoint lineage is not initialized")
        return dict(self._trace_metadata)

    def get_tuple(self, config: RunnableConfig) -> CheckpointTuple | None:
        thread_id, checkpoint_ns, checkpoint_id = self._config_parts(config)
        if checkpoint_id is None:
            rows = self._list_sync(checkpoint_ns=checkpoint_ns, limit=1)
            return self._tuple(rows[0]) if rows else None
        path = f"/{quote(thread_id, safe='')}/checkpoints/{quote(checkpoint_id, safe='')}"
        try:
            row = self._request_sync(
                "GET", path, params={**self._owner, "checkpointNs": checkpoint_ns}, allow_not_found=True
            )
        except CheckpointStoreError:
            raise
        return self._tuple(row) if row is not None else None

    def list(
        self,
        config: RunnableConfig | None,
        *,
        filter: dict[str, Any] | None = None,
        before: RunnableConfig | None = None,
        limit: int | None = None,
    ) -> Iterator[CheckpointTuple]:
        _, checkpoint_ns, _ = self._config_parts(config or {})
        if not self._filter_is_storable(filter):
            return iter(())
        before_id = None
        if before is not None:
            before_thread_id, before_ns, before_id = self._config_parts(before)
            if before_thread_id != self.thread_id or before_ns != checkpoint_ns:
                raise CheckpointStoreError("CP checkpoint list scope mismatch")
        return self._iter_sync(checkpoint_ns=checkpoint_ns, before_checkpoint_id=before_id, limit=limit, filter=filter)

    def put(
        self,
        config: RunnableConfig,
        checkpoint: Checkpoint,
        metadata: CheckpointMetadata,
        new_versions: ChannelVersions,
    ) -> RunnableConfig:
        thread_id, checkpoint_ns, _ = self._config_parts(config)
        if self._unsafe_state_seen.is_set():
            return self._checkpoint_config(thread_id, checkpoint_ns, str(checkpoint["id"]))
        try:
            projected_checkpoint = self._checkpoint_for_storage(checkpoint)
        except CheckpointUnsafeStateError:
            # Keep this Run alive with its in-memory Pregel state. Since no
            # checkpoint is written, a later continuation is blocked by the
            # CP branch-head/cursor freshness check.
            self._unsafe_state_seen.set()
            return self._checkpoint_config(thread_id, checkpoint_ns, str(checkpoint["id"]))
        payload_type, payload = self.serde.dumps_typed(projected_checkpoint)
        body = {
            **self._owner,
            "checkpointNs": checkpoint_ns,
            "checkpointId": str(checkpoint["id"]),
            "parentCheckpointId": config.get("configurable", {}).get("checkpoint_id"),
            "payloadType": payload_type,
            "payloadBase64": base64.b64encode(payload).decode("ascii"),
            "metadata": self._metadata_for_write(metadata),
        }
        self._request_sync("PUT", f"/{quote(thread_id, safe='')}/checkpoints", json=body)
        return self._checkpoint_config(thread_id, checkpoint_ns, str(checkpoint["id"]))

    def put_writes(
        self,
        config: RunnableConfig,
        writes: Sequence[tuple[str, Any]],
        task_id: str,
        task_path: str = "",
    ) -> None:
        thread_id, checkpoint_ns, checkpoint_id = self._config_parts(config)
        if self._unsafe_state_seen.is_set():
            return None
        if checkpoint_id is None:
            raise CheckpointStoreError("CP checkpoint write requires a checkpoint id")
        encoded_writes = []
        for index, (channel, value) in enumerate(writes):
            if isinstance(channel, str) and channel in FRAMEWORK_SCHEDULING_CHANNELS:
                _log_framework_channel_skip(channel, value)
                continue
            self._require_checkpoint_safe_write_channel(channel, value)
            try:
                projected_value = (
                    value
                    if isinstance(channel, str) and channel in SAFE_REACT_CONTROL_CHANNELS and channel != "__start__"
                    else self._value_for_storage(value)
                )
            except CheckpointUnsafeStateError:
                # Do not persist any item in a batch containing unsafe state.
                self._unsafe_state_seen.set()
                return None
            payload_type, payload = self.serde.dumps_typed(projected_value)
            encoded_writes.append(
                {
                    "channel": channel,
                    "payloadType": payload_type,
                    "payloadBase64": base64.b64encode(payload).decode("ascii"),
                    "writeIndex": WRITES_IDX_MAP.get(channel, index),
                }
            )
        self._request_sync(
            "POST",
            f"/{quote(thread_id, safe='')}/writes",
            json={
                **self._owner,
                "checkpointNs": checkpoint_ns,
                "checkpointId": checkpoint_id,
                "taskId": task_id,
                "taskPath": task_path,
                "writes": encoded_writes,
            },
        )

    def delete_thread(self, thread_id: str) -> None:
        self._require_thread(thread_id)
        self._request_sync("DELETE", f"/{quote(thread_id, safe='')}", json=self._owner)

    async def aget_tuple(self, config: RunnableConfig) -> CheckpointTuple | None:
        thread_id, checkpoint_ns, checkpoint_id = self._config_parts(config)
        if checkpoint_id is None:
            rows = await self._list_async(checkpoint_ns=checkpoint_ns, limit=1)
            return self._tuple(rows[0]) if rows else None
        path = f"/{quote(thread_id, safe='')}/checkpoints/{quote(checkpoint_id, safe='')}"
        row = await self._arequest(
            "GET", path, params={**self._owner, "checkpointNs": checkpoint_ns}, allow_not_found=True
        )
        return self._tuple(row) if row is not None else None

    async def preflight_completed_tool_calls(
        self,
        *,
        checkpoint_id: str,
        completed_tool_call_ids: Sequence[str],
        event_sequence: int | None = None,
    ) -> None:
        """Prove CP-reported completed side effects are represented safely.

        CP supplies only bounded originating tool-call IDs. Before LangGraph is
        allowed to resume, every ID must point to an AI tool call and exactly a
        matching schema-projected ToolMessage in the checkpoint or its pending
        writes. A credential handoff marker cannot be reconstructed after a
        process restart and therefore blocks continuation.
        """
        safe_checkpoint_id = self._safe_bounded_id(checkpoint_id, "checkpoint id")
        if (
            not isinstance(completed_tool_call_ids, Sequence)
            or isinstance(completed_tool_call_ids, (str, bytes))
            or len(completed_tool_call_ids) > 256
        ):
            raise CheckpointStoreError("Continuation side-effect preflight is invalid")
        expected_ids = [self._safe_originating_tool_call_id(value) for value in completed_tool_call_ids]
        if len(set(expected_ids)) != len(expected_ids):
            raise CheckpointStoreError("Continuation side-effect preflight is invalid")

        checkpoint_tuple = await self.aget_tuple(self._checkpoint_config(self.thread_id, "", safe_checkpoint_id))
        if checkpoint_tuple is None or checkpoint_tuple.checkpoint.get("id") != safe_checkpoint_id:
            raise CheckpointStoreError("Continuation checkpoint is unavailable")
        if event_sequence is not None and (
            type(event_sequence) is not int or checkpoint_tuple.metadata.get("eventSequence") != event_sequence
        ):
            raise CheckpointStoreError("Continuation checkpoint EventStore cursor mismatch")
        messages = checkpoint_tuple.checkpoint.get("channel_values", {}).get("messages", [])
        if not isinstance(messages, list):
            raise CheckpointStoreError("Continuation checkpoint messages are invalid")
        pending_writes = checkpoint_tuple.pending_writes or []

        tool_calls: dict[str, str] = {}
        safe_results: dict[str, str] = {}
        for message in messages:
            if isinstance(message, AIMessage):
                for call in message.tool_calls:
                    call_id = self._safe_originating_tool_call_id(call.get("id"))
                    call_name = call.get("name")
                    if not isinstance(call_name, str) or not call_name:
                        raise CheckpointStoreError("Continuation checkpoint tool call is invalid")
                    if call_id in tool_calls and tool_calls[call_id] != call_name:
                        raise CheckpointStoreError("Continuation checkpoint tool call is ambiguous")
                    tool_calls[call_id] = call_name

        candidates = [message for message in messages if isinstance(message, ToolMessage)]
        for write in pending_writes:
            if not isinstance(write, tuple) or len(write) != 3 or write[1] != "messages":
                raise CheckpointStoreError("Continuation checkpoint pending writes are invalid")
            if isinstance(write[2], ToolMessage):
                candidates.append(write[2])

        for message in candidates:
            call_id = self._safe_originating_tool_call_id(message.tool_call_id)
            if message.name == ACQUIRE_CREDENTIAL_TOOL_NAME:
                if message.additional_kwargs.get(CREDENTIAL_HANDOFF_REQUIRED_KEY) is True:
                    raise CheckpointStoreError("Continuation credential handoff is unavailable")
                continue
            schema = self._checkpoint_safe_schemas.get(message.name or "")
            if schema is None:
                continue
            projected = self._value_for_storage(message)
            if call_id in safe_results and safe_results[call_id] != projected.name:
                raise CheckpointStoreError("Continuation checkpoint tool result is ambiguous")
            safe_results[call_id] = projected.name or ""

        for call_id in expected_ids:
            declared_name = tool_calls.get(call_id)
            if declared_name is None or self._checkpoint_safe_schemas.get(declared_name) is None:
                raise CheckpointStoreError("Completed side effect has no safe checkpoint tool call")
            if safe_results.get(call_id) != declared_name:
                raise CheckpointStoreError("Completed side effect has no matching safe checkpoint result")

    async def alist(
        self,
        config: RunnableConfig | None,
        *,
        filter: dict[str, Any] | None = None,
        before: RunnableConfig | None = None,
        limit: int | None = None,
    ) -> AsyncIterator[CheckpointTuple]:
        _, checkpoint_ns, _ = self._config_parts(config or {})
        if not self._filter_is_storable(filter):
            return
        before_id = None
        if before is not None:
            before_thread_id, before_ns, before_id = self._config_parts(before)
            if before_thread_id != self.thread_id or before_ns != checkpoint_ns:
                raise CheckpointStoreError("CP checkpoint list scope mismatch")
        async for checkpoint_tuple in self._iter_async(
            checkpoint_ns=checkpoint_ns, before_checkpoint_id=before_id, limit=limit, filter=filter
        ):
            yield checkpoint_tuple

    async def aput(
        self,
        config: RunnableConfig,
        checkpoint: Checkpoint,
        metadata: CheckpointMetadata,
        new_versions: ChannelVersions,
    ) -> RunnableConfig:
        thread_id, checkpoint_ns, _ = self._config_parts(config)
        if self._unsafe_state_seen.is_set():
            return self._checkpoint_config(thread_id, checkpoint_ns, str(checkpoint["id"]))
        try:
            projected_checkpoint = self._checkpoint_for_storage(checkpoint)
        except CheckpointUnsafeStateError:
            self._unsafe_state_seen.set()
            return self._checkpoint_config(thread_id, checkpoint_ns, str(checkpoint["id"]))
        payload_type, payload = self.serde.dumps_typed(projected_checkpoint)
        body = {
            **self._owner,
            "checkpointNs": checkpoint_ns,
            "checkpointId": str(checkpoint["id"]),
            "parentCheckpointId": config.get("configurable", {}).get("checkpoint_id"),
            "payloadType": payload_type,
            "payloadBase64": base64.b64encode(payload).decode("ascii"),
            "metadata": self._metadata_for_write(metadata),
        }
        await self._arequest("PUT", f"/{quote(thread_id, safe='')}/checkpoints", json=body)
        logger.info(
            "checkpoint stored: ns={} checkpointId={} parent={}",
            checkpoint_ns,
            str(checkpoint["id"]),
            body["parentCheckpointId"],
        )
        return self._checkpoint_config(thread_id, checkpoint_ns, str(checkpoint["id"]))

    async def aput_writes(
        self,
        config: RunnableConfig,
        writes: Sequence[tuple[str, Any]],
        task_id: str,
        task_path: str = "",
    ) -> None:
        thread_id, checkpoint_ns, checkpoint_id = self._config_parts(config)
        if self._unsafe_state_seen.is_set():
            return None
        if checkpoint_id is None:
            raise CheckpointStoreError("CP checkpoint write requires a checkpoint id")
        encoded_writes = []
        for index, (channel, value) in enumerate(writes):
            if isinstance(channel, str) and channel in FRAMEWORK_SCHEDULING_CHANNELS:
                _log_framework_channel_skip(channel, value)
                continue
            self._require_checkpoint_safe_write_channel(channel, value)
            try:
                # Control channels (except ``__start__``) carry scheduler values such
                # as ``None``; persist them verbatim, mirroring the sync ``put_writes``.
                # Projecting them through ``_value_for_storage`` raised
                # "Checkpoint value has no checkpoint-safe projection" for ``None`` and
                # aborted the async stream (chat Run then ended ``ambiguous``).
                projected_value = (
                    value
                    if isinstance(channel, str)
                    and channel in SAFE_REACT_CONTROL_CHANNELS
                    and channel != "__start__"
                    else self._value_for_storage(value)
                )
            except CheckpointUnsafeStateError:
                self._unsafe_state_seen.set()
                return None
            payload_type, payload = self.serde.dumps_typed(projected_value)
            encoded_writes.append(
                {
                    "channel": channel,
                    "payloadType": payload_type,
                    "payloadBase64": base64.b64encode(payload).decode("ascii"),
                    "writeIndex": WRITES_IDX_MAP.get(channel, index),
                }
            )
        body = {
            **self._owner,
            "checkpointNs": checkpoint_ns,
            "checkpointId": checkpoint_id,
            "taskId": task_id,
            "taskPath": task_path,
            "writes": encoded_writes,
        }
        # LangGraph issues put/put_writes as separate requests; a write can arrive
        # before the checkpoint insert is visible to CP (CP rejects it with 404 via
        # the checkpoint FK). Retry briefly instead of failing the whole Run.
        for attempt in range(_PENDING_WRITE_NOT_FOUND_RETRIES + 1):
            try:
                await self._arequest(
                    "POST",
                    f"/{quote(thread_id, safe='')}/writes",
                    json=body,
                )
                return None
            except CheckpointNotFoundError:
                if attempt >= _PENDING_WRITE_NOT_FOUND_RETRIES:
                    logger.warning(
                        "checkpoint writes rejected after retries: checkpointId={} taskId={}",
                        checkpoint_id,
                        task_id,
                    )
                    raise
                await asyncio.sleep(_PENDING_WRITE_NOT_FOUND_BACKOFF_SECONDS * (attempt + 1))
        return None

    async def adelete_thread(self, thread_id: str) -> None:
        self._require_thread(thread_id)
        await self._arequest("DELETE", f"/{quote(thread_id, safe='')}", json=self._owner)

    def _list_sync(
        self,
        *,
        checkpoint_ns: str,
        before_checkpoint_id: str | None = None,
        limit: int | None = None,
        filter: dict[str, Any] | None = None,
    ) -> _BuiltinList[dict[str, Any]]:
        page_limit = self._page_limit(limit)
        params: dict[str, Any] = {**self._owner, "checkpointNs": checkpoint_ns, "limit": page_limit}
        if before_checkpoint_id is not None:
            params["beforeCheckpointId"] = before_checkpoint_id
        self._add_filter_params(params, filter)
        page = self._request_sync("GET", f"/{quote(self.thread_id, safe='')}/checkpoints", params=params)
        return self._validate_list_page(page, page_limit)

    async def _list_async(
        self,
        *,
        checkpoint_ns: str,
        before_checkpoint_id: str | None = None,
        limit: int | None = None,
        filter: dict[str, Any] | None = None,
    ) -> _BuiltinList[dict[str, Any]]:
        page_limit = self._page_limit(limit)
        params: dict[str, Any] = {**self._owner, "checkpointNs": checkpoint_ns, "limit": page_limit}
        if before_checkpoint_id is not None:
            params["beforeCheckpointId"] = before_checkpoint_id
        self._add_filter_params(params, filter)
        page = await self._arequest("GET", f"/{quote(self.thread_id, safe='')}/checkpoints", params=params)
        return self._validate_list_page(page, page_limit)

    @classmethod
    def _page_limit(cls, limit: int | None) -> int:
        if limit is None:
            return cls._LIST_PAGE_SIZE
        if isinstance(limit, bool) or not isinstance(limit, int) or limit < 0:
            raise CheckpointStoreError("CP checkpoint list limit is invalid")
        return min(cls._LIST_PAGE_SIZE, limit)

    @staticmethod
    def _validate_list_page(page: Any, page_limit: int) -> _BuiltinList[dict[str, Any]]:
        if not isinstance(page, list) or len(page) > page_limit:
            raise CheckpointStoreError("CP checkpoint response is invalid")
        if any(not isinstance(row, dict) for row in page):
            raise CheckpointStoreError("CP checkpoint response is invalid")
        return page

    def _iter_sync(
        self, *, checkpoint_ns: str, before_checkpoint_id: str | None, limit: int | None, filter: dict[str, Any] | None
    ) -> Iterator[CheckpointTuple]:
        if limit is not None and limit <= 0:
            return
        cursor = before_checkpoint_id
        yielded = 0
        while limit is None or yielded < limit:
            page_limit = min(self._LIST_PAGE_SIZE, limit - yielded) if limit is not None else self._LIST_PAGE_SIZE
            page = self._list_sync(
                checkpoint_ns=checkpoint_ns,
                before_checkpoint_id=cursor,
                limit=page_limit,
                filter=filter,
            )
            for row in page:
                checkpoint_tuple = self._tuple(row)
                if filter and any(checkpoint_tuple.metadata.get(key) != value for key, value in filter.items()):
                    continue
                yield checkpoint_tuple
                yielded += 1
                if limit is not None and yielded >= limit:
                    return
            if len(page) < page_limit:
                return
            cursor = self._safe_bounded_id(page[-1].get("checkpointId"), "checkpoint id")

    async def _iter_async(
        self, *, checkpoint_ns: str, before_checkpoint_id: str | None, limit: int | None, filter: dict[str, Any] | None
    ) -> AsyncIterator[CheckpointTuple]:
        if limit is not None and limit <= 0:
            return
        cursor = before_checkpoint_id
        yielded = 0
        while limit is None or yielded < limit:
            page_limit = min(self._LIST_PAGE_SIZE, limit - yielded) if limit is not None else self._LIST_PAGE_SIZE
            page = await self._list_async(
                checkpoint_ns=checkpoint_ns,
                before_checkpoint_id=cursor,
                limit=page_limit,
                filter=filter,
            )
            for row in page:
                checkpoint_tuple = self._tuple(row)
                if filter and any(checkpoint_tuple.metadata.get(key) != value for key, value in filter.items()):
                    continue
                yield checkpoint_tuple
                yielded += 1
                if limit is not None and yielded >= limit:
                    return
            if len(page) < page_limit:
                return
            cursor = self._safe_bounded_id(page[-1].get("checkpointId"), "checkpoint id")

    def _filtered_tuples(
        self, rows: _BuiltinList[dict[str, Any]], filter: dict[str, Any] | None
    ) -> _BuiltinList[CheckpointTuple]:
        result = []
        for row in rows:
            checkpoint_tuple = self._tuple(row)
            if filter and any(checkpoint_tuple.metadata.get(key) != value for key, value in filter.items()):
                continue
            result.append(checkpoint_tuple)
        return result

    @staticmethod
    def _filter_is_storable(filter: dict[str, Any] | None) -> bool:
        if not filter:
            return True
        if any(key not in {"source", "step"} for key in filter):
            return False
        source = filter.get("source")
        if source is not None and source not in {"input", "loop", "update", "fork"}:
            return False
        step = filter.get("step")
        return step is None or (isinstance(step, int) and not isinstance(step, bool) and -1 <= step <= 1_000_000_000)

    @staticmethod
    def _add_filter_params(params: dict[str, Any], filter: dict[str, Any] | None) -> None:
        if not filter:
            return
        source = filter.get("source")
        if isinstance(source, str):
            params["filterSource"] = source
        step = filter.get("step")
        if isinstance(step, int) and not isinstance(step, bool):
            params["filterStep"] = step

    def _tuple(self, row: dict[str, Any]) -> CheckpointTuple:
        if not isinstance(row, dict):
            raise CheckpointStoreError("CP checkpoint response is invalid")
        self._validate_trace_metadata(row)
        trace = self.trace_metadata
        checkpoint = self._load_typed_payload(row.get("payloadType"), row.get("payloadBase64"))
        checkpoint = self._checkpoint_for_storage(checkpoint)
        thread_id = str(row["threadId"])
        checkpoint_ns = row.get("checkpointNs")
        if not isinstance(checkpoint_ns, str) or "\x00" in checkpoint_ns:
            raise CheckpointStoreError("CP checkpoint namespace is invalid")
        checkpoint_id = self._safe_bounded_id(row.get("checkpointId"), "checkpoint id")
        if checkpoint["id"] != checkpoint_id:
            raise CheckpointStoreError("CP checkpoint payload identity mismatch")
        config = self._checkpoint_config(thread_id, checkpoint_ns, checkpoint_id)
        parent_id = row.get("parentCheckpointId")
        parent_config = (
            self._checkpoint_config(thread_id, checkpoint_ns, self._safe_bounded_id(parent_id, "parent checkpoint id"))
            if parent_id is not None
            else None
        )
        writes = row.get("pendingWrites")
        if not isinstance(writes, list):
            raise CheckpointStoreError("CP checkpoint pending writes are invalid")
        pending_writes = []
        for write in writes:
            if not isinstance(write, dict) or type(write.get("writeIndex")) is not int:
                raise CheckpointStoreError("CP checkpoint pending writes are invalid")
            task_id = self._safe_bounded_id(write.get("taskId"), "pending write task id")
            channel = write.get("channel")
            value = self._load_typed_payload(write.get("payloadType"), write.get("payloadBase64"))
            self._require_checkpoint_safe_write_channel(channel, value)
            projected_value = (
                value
                if isinstance(channel, str) and channel in SAFE_REACT_CONTROL_CHANNELS and channel != "__start__"
                else self._value_for_storage(value)
            )
            pending_writes.append((task_id, channel, projected_value))
        metadata = self._safe_metadata(row.get("metadata") or {})
        event_sequence = metadata.get("eventSequence")
        if self._source_run_id is not None and (type(event_sequence) is not int or event_sequence < 0):
            raise CheckpointStoreError("CP checkpoint event cursor is invalid")
        metadata.update(
            {
                "lineageId": trace["lineageId"],
                "sourceRunId": trace["sourceRunId"],
                "checkpointId": checkpoint_id,
                "sessionId": trace["sessionId"],
                "branchId": trace["branchId"],
                "userId": trace["userId"],
                "workspaceId": trace["workspaceId"],
                "stateSchemaVersion": trace["stateSchemaVersion"],
                "createdAt": row["createdAt"],
                "producerVersion": trace["producerVersion"],
            }
        )
        return CheckpointTuple(
            config,
            checkpoint,
            cast("CheckpointMetadata", metadata),
            parent_config,
            cast("_BuiltinList[tuple[str, str, Any]] | None", pending_writes),
        )

    def _load_typed_payload(self, payload_type: Any, payload_base64: Any) -> Any:
        """Decode a CP payload without exposing malformed data in exceptions."""
        if not isinstance(payload_type, str) or not payload_type or not isinstance(payload_base64, str):
            raise CheckpointStoreError("CP checkpoint payload is invalid")
        try:
            payload = base64.b64decode(payload_base64, validate=True)
            return self.serde.loads_typed((payload_type, payload))
        except Exception:
            # Serializer/base64 diagnostics may contain serialized user or
            # credential data, so callers receive only this bounded error.
            raise CheckpointStoreError("CP checkpoint payload is invalid") from None

    def _checkpoint_for_storage(self, checkpoint: Checkpoint) -> Checkpoint:
        """Project only the frozen LangGraph state fields and safe messages."""
        required_fields = {
            "v",
            "id",
            "ts",
            "channel_values",
            "channel_versions",
            "versions_seen",
        }
        optional_fields = {"pending_sends", "updated_channels"}
        if (
            not isinstance(checkpoint, dict)
            or not required_fields.issubset(checkpoint)
            or set(checkpoint) - required_fields - optional_fields
        ):
            raise CheckpointStoreError("LangGraph checkpoint state is invalid")
        checkpoint_version = checkpoint["v"]
        if type(checkpoint_version) is not int or checkpoint_version not in SUPPORTED_LANGGRAPH_CHECKPOINT_VERSIONS:
            raise CheckpointStoreError("LangGraph checkpoint version is unsupported")
        checkpoint_id = CpAgentCheckpointSaver._safe_bounded_id(checkpoint["id"], "checkpoint id")
        timestamp = checkpoint["ts"]
        if not isinstance(timestamp, str) or not timestamp or len(timestamp) > 64 or "\x00" in timestamp:
            raise CheckpointStoreError("LangGraph checkpoint timestamp is invalid")

        channel_values = checkpoint["channel_values"]
        if not isinstance(channel_values, dict):
            raise CheckpointStoreError("LangGraph checkpoint channel values are invalid")
        projected_channels: dict[str, Any] = {}
        for channel, value in channel_values.items():
            if channel == "messages":
                projected_channels[channel] = self._safe_messages_for_storage(value)
            elif channel == "__start__":
                if not isinstance(value, dict) or set(value) != {"messages"}:
                    raise CheckpointUnsafeStateError("LangGraph start channel has no safe projection")
                projected_channels[channel] = {"messages": self._safe_messages_for_storage(value["messages"])}
            elif (
                isinstance(channel, str)
                and channel in SAFE_REACT_CONTROL_CHANNELS
                and (value is None or value == "__start__")
            ):
                projected_channels[channel] = value
            else:
                raise CheckpointUnsafeStateError("LangGraph checkpoint contains an unsupported channel value")

        channel_versions = self._safe_channel_versions(checkpoint["channel_versions"])
        versions_seen = checkpoint["versions_seen"]
        if not isinstance(versions_seen, dict):
            raise CheckpointStoreError("LangGraph checkpoint versions are invalid")
        projected_versions_seen: dict[str, dict[str, Any]] = {}
        for node, versions in versions_seen.items():
            safe_node = self._safe_bounded_id(node, "checkpoint node")
            if safe_node not in SAFE_REACT_NODE_NAMES:
                # 节点名来自我们自己的图/LangGraph 内部（非用户数据），且已过 bounded 校验；
                # 带上它才能定位续跑多出的节点（此前只报 unsupported node，无法诊断）。
                raise CheckpointStoreError(f"LangGraph checkpoint contains an unsupported node: {safe_node}")
            projected_versions_seen[safe_node] = self._safe_channel_versions(versions)

        pending_sends = checkpoint.get("pending_sends", [])
        if not isinstance(pending_sends, list) or pending_sends:
            raise CheckpointStoreError("LangGraph pending sends are not checkpoint-safe")
        updated_channels = checkpoint.get("updated_channels")
        if updated_channels is not None and (
            not isinstance(updated_channels, list)
            or any(not self._is_safe_checkpoint_channel(channel) for channel in updated_channels)
        ):
            raise CheckpointStoreError("LangGraph checkpoint updated an unsupported channel")

        projected = {
            "v": checkpoint_version,
            "id": checkpoint_id,
            "ts": timestamp,
            "channel_values": projected_channels,
            "channel_versions": channel_versions,
            "versions_seen": projected_versions_seen,
        }
        if "pending_sends" in checkpoint:
            projected["pending_sends"] = []
        if "updated_channels" in checkpoint:
            projected["updated_channels"] = list(updated_channels) if updated_channels is not None else None
        return cast("Checkpoint", projected)

    def _safe_messages_for_storage(self, messages: Any) -> _BuiltinList[BaseMessage]:
        if not isinstance(messages, list):
            raise CheckpointStoreError("LangGraph messages channel is invalid")
        credential_calls: set[str] = set()
        for message in messages:
            if not isinstance(message, AIMessage):
                continue
            for call in message.tool_calls:
                if call.get("name") == ACQUIRE_CREDENTIAL_TOOL_NAME:
                    credential_calls.add(self._safe_bounded_id(call.get("id"), "tool call id"))
        credential_results = {
            message.tool_call_id
            for message in messages
            if isinstance(message, ToolMessage)
            and message.name == ACQUIRE_CREDENTIAL_TOOL_NAME
            and message.content == CREDENTIAL_DELIVERED_PLACEHOLDER
        }
        if not credential_calls.issubset(credential_results):
            raise CheckpointStoreError("Credential tool call has no safe result for checkpoint storage")
        if any(
            isinstance(message, ToolMessage)
            and message.name == ACQUIRE_CREDENTIAL_TOOL_NAME
            and message.additional_kwargs.get(CREDENTIAL_HANDOFF_REQUIRED_KEY) is True
            and message.tool_call_id not in credential_calls
            for message in messages
        ):
            raise CheckpointStoreError("Credential handoff marker has no matching tool call")
        return [self._value_for_storage(message) for message in messages]

    def _value_for_storage(self, value: Any) -> Any:
        """Project nested saver values through the credential redaction policy.

        LangGraph may persist tool results as pending writes before the next
        graph checkpoint, so both paths must apply the same projection.
        """
        if isinstance(value, list):
            return self._safe_messages_for_storage(value)
        if isinstance(value, ToolMessage) and value.name == ACQUIRE_CREDENTIAL_TOOL_NAME:
            if value.status != "success":
                raise CheckpointStoreError("Credential tool result is not checkpoint-safe")
            required_handoff = value.additional_kwargs.get(CREDENTIAL_HANDOFF_REQUIRED_KEY)
            if CREDENTIAL_HANDOFF_REQUIRED_KEY in value.additional_kwargs and required_handoff is not True:
                raise CheckpointStoreError("Credential handoff marker is invalid")
            return ToolMessage(
                content=CREDENTIAL_DELIVERED_PLACEHOLDER,
                tool_call_id=CpAgentCheckpointSaver._safe_bounded_id(value.tool_call_id, "tool call id"),
                name=ACQUIRE_CREDENTIAL_TOOL_NAME,
                id=CpAgentCheckpointSaver._safe_message_id(value.id),
                additional_kwargs=({CREDENTIAL_HANDOFF_REQUIRED_KEY: True} if required_handoff is True else {}),
                status="success",
            )
        if isinstance(value, ToolMessage):
            return self._safe_tool_message_for_storage(value)
        if isinstance(value, AIMessage):
            return self._safe_ai_message_for_storage(value)
        if isinstance(value, HumanMessage):
            if not isinstance(value.content, str):
                raise CheckpointStoreError("Human message content is not checkpoint-safe")
            return HumanMessage(
                content=value.content,
                id=CpAgentCheckpointSaver._safe_message_id(value.id),
            )
        if isinstance(value, SystemMessage):
            if not isinstance(value.content, str):
                raise CheckpointStoreError("System message content is not checkpoint-safe")
            return SystemMessage(
                content=value.content,
                id=CpAgentCheckpointSaver._safe_message_id(value.id),
            )
        if isinstance(value, BaseMessage):
            raise CheckpointStoreError("Message type has no checkpoint-safe projection")
        raise CheckpointStoreError("Checkpoint value has no checkpoint-safe projection")

    @staticmethod
    def _require_checkpoint_safe_write_channel(channel: Any, value: Any) -> None:
        if isinstance(channel, str) and channel == "messages":
            return
        if (
            isinstance(channel, str)
            and channel in SAFE_REACT_CONTROL_CHANNELS
            and channel != "__start__"
            and (value is None or value == "__start__")
        ):
            return
        raise CheckpointUnsafeStateError(
            "Pending write channel has no checkpoint-safe projection: "
            f"channel={channel if isinstance(channel, str) else type(channel).__name__} "
            f"valueType={type(value).__name__}"
        )

    @staticmethod
    def _safe_channel_versions(value: Any) -> dict[str, Any]:
        if not isinstance(value, dict):
            raise CheckpointStoreError("LangGraph checkpoint versions are invalid")
        result: dict[str, Any] = {}
        for channel, version_value in value.items():
            if not CpAgentCheckpointSaver._is_safe_checkpoint_channel(channel):
                raise CheckpointStoreError("LangGraph checkpoint contains an unsupported channel")
            if (
                isinstance(version_value, bool)
                or not isinstance(version_value, (str, int, float))
                or (
                    isinstance(version_value, str)
                    and (not version_value or len(version_value) > 128 or "\x00" in version_value)
                )
                or (isinstance(version_value, (int, float)) and version_value < 0)
                or (isinstance(version_value, float) and not math.isfinite(version_value))
            ):
                raise CheckpointStoreError("LangGraph checkpoint version value is invalid")
            result[channel] = version_value
        return result

    @staticmethod
    def _is_safe_checkpoint_channel(channel: Any) -> bool:
        return channel == "messages" or channel in SAFE_REACT_CONTROL_CHANNELS

    def _safe_tool_message_for_storage(self, message: ToolMessage) -> ToolMessage:
        schema = self._checkpoint_safe_schemas.get(message.name or "")
        if schema is None:
            raise CheckpointUnsafeStateError("Tool output has no checkpoint-safe schema")
        if message.additional_kwargs != {CHECKPOINT_SAFE_OUTPUT_SCHEMA_KEY: schema.version}:
            raise CheckpointUnsafeStateError("Tool output checkpoint schema is missing or unsupported")
        if message.response_metadata or message.artifact is not None or message.status != "success":
            raise CheckpointUnsafeStateError("Tool output contains fields outside its checkpoint-safe schema")
        if not isinstance(message.content, str):
            raise CheckpointUnsafeStateError("Tool output does not match its checkpoint-safe schema")
        if not (
            message.content.startswith(CHECKPOINT_SAFE_OUTPUT_PREFIX)
            and message.content.endswith(CHECKPOINT_SAFE_OUTPUT_SUFFIX)
        ):
            raise CheckpointUnsafeStateError("Tool output is missing its untrusted-data envelope")
        output_content = message.content[len(CHECKPOINT_SAFE_OUTPUT_PREFIX) : -len(CHECKPOINT_SAFE_OUTPUT_SUFFIX)]
        try:
            output = schema.project_output(strict_json_loads(output_content))
        except (TypeError, ValueError):
            raise CheckpointUnsafeStateError("Tool output does not match its checkpoint-safe schema") from None
        canonical_output = json.dumps(
            output,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        )
        return ToolMessage(
            content=(f"{CHECKPOINT_SAFE_OUTPUT_PREFIX}{canonical_output}{CHECKPOINT_SAFE_OUTPUT_SUFFIX}"),
            tool_call_id=CpAgentCheckpointSaver._safe_bounded_id(message.tool_call_id, "tool call id"),
            name=message.name,
            id=CpAgentCheckpointSaver._safe_message_id(message.id),
            additional_kwargs={CHECKPOINT_SAFE_OUTPUT_SCHEMA_KEY: schema.version},
            status="success",
        )

    def _safe_ai_message_for_storage(self, message: AIMessage) -> AIMessage:
        if not isinstance(message.content, str) or message.invalid_tool_calls:
            raise CheckpointStoreError("Assistant message is not checkpoint-safe")
        safe_calls = []
        for call in message.tool_calls:
            args = call.get("args")
            name = call.get("name")
            if name == ACQUIRE_CREDENTIAL_TOOL_NAME:
                if not isinstance(args, dict):
                    raise CheckpointStoreError("Credential tool arguments are invalid")
                projected_args = {}
            else:
                schema = self._checkpoint_safe_schemas.get(name)
                if schema is None:
                    raise CheckpointUnsafeStateError("Tool call arguments have no checkpoint-safe input schema")
                try:
                    projected_args = schema.project_input(args)
                except (TypeError, ValueError):
                    raise CheckpointUnsafeStateError(
                        "Tool call arguments do not match their checkpoint-safe schema"
                    ) from None
            if not isinstance(args, dict):
                raise CheckpointStoreError("Tool call arguments have no checkpoint-safe input schema")
            call_id = CpAgentCheckpointSaver._safe_bounded_id(call.get("id"), "tool call id")
            safe_calls.append(
                {
                    "name": name,
                    "args": projected_args,
                    "id": call_id,
                    "type": "tool_call",
                }
            )
        return AIMessage(
            content=message.content,
            tool_calls=safe_calls,
            id=CpAgentCheckpointSaver._safe_message_id(message.id),
        )

    @staticmethod
    def _safe_message_id(value: Any) -> str | None:
        if value is None:
            return None
        return CpAgentCheckpointSaver._safe_bounded_id(value, "message id")

    @staticmethod
    def _safe_bounded_id(value: Any, label: str) -> str:
        if not isinstance(value, str) or not value or len(value) > 128 or "\x00" in value:
            raise CheckpointStoreError(f"{label} is invalid for checkpoint storage")
        return value

    @staticmethod
    def _safe_originating_tool_call_id(value: Any) -> str:
        safe_id = CpAgentCheckpointSaver._safe_bounded_id(value, "originating tool call id")
        if len(safe_id) > 128:
            raise CheckpointStoreError("originating tool call id is invalid")
        return safe_id

    def _validate_trace_metadata(self, row: dict[str, Any]) -> None:
        expected = self.trace_metadata
        schema_version = row.get("schemaVersion")
        actual = {
            "lineageId": row.get("lineageId"),
            "sourceRunId": row.get("sourceRunId"),
            "sessionId": row.get("sessionId"),
            "branchId": row.get("branchId"),
            "userId": row.get("userId"),
            "workspaceId": row.get("workspaceId"),
            "stateSchemaVersion": row.get("schemaVersion"),
            "producerVersion": row.get("producerVersion"),
        }
        if (
            type(schema_version) is not int
            or schema_version != SUPPORTED_STATE_SCHEMA_VERSION
            or schema_version != expected["stateSchemaVersion"]
            or any(actual[key] != expected[key] for key in actual)
            or row.get("threadId") != self.thread_id
            or not isinstance(row.get("checkpointId"), str)
            or not row["checkpointId"]
            or not isinstance(row.get("createdAt"), str)
            or not row["createdAt"]
        ):
            raise CheckpointStoreError("CP checkpoint lineage metadata mismatch")

    def _config_parts(self, config: RunnableConfig) -> tuple[str, str, str | None]:
        configurable = config.get("configurable", {})
        thread_id = str(configurable.get("thread_id") or self.thread_id)
        self._require_thread(thread_id)
        checkpoint_ns = str(configurable.get("checkpoint_ns") or "")
        checkpoint_id = configurable.get("checkpoint_id")
        return thread_id, checkpoint_ns, str(checkpoint_id) if checkpoint_id is not None else None

    def _require_thread(self, thread_id: str) -> None:
        if thread_id != self.thread_id:
            raise CheckpointStoreError("CP checkpoint thread scope mismatch")

    @staticmethod
    def _checkpoint_config(thread_id: str, checkpoint_ns: str, checkpoint_id: str) -> RunnableConfig:
        return {
            "configurable": {
                "thread_id": thread_id,
                "checkpoint_ns": checkpoint_ns,
                "checkpoint_id": checkpoint_id,
            }
        }

    @staticmethod
    def _safe_metadata(metadata: Any) -> dict[str, Any]:
        if not isinstance(metadata, dict):
            return {}
        result: dict[str, Any] = {}
        source = metadata.get("source")
        if source in {"input", "loop", "update", "fork"}:
            result["source"] = source
        step = metadata.get("step")
        if isinstance(step, int) and not isinstance(step, bool) and -1 <= step <= 1_000_000_000:
            result["step"] = step
        event_sequence = metadata.get("eventSequence")
        if (
            isinstance(event_sequence, int)
            and not isinstance(event_sequence, bool)
            and 0 <= event_sequence <= 2**63 - 1
        ):
            result["eventSequence"] = event_sequence
        return result

    def _metadata_for_write(self, metadata: Any) -> dict[str, Any]:
        result = self._safe_metadata(metadata)
        if self._source_run_id is None:
            return result
        if self._event_sequence_provider is None:
            raise CheckpointStoreError("Source Run checkpoint requires an EventStore cursor")
        sequence = self._event_sequence_provider()
        if type(sequence) is not int or sequence < 0 or sequence > 2**63 - 1:
            raise CheckpointStoreError("Source Run checkpoint EventStore cursor is invalid")
        result["eventSequence"] = sequence
        return result

    def _request_sync(
        self, method: str, path: str, *, json: Any = None, params: Any = None, allow_not_found: bool = False
    ) -> Any:
        try:
            with httpx.Client(timeout=20.0, follow_redirects=False) as client:
                response = client.request(
                    method, self._base_url + path, headers=self._headers, json=json, params=params
                )
        except httpx.HTTPError:
            raise CheckpointStoreError("CP checkpoint service is unavailable") from None
        if allow_not_found and response.status_code == 404:
            return None
        if response.status_code < 200 or response.status_code >= 300:
            logger.warning(
                "checkpoint store request failed: method={} path={} status={} body={}",
                method,
                path,
                response.status_code,
                response.text[:300],
            )
            if response.status_code == 404:
                raise CheckpointNotFoundError(
                    f"CP checkpoint request not found (method={method}, path={path})"
                )
            raise CheckpointStoreError(
                f"CP checkpoint request failed (status={response.status_code}, "
                f"method={method}, path={path})"
            )
        if response.status_code == 204:
            return None
        try:
            return response.json()
        except ValueError:
            raise CheckpointStoreError("CP checkpoint response is invalid") from None

    async def _arequest(
        self, method: str, path: str, *, json: Any = None, params: Any = None, allow_not_found: bool = False
    ) -> Any:
        try:
            async with httpx.AsyncClient(timeout=20.0, follow_redirects=False) as client:
                response = await client.request(
                    method, self._base_url + path, headers=self._headers, json=json, params=params
                )
        except httpx.HTTPError:
            raise CheckpointStoreError("CP checkpoint service is unavailable") from None
        if allow_not_found and response.status_code == 404:
            return None
        if response.status_code < 200 or response.status_code >= 300:
            logger.warning(
                "checkpoint store request failed: method={} path={} status={} body={}",
                method,
                path,
                response.status_code,
                response.text[:300],
            )
            if response.status_code == 404:
                raise CheckpointNotFoundError(
                    f"CP checkpoint request not found (method={method}, path={path})"
                )
            raise CheckpointStoreError(
                f"CP checkpoint request failed (status={response.status_code}, "
                f"method={method}, path={path})"
            )
        if response.status_code == 204:
            return None
        try:
            return response.json()
        except ValueError:
            raise CheckpointStoreError("CP checkpoint response is invalid") from None


def _installed_producer_version() -> str:
    try:
        return version("xihe-agent")
    except PackageNotFoundError:
        # Source-only test runners may not install the project metadata.
        return "unknown"
