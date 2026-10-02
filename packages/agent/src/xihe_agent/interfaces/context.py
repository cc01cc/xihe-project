"""Context projection abstraction.

`AgentContext` is the read-only snapshot that the Agent consumes. It is produced
by CP's `ContextProjectionService` from the Event Store and returned via the
`/snapshot` endpoint.
"""

from abc import ABC, abstractmethod
from dataclasses import dataclass, field, replace
from typing import Any, Literal

from xihe_agent.interfaces.event import Event
from xihe_agent.interfaces.message import Message, TextMessage, ToolCallRef

# PLAN-0381 T1.1/T1.5 (frozen cross-language contract: evidence/m1-contract.md
# §3–§4). CP's ContextProjectionService mirrors these helpers — markers and
# limits must stay byte-identical for the same input.
ARG_LIMIT = 4096
JSON_PREVIEW_LIMIT = 4096
_ARG_PREFIX_CHARS = 4000
_JSON_PREVIEW_SUFFIX = "...[truncated]"


def compact_json(value: Any) -> str:
    """Deterministic compact serialization (mirrors CP writeValueAsString)."""
    import json

    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), default=str)


def _fit_marker_payload(payload: dict[str, Any], text_key: str, limit: int = ARG_LIMIT) -> dict[str, Any]:
    """标记对象自身序列化后必须仍 ≤ limit。

    前缀作为 JSON 字符串值会被**二次转义**放大（反斜杠 ×2、控制字符可达
    ×6），按观测比例迭代收缩前缀直至合规（review P1-1，两语言同规则）。
    """
    for _ in range(8):
        dumped = compact_json(payload)
        if len(dumped) <= limit:
            return payload
        prefix = str(payload.get(text_key, ""))
        if not prefix:
            return payload
        keep = max(16, int(len(prefix) * limit / len(dumped)))
        if keep >= len(prefix):
            keep = len(prefix) - 1
        if keep < 1:
            return payload
        payload = {**payload, text_key: prefix[:keep]}
    return payload


def bound_tool_arguments(arguments: Any) -> dict[str, Any]:
    """D4 (accepted 2026-09-30): complete raw arguments, bounded by the
    frozen 4096-char limit. Truncation replaces the object with an explicit
    marker — never silent, never in-place value rewriting.
    """
    if arguments is None:
        return {}
    if isinstance(arguments, dict):
        serialized = compact_json(arguments)
        if len(serialized) <= ARG_LIMIT:
            return arguments
        return _fit_marker_payload(
            {
                "__xihe_truncated__": True,
                "__chars__": len(serialized),
                "__prefix__": serialized[:_ARG_PREFIX_CHARS],
            },
            "__prefix__",
        )
    raw = arguments if isinstance(arguments, str) else compact_json(arguments)
    payload = {"_raw": raw}
    if len(compact_json(payload)) > ARG_LIMIT:
        payload = _fit_marker_payload(
            {"_raw": raw[:_ARG_PREFIX_CHARS], "__xihe_truncated__": True},
            "_raw",
        )
    return payload


@dataclass(frozen=True)
class ParsedToolResult:
    """Normalized `tool.result` content (contract §3 result-shape table)."""

    content: str
    truncated: bool = False
    artifact_ref: str = ""
    size_bytes: int | None = None
    error_code: str = ""
    legacy_normalized: bool = False


def _result_whitelist(result: dict[str, Any]) -> dict[str, Any]:
    size_bytes = result.get("sizeBytes")
    return {
        "truncated": bool(result.get("truncated", False)),
        "artifact_ref": str(result.get("artifactRef") or result.get("artifact_ref") or ""),
        "size_bytes": size_bytes if isinstance(size_bytes, int) and not isinstance(size_bytes, bool) else None,
        "error_code": str(result.get("errorCode") or result.get("error_code") or ""),
    }


def _bounded_json_preview(value: Any) -> tuple[str, bool]:
    import json

    serialized = json.dumps(value, ensure_ascii=False, separators=(",", ":"), default=str)
    if len(serialized) <= JSON_PREVIEW_LIMIT:
        return serialized, False
    return serialized[: JSON_PREVIEW_LIMIT - len(_JSON_PREVIEW_SUFFIX)] + _JSON_PREVIEW_SUFFIX, True


def parse_tool_result(result: Any) -> ParsedToolResult:
    """B1 fix: object/array results must never collapse to an empty string.

    Shape-based reading (contract §3): string, object-with-content,
    object-with-preview (M2 reader-first), else bounded JSON + marker.
    """
    if result is None:
        return ParsedToolResult(content="")
    if isinstance(result, str):
        return ParsedToolResult(content=result)
    if isinstance(result, dict):
        content = result.get("content")
        if isinstance(content, str):
            return ParsedToolResult(content=content, **_result_whitelist(result))
        preview = result.get("preview")
        if isinstance(preview, str):
            # reader-first for the M2 bounded-preview payload shape.
            return ParsedToolResult(content=preview, **_result_whitelist(result))
        serialized, cut = _bounded_json_preview(result)
        return ParsedToolResult(content=serialized, truncated=cut, legacy_normalized=True)
    serialized, cut = _bounded_json_preview(result)
    return ParsedToolResult(content=serialized, truncated=cut, legacy_normalized=True)


def _pairing_field(payload: dict[str, Any], v2_key: str, legacy_key: str, default: str = "") -> str:
    """Contract §3 dual-read: v2 camelCase payload keys fall back to legacy."""
    value = payload.get(v2_key)
    if value is None or value == "":
        value = payload.get(legacy_key)
    return str(value) if value is not None else default


def _snapshot_message(message: Message) -> dict[str, Any]:
    """Contract §5 snapshot shape: plain messages stay two-key; tool-history
    fields are emitted only when set (backward-compatible with old readers)."""
    data: dict[str, Any] = {"role": message.role, "content": message.content}
    if isinstance(message, TextMessage):
        if message.tool_calls:
            data["tool_calls"] = [
                {"call_id": ref.call_id, "tool_name": ref.tool_name, "arguments": ref.arguments}
                for ref in message.tool_calls
            ]
        if message.tool_call_id:
            data["tool_call_id"] = message.tool_call_id
        if message.tool_name:
            data["tool_name"] = message.tool_name
        if message.status:
            data["status"] = message.status
        if message.truncated:
            data["truncated"] = True
        if message.artifact_ref:
            data["artifact_ref"] = message.artifact_ref
        if message.size_bytes is not None:
            data["size_bytes"] = message.size_bytes
        if message.error_code:
            data["error_code"] = message.error_code
        if message.degraded:
            data["degraded"] = True
        if message.legacy_normalized:
            data["legacy_normalized"] = True
    return data


def message_from_dict(raw: dict[str, Any]) -> TextMessage:
    role = raw.get("role", "human")
    if role not in ("system", "human", "ai", "tool"):
        role = "human"
    tool_calls: tuple[ToolCallRef, ...] = ()
    for entry in raw.get("tool_calls") or []:
        if isinstance(entry, dict) and entry.get("call_id"):
            tool_calls = (
                *tool_calls,
                ToolCallRef(
                    call_id=str(entry.get("call_id", "")),
                    tool_name=str(entry.get("tool_name", "")),
                    arguments=entry.get("arguments") if isinstance(entry.get("arguments"), dict) else {},
                ),
            )
    size_bytes = raw.get("size_bytes")
    message = TextMessage(
        role=role,
        content=raw.get("content", ""),
        tool_call_id=str(raw.get("tool_call_id", "") or ""),
        tool_name=str(raw.get("tool_name", "") or ""),
        status=str(raw.get("status", "") or ""),
        truncated=bool(raw.get("truncated", False)),
        artifact_ref=str(raw.get("artifact_ref", "") or ""),
        size_bytes=size_bytes if isinstance(size_bytes, int) and not isinstance(size_bytes, bool) else None,
        error_code=str(raw.get("error_code", "") or ""),
        degraded=bool(raw.get("degraded", False)),
        legacy_normalized=bool(raw.get("legacy_normalized", False)),
        tool_calls=tool_calls,
    )
    # Contract §5/V3: legacy snapshots and fork seeds carry tool messages
    # without a pairing id — record the degraded state at read time.
    if message.role == "tool" and not message.tool_call_id:
        return replace(message, degraded=True)
    return message


ContextSourceType = Literal[
    "agents_md",
    "user_rules",
    "workspace_facts",
    "rag",
]


@dataclass(frozen=True)
class ContextSource:
    """A single source contributing to the system context."""

    key: str
    source_type: ContextSourceType
    content: str
    content_hash: str


def _derive_l1_status(payload: dict[str, Any], legacy_status: str) -> str:
    """PLAN-0382 spec §5: new key wins; legacy created/updated→ok, else direct."""
    explicit = payload.get("l1_status")
    if isinstance(explicit, str) and explicit:
        return explicit
    if legacy_status in ("created", "updated"):
        return "ok"
    if legacy_status in ("failed", "missing", "unavailable", "unknown"):
        return legacy_status
    return ""


@dataclass(frozen=True)
class ContextEpoch:
    """Versioned system-context baseline with L1/SUM slot separation (PLAN-0340)."""

    epoch_id: str
    baseline_hash: str
    system_messages: list[str]
    sources: list[ContextSource] = field(default_factory=list)
    source_hash: str = ""
    summary_hash: str = ""
    l1_rendered: str = ""
    # PLAN-0382 (spec §2/§5): "" = key absent → readers infer per the legacy
    # table (source_hash non-empty → ok, else unknown). Clearing statuses
    # (failed/unavailable/missing) are fail-closed markers.
    l1_status: str = ""
    env_branch: str = ""
    env_head: str = ""
    env_is_repository: bool = False
    # PLAN-0382: Runtime-reported facts (spec §2.1 value-source table).
    # None = unknown (never host-filled — §4 model-visible boundary).
    env_status: str = ""
    env_observed_at: str = ""
    env_cwd: str | None = None
    env_platform: str | None = None
    env_shell: str | None = None


@dataclass
class AgentContext:
    """Snapshot of a session context, projected from domain events."""

    aggregate_id: str
    latest_sequence: int = 0
    messages: list[Message] = field(default_factory=list)
    epoch: ContextEpoch | None = None
    runtime_state: dict[str, Any] = field(default_factory=dict)
    metadata: dict[str, Any] = field(default_factory=dict)
    # PLAN-0410 T2.3: the branch CP resolved for this snapshot ("" when the
    # snapshot predates branch awareness). The Agent never fills this itself.
    branch_id: str = ""

    def add_message(self, message: Message) -> "AgentContext":
        self.messages.append(message)
        return self

    def set_epoch(self, epoch: ContextEpoch) -> "AgentContext":
        self.epoch = epoch
        return self

    def clear_runtime_state(self) -> "AgentContext":
        self.runtime_state.clear()
        return self

    def apply_event(self, event: Event) -> "AgentContext":
        """Apply a domain event to reconstruct this context snapshot."""
        self.set_latest_sequence(event.sequence)
        payload = event.payload
        event_type = event.type

        if event_type == "session.created":
            self.metadata.setdefault("workspace_id", payload.get("workspace_id"))
            self.metadata.setdefault("user_id", payload.get("user_id"))
            if payload.get("epoch_id"):
                self.epoch = ContextEpoch(
                    epoch_id=payload["epoch_id"],
                    baseline_hash=payload.get("baseline_hash", ""),
                    system_messages=payload.get("system_messages", []),
                )
        elif event_type == "prompt.admitted":
            self._add_message_from_payload(payload, "human")
        elif event_type == "llm.token":
            self._add_message_from_payload(payload, "ai")
        elif event_type == "assistant.responded":
            # PLAN-294 M1: durable assistant reply (decision #2/#6). Applied
            # identically to llm.token so snapshots reconstruct the same
            # conversation either way.
            self._add_message_from_payload(payload, "ai")
        elif event_type == "tool.result":
            # PLAN-0381 T1.1/T1.5: pairing fields + shape-based result read.
            self._add_tool_result_message(payload)
        elif event_type == "tool.called":
            # PLAN-0381 T1.1: assistant tool-call declaration joins history
            # (contract §6 merge rule) — runtime_state keeps its legacy shape.
            self.runtime_state.setdefault("tool_calls", []).append(
                {
                    "call_id": _pairing_field(payload, "toolCallId", "call_id") or None,
                    "tool_name": _pairing_field(payload, "toolName", "tool_name") or None,
                    "tool_input": payload.get("arguments", payload.get("tool_input", {})),
                }
            )
            self._apply_tool_called(payload)
        elif event_type == "context.source_changed":
            # PLAN-0340: replace L1 half of epoch; never append into messages.
            self._apply_source_changed(payload)
        elif event_type in ("epoch.started", "epoch.replaced"):
            # PLAN-0382 T2.1: a new epoch keeps the observed env/source state
            # (CP setEpoch passthrough honors payload keys, else previous).
            prev_epoch = self.epoch
            self.epoch = ContextEpoch(
                epoch_id=payload.get("epoch_id", ""),
                baseline_hash=payload.get("baseline_hash", ""),
                system_messages=payload.get("system_messages", []),
                sources=[
                    ContextSource(
                        key=s["key"],
                        source_type=s.get("source_type", "agents_md"),
                        content=s.get("content", ""),
                        content_hash=s.get("content_hash", s.get("content_hash", "")),
                    )
                    for s in payload.get("sources", [])
                    if isinstance(s, dict)
                ],
                source_hash=payload.get("source_hash", payload.get("baseline_hash", "")),
                summary_hash=payload.get("summary_hash", ""),
                l1_rendered=payload.get("l1_rendered", ""),
                l1_status=payload.get("l1_status", prev_epoch.l1_status if prev_epoch else ""),
                env_branch=prev_epoch.env_branch if prev_epoch else "",
                env_head=prev_epoch.env_head if prev_epoch else "",
                env_is_repository=prev_epoch.env_is_repository if prev_epoch else False,
                env_status=payload.get("env_status", prev_epoch.env_status if prev_epoch else ""),
                env_observed_at=payload.get("env_observed_at", prev_epoch.env_observed_at if prev_epoch else ""),
                env_cwd=payload.get("env_cwd", prev_epoch.env_cwd if prev_epoch else None),
                env_platform=payload.get("env_platform", prev_epoch.env_platform if prev_epoch else None),
                env_shell=payload.get("env_shell", prev_epoch.env_shell if prev_epoch else None),
            )
        elif event_type == "runtime.state_cleared":
            self.clear_runtime_state()
        elif event_type == "session.forked":
            forked_from: dict[str, str] = {}
            if payload.get("source_session_id"):
                forked_from["source_session_id"] = payload["source_session_id"]
            if payload.get("anchor_message_id"):
                forked_from["anchor_message_id"] = payload["anchor_message_id"]
            self.metadata["forked_from"] = forked_from
            if "summary_seed" in payload:
                self._apply_fork_seed(payload)
        elif event_type in ("compaction.applied", "compaction.manual_applied"):
            # PLAN-0341 T1.4 (V4): summary lives only in epoch.system_messages
            # (SUM). messages is truncated to the keep-recent tail — never
            # receives the summary (no double-write).
            # PLAN-0410 D7-B1=C: manual compaction writes the branch-targeted
            # type but applies identically — both types carry the same payload.
            keep_from = max(0, len(self.messages) - 10)
            self.messages = list(self.messages[keep_from:])
            prev = self.epoch or ContextEpoch(epoch_id="", baseline_hash="", system_messages=[])
            self.epoch = ContextEpoch(
                epoch_id=payload.get("contextEpoch", prev.epoch_id),
                baseline_hash=prev.baseline_hash,
                system_messages=[
                    "Conversation summary of compacted history:",
                    payload.get("summary", ""),
                ],
                sources=prev.sources,
                source_hash=prev.source_hash,
                summary_hash=payload.get("summaryHash", ""),
                l1_rendered=prev.l1_rendered,
                # PLAN-0382 T2.1: compaction must not drop env/source state
                # (mirrors CP applyCompaction — replay parity, current-state §2).
                l1_status=prev.l1_status,
                env_branch=prev.env_branch,
                env_head=prev.env_head,
                env_is_repository=prev.env_is_repository,
                env_status=prev.env_status,
                env_observed_at=prev.env_observed_at,
                env_cwd=prev.env_cwd,
                env_platform=prev.env_platform,
                env_shell=prev.env_shell,
            )
        elif event_type == "context.prune":
            # PLAN-0341 T1.2: anti-resurrection — replace matching tool results
            # with the placeholder so replay cannot restore pruned content.
            self._apply_prune_tombstones(payload)
        elif event_type == "context.env_updated":
            prev = self.epoch or ContextEpoch(epoch_id="", baseline_hash="", system_messages=[])
            self.epoch = ContextEpoch(
                epoch_id=prev.epoch_id,
                baseline_hash=prev.baseline_hash,
                system_messages=prev.system_messages,
                sources=prev.sources,
                source_hash=prev.source_hash,
                summary_hash=prev.summary_hash,
                l1_rendered=prev.l1_rendered,
                env_branch=payload.get("branch", ""),
                env_head=payload.get("head", ""),
                env_is_repository=bool(payload.get("is_repository", False)),
                # PLAN-0382: new keys copy-on-present (mirror CP applyEnvUpdated);
                # legacy events preserve the previous state/fact values.
                l1_status=prev.l1_status,
                env_status=payload.get("env_status", prev.env_status),
                env_observed_at=payload.get("env_observed_at", prev.env_observed_at),
                env_cwd=payload.get("env_cwd", prev.env_cwd),
                env_platform=payload.get("env_platform", prev.env_platform),
                env_shell=payload.get("env_shell", prev.env_shell),
            )
        elif event_type == "taskplan.created":
            self.metadata["task_plan"] = {
                "run_id": payload.get("run_id"),
                "goal": payload.get("goal", ""),
                "items": [],
                "current_item_id": None,
                "state": "active",
            }
        elif event_type == "taskplan.updated":
            tp = self.metadata.get("task_plan", {})
            if "goal" in payload:
                tp["goal"] = payload["goal"]
            if "state" in payload:
                tp["state"] = payload["state"]
            if "current_item_id" in payload:
                tp["current_item_id"] = payload["current_item_id"]
            self.metadata["task_plan"] = tp
        elif event_type == "taskplan.item_added":
            tp = self.metadata.get("task_plan", {"items": []})
            items = tp.get("items", [])
            items.append(
                {
                    "id": payload.get("item_id"),
                    "title": payload.get("title", ""),
                    "status": "pending",
                    "position": len(items),
                }
            )
            tp["items"] = items
            self.metadata["task_plan"] = tp
        elif event_type == "taskplan.item_updated":
            tp = self.metadata.get("task_plan", {"items": []})
            item_id = payload.get("item_id")
            for item in tp.get("items", []):
                if item.get("id") == item_id:
                    if "status" in payload:
                        item["status"] = payload["status"]
                    if "evidence" in payload:
                        item["evidence"] = payload["evidence"]
                    break
            self.metadata["task_plan"] = tp
        elif event_type == "taskplan.item_completed":
            tp = self.metadata.get("task_plan", {"items": []})
            item_id = payload.get("item_id")
            for item in tp.get("items", []):
                if item.get("id") == item_id:
                    item["status"] = "completed"
                    item["evidence"] = payload.get("evidence", "")
                    break
            self.metadata["task_plan"] = tp
        elif event_type == "question.asked":
            questions = self.metadata.setdefault("questions", [])
            questions.append(
                {
                    "id": payload.get("question_id"),
                    "text": payload.get("text", ""),
                    "status": "pending",
                }
            )
        elif event_type == "question.answered":
            question_id = payload.get("question_id")
            for q in self.metadata.get("questions", []):
                if q.get("id") == question_id:
                    q["status"] = "answered"
                    q["answer"] = payload.get("answer", "")
                    break
        return self

    def _apply_fork_seed(self, payload: dict[str, Any]) -> None:
        seed = payload.get("summary_seed")
        if not isinstance(seed, dict):
            raise ValueError("session.forked summary_seed must be an object")
        raw_messages = seed.get("messages")
        context_epoch = seed.get("contextEpoch")
        if not isinstance(raw_messages, list) or not isinstance(context_epoch, str) or not context_epoch:
            raise ValueError("session.forked summary_seed requires messages and child contextEpoch")

        messages: list[Message] = []
        for raw_message in raw_messages:
            if not isinstance(raw_message, dict):
                raise ValueError("session.forked summary_seed message must be an object")
            role = raw_message.get("role")
            content = raw_message.get("content")
            if role not in {"human", "ai", "tool"} or not isinstance(content, str):
                raise ValueError("session.forked summary_seed message has invalid role/content")
            # Contract §9: seeds only carry role/content today — tool messages
            # degrade explicitly (no id) instead of fabricating a pair.
            messages.append(message_from_dict(raw_message))

        summary = seed.get("summary", "")
        summary_hash = seed.get("summaryHash", "")
        if not isinstance(summary, str) or not isinstance(summary_hash, str):
            raise ValueError("session.forked summary and summaryHash must be strings")
        if bool(summary.strip()) != bool(summary_hash.strip()):
            raise ValueError("session.forked summary and summaryHash must be present together")

        previous = self.epoch or ContextEpoch(epoch_id="", baseline_hash="", system_messages=[])
        system_messages = previous.system_messages
        if summary:
            system_messages = ["Conversation summary of compacted history:", summary]
        self.messages = messages
        self.runtime_state.clear()
        self.epoch = ContextEpoch(
            epoch_id=context_epoch,
            baseline_hash=previous.baseline_hash,
            system_messages=system_messages,
            sources=previous.sources,
            source_hash=previous.source_hash,
            summary_hash=summary_hash,
            l1_rendered=previous.l1_rendered,
            env_branch=previous.env_branch,
            env_head=previous.env_head,
            env_is_repository=previous.env_is_repository,
            l1_status=previous.l1_status,
            env_status=previous.env_status,
            env_observed_at=previous.env_observed_at,
            env_cwd=previous.env_cwd,
            env_platform=previous.env_platform,
            env_shell=previous.env_shell,
        )

    def _apply_tool_called(self, payload: dict[str, Any]) -> None:
        """Contract §6: merge consecutive declarations into one ai message.

        A payload without a resolvable call id must NOT fabricate a pair —
        it degrades to an explicit ai text fact (no tool_calls entry).
        """
        call_id = _pairing_field(payload, "toolCallId", "call_id")
        tool_name = _pairing_field(payload, "toolName", "tool_name") or "unknown"
        raw_arguments = payload.get("arguments")
        if raw_arguments is None:
            raw_arguments = payload.get("tool_input")
        arguments = bound_tool_arguments(raw_arguments)
        if not call_id:
            fact = f"[unpaired tool call: {tool_name}] {compact_json(arguments)}"
            self.messages.append(TextMessage(role="ai", content=fact, degraded=True))
            return
        ref = ToolCallRef(call_id=call_id, tool_name=tool_name, arguments=arguments)
        last = self.messages[-1] if self.messages else None
        if isinstance(last, TextMessage) and last.role == "ai" and last.tool_calls:
            self.messages[-1] = replace(last, tool_calls=(*last.tool_calls, ref))
        else:
            self.messages.append(TextMessage(role="ai", content="", tool_calls=(ref,)))

    def _add_tool_result_message(self, payload: dict[str, Any]) -> None:
        """Contract §3/§5: pairing fields + shape-based content, always appended.

        Unlike `_add_message_from_payload`, an EMPTY result is still a real
        result (V12) — it must not be silently dropped.
        """
        call_id = _pairing_field(payload, "toolCallId", "call_id")
        parsed = parse_tool_result(payload.get("result"))
        status = str(payload.get("status") or "completed")
        self.messages.append(
            TextMessage(
                role="tool",
                content=parsed.content,
                tool_call_id=call_id,
                tool_name=_pairing_field(payload, "toolName", "tool_name"),
                status=status,
                truncated=parsed.truncated,
                artifact_ref=parsed.artifact_ref,
                size_bytes=parsed.size_bytes,
                error_code=parsed.error_code,
                legacy_normalized=parsed.legacy_normalized,
                degraded=not call_id,
            )
        )

    def _add_message_from_payload(self, payload: dict[str, Any], role: str) -> None:
        content = ""
        if isinstance(payload.get("message"), dict):
            content = payload["message"].get("content", "")
            role = payload["message"].get("role", role)
        elif payload.get("content"):
            content = payload["content"]
        elif payload.get("result"):
            result = payload["result"]
            content = result.get("content", str(result)) if isinstance(result, dict) else str(result)
        elif payload.get("token"):
            content = payload["token"]
        if content:
            self.messages.append(TextMessage(role=role, content=content))

    def _apply_prune_tombstones(self, payload: dict[str, Any]) -> None:
        import hashlib

        tombstones = payload.get("tombstones") or []
        if not tombstones:
            return
        pruned_hashes = {t.get("content_hash", "") for t in tombstones if isinstance(t, dict) and t.get("content_hash")}
        if not pruned_hashes:
            return
        placeholder = "[old tool result cleared]"
        for i, msg in enumerate(self.messages):
            if msg.role != "tool" or msg.content == placeholder:
                continue
            digest = hashlib.sha256(msg.content.encode("utf-8", errors="replace")).hexdigest()
            if digest in pruned_hashes:
                # PLAN-0381 contract §8: mask replaces content only — pair
                # identity (id/name/status/degraded) survives tombstones.
                if isinstance(msg, TextMessage):
                    self.messages[i] = replace(msg, content=placeholder)
                else:
                    self.messages[i] = TextMessage(role="tool", content=placeholder)

    def _apply_source_changed(self, payload: dict[str, Any]) -> None:
        status = payload.get("status", "updated")
        # PLAN-0382 (spec §3/§5): canonical l1_status — new key wins, legacy
        # events derive (created/updated→ok, failed/missing/unavailable direct).
        l1_status = _derive_l1_status(payload, status)
        prev = self.epoch or ContextEpoch(epoch_id="", baseline_hash="", system_messages=[])
        if l1_status in ("failed", "missing", "unavailable"):
            # Q2=A fail-closed family: clear the slot WITH its state mark and
            # drop the legacy `sources` array too — replay must never fall back
            # to it unmarked (BL-48). Env facts survive the clear.
            self.epoch = ContextEpoch(
                epoch_id=prev.epoch_id,
                baseline_hash="",
                system_messages=prev.system_messages,
                sources=[],
                source_hash="",
                summary_hash=prev.summary_hash,
                l1_rendered="",
                l1_status=l1_status,
                env_branch=prev.env_branch,
                env_head=prev.env_head,
                env_is_repository=prev.env_is_repository,
                env_status=prev.env_status,
                env_observed_at=prev.env_observed_at,
                env_cwd=prev.env_cwd,
                env_platform=prev.env_platform,
                env_shell=prev.env_shell,
            )
            self.metadata["context_sources"] = {
                "status": status,
                "source_hash": "",
            }
            return
        sources = [
            ContextSource(
                key=s.get("key", ""),
                source_type=s.get("source_type", "agents_md"),
                content=s.get("content", ""),
                content_hash=s.get("content_hash", ""),
            )
            for s in payload.get("sources", [])
            if isinstance(s, dict)
        ]
        source_hash = payload.get("source_hash", payload.get("baseline_hash", ""))
        self.epoch = ContextEpoch(
            epoch_id=prev.epoch_id,
            baseline_hash=source_hash,
            system_messages=prev.system_messages,
            sources=sources,
            source_hash=source_hash,
            summary_hash=prev.summary_hash,
            l1_rendered=payload.get("rendered_text", ""),
            l1_status=l1_status,
            env_branch=prev.env_branch,
            env_head=prev.env_head,
            env_is_repository=prev.env_is_repository,
            env_status=prev.env_status,
            env_observed_at=prev.env_observed_at,
            env_cwd=prev.env_cwd,
            env_platform=prev.env_platform,
            env_shell=prev.env_shell,
        )
        self.metadata["context_sources"] = {
            "status": status,
            "source_hash": source_hash,
        }

    @classmethod
    def from_events(cls, aggregate_id: str, events: list[Event]) -> "AgentContext":
        """Reconstruct an AgentContext by replaying a list of events."""
        context = cls.empty(aggregate_id)
        for event in events:
            context.apply_event(event)
        return context

    def set_latest_sequence(self, sequence: int) -> "AgentContext":
        self.latest_sequence = sequence
        return self

    def to_snapshot(self) -> dict[str, Any]:
        """Serialize the snapshot to a transport-friendly dictionary."""
        return {
            "aggregate_id": self.aggregate_id,
            "latest_sequence": self.latest_sequence,
            "branch_id": self.branch_id,
            "messages": [_snapshot_message(m) for m in self.messages],
            "epoch": self._epoch_to_dict() if self.epoch else None,
            "runtime_state": self.runtime_state,
            "metadata": self.metadata,
        }

    @classmethod
    def empty(cls, aggregate_id: str) -> "AgentContext":
        return cls(aggregate_id=aggregate_id)

    @classmethod
    def from_snapshot(cls, snapshot: dict[str, Any]) -> "AgentContext":
        ctx = cls(
            aggregate_id=snapshot["aggregate_id"],
            latest_sequence=snapshot.get("latest_sequence", 0),
            runtime_state=snapshot.get("runtime_state", {}),
            metadata=snapshot.get("metadata", {}),
            branch_id=snapshot.get("branch_id", "") or "",
        )
        for raw in snapshot.get("messages", []):
            ctx.messages.append(message_from_dict(raw))
        epoch_raw = snapshot.get("epoch")
        if epoch_raw:
            ctx.epoch = ContextEpoch(
                epoch_id=epoch_raw.get("epoch_id", ""),
                baseline_hash=epoch_raw.get("baseline_hash", epoch_raw.get("source_hash", "")),
                system_messages=epoch_raw.get("system_messages", []),
                sources=[
                    ContextSource(
                        key=s.get("key", ""),
                        source_type=s.get("source_type", "agents_md"),
                        content=s.get("content", ""),
                        content_hash=s.get("content_hash", ""),
                    )
                    for s in epoch_raw.get("sources", epoch_raw.get("l1_sources", []))
                    if isinstance(s, dict) and s.get("key")
                ],
                source_hash=epoch_raw.get("source_hash", ""),
                summary_hash=epoch_raw.get("summary_hash", ""),
                l1_rendered=epoch_raw.get("l1_rendered", ""),
                # PLAN-0382: env/source state + Runtime facts round-trip
                # (absent keys keep the ""/None defaults → legacy inference).
                # The three legacy env fields finally round-trip too — they
                # were dropped on both codec ends before (current-state §2).
                env_branch=epoch_raw.get("env_branch", ""),
                env_head=epoch_raw.get("env_head", ""),
                env_is_repository=bool(epoch_raw.get("env_is_repository", False)),
                l1_status=epoch_raw.get("l1_status", ""),
                env_status=epoch_raw.get("env_status", ""),
                env_observed_at=epoch_raw.get("env_observed_at") or "",
                env_cwd=epoch_raw.get("env_cwd"),
                env_platform=epoch_raw.get("env_platform"),
                env_shell=epoch_raw.get("env_shell"),
            )
        return ctx

    def _epoch_to_dict(self) -> dict[str, Any]:
        if self.epoch is None:
            return {}
        epoch = self.epoch
        out: dict[str, Any] = {
            "epoch_id": epoch.epoch_id,
            "baseline_hash": epoch.baseline_hash,
            "system_messages": epoch.system_messages,
            "source_hash": epoch.source_hash,
            "summary_hash": epoch.summary_hash,
            "l1_rendered": epoch.l1_rendered,
            "sources": [
                {
                    "key": s.key,
                    "source_type": s.source_type,
                    "content": s.content,
                    "content_hash": s.content_hash,
                }
                for s in epoch.sources
            ],
            "l1_sources": [
                {
                    "key": s.key,
                    "source_type": s.source_type,
                    "content": s.content,
                    "content_hash": s.content_hash,
                }
                for s in epoch.sources
            ],
        }
        # PLAN-0382: emit only non-default state/fact keys so an absent key
        # round-trips as absent (spec §5 legacy inference depends on absence).
        if epoch.env_branch:
            out["env_branch"] = epoch.env_branch
        if epoch.env_head:
            out["env_head"] = epoch.env_head
        if epoch.env_is_repository:
            out["env_is_repository"] = True
        if epoch.l1_status:
            out["l1_status"] = epoch.l1_status
        if epoch.env_status:
            out["env_status"] = epoch.env_status
        if epoch.env_observed_at:
            out["env_observed_at"] = epoch.env_observed_at
        if epoch.env_cwd is not None:
            out["env_cwd"] = epoch.env_cwd
        if epoch.env_platform is not None:
            out["env_platform"] = epoch.env_platform
        if epoch.env_shell is not None:
            out["env_shell"] = epoch.env_shell
        return out


class ContextProvider(ABC):
    """Abstract provider that loads an `AgentContext` snapshot."""

    @abstractmethod
    async def load(
        self,
        aggregate_id: str,
        after_sequence: int = 0,
        run_id: str | None = None,
    ) -> AgentContext:
        """Load the projected context for the aggregate.

        PLAN-0410 T2.3: when `run_id` is given, CP scopes the snapshot to that
        Run's branch; the returned context is the ONLY history the runner may
        consume (never a Session-wide reread).
        """
        ...
