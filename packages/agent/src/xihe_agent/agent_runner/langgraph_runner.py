"""LangGraph-based AgentRunner implementation."""

import asyncio
import hashlib
from collections.abc import AsyncIterator, Sequence
from dataclasses import dataclass, field, replace
from datetime import UTC, datetime
from typing import Any, Literal
from uuid import uuid4

import litellm
from langchain.agents import create_agent as create_react_agent
from langchain.agents.middleware import InputAgentState
from langchain_core.messages import (
    AIMessage,
    AnyMessage,
    HumanMessage,
    SystemMessage,
    ToolMessage,
)
from langchain_core.tools import BaseTool
from loguru import logger

from xihe_agent.adapters.approval_tool import APPROVAL_EVENT_SINK_KEY, ApprovalTerminalError
from xihe_agent.adapters.sse_adapter import LangGraphEventAdapter
from xihe_agent.agent_runner.tool_adapter import (
    EVENT_STORE_FAILURES_KEY,
    LCToolAdapter,
    _raise_if_event_store_failed,
    _record_event_store_failure,
    _run_correlation,
    bound_tool_preview,
)
from xihe_agent.interfaces.agent_runner import AgentEvent, AgentRunner, RunnerConfig
from xihe_agent.interfaces.context import AgentContext, bound_tool_arguments
from xihe_agent.interfaces.event import Event
from xihe_agent.interfaces.event_adapter import EventAdapter
from xihe_agent.interfaces.event_store import EventStore
from xihe_agent.interfaces.message import Message, TextMessage
from xihe_agent.interfaces.tool import BaseAgentTool
from xihe_agent.interfaces.usage import RunUsage

# PLAN-0341 T1.2: assembly-layer fuse only — prune is the real governance.
# Truncation must never orphan a tool result (window start lands on a tool
# message → walk back so the preceding call stays paired).
HISTORY_TRUNCATION_LIMIT = 20

# PLAN-294 #17 / PLAN-0341 T1.2: cheapest-first prune of historical tool
# results. Rules (decision #30/#47/#60):
#   - only history OUTSIDE the keep-recent tail is eligible;
#   - eligible tool messages are pruned when byte-identical duplicates of an
#     earlier tool result, longer than TOOL_RESULT_MASK_CHARS, or outside the
#     fixed cumulative prune window (pruneWindowChars);
#   - tool call/result pairing is never broken (adjacency pairs).
MASK_PLACEHOLDER = "[old tool result cleared]"
TOOL_RESULT_MASK_CHARS = 2000
KEEP_RECENT_TAIL = 10
# Fixed (non-sliding) cumulative chars of tool-result content to keep.
# Configurable via context-policy.pruneWindowChars (T1.6); this is the code default.
DEFAULT_PRUNE_WINDOW_CHARS = 80_000


@dataclass
class PruneTombstone:
    """PLAN-0341 Q3 freeze: durable record of a pruned tool result."""

    content_hash: str
    size: int
    head: str
    tail: str
    reason: str
    tool_call_id: str = ""
    pruned: bool = True

    def to_payload(self) -> dict[str, Any]:
        return {
            "tool_call_id": self.tool_call_id,
            "content_hash": self.content_hash,
            "size": self.size,
            "head": self.head,
            "tail": self.tail,
            "pruned": self.pruned,
            "reason": self.reason,
        }


@dataclass
class PruneResult:
    messages: list[Message]
    tombstones: list[PruneTombstone] = field(default_factory=list)


def _content_head_tail(content: str, limit: int = 120) -> tuple[str, str]:
    if len(content) <= limit:
        return content, ""
    return content[:limit], content[-limit:]


def _align_truncation_start(history: Sequence[Message], limit: int) -> int:
    """Window start that never orphans a tool result (T1.2 fuse rule)."""
    start = max(0, len(history) - limit)
    # Walk back while the slice would begin on a tool message so its preceding
    # call (adjacency pair) stays inside the window.
    while start > 0 and start < len(history) and history[start].role == "tool":
        start -= 1
    return start


def prune_history_tool_results(
    history: Sequence[Message],
    prune_window_chars: int = DEFAULT_PRUNE_WINDOW_CHARS,
) -> PruneResult:
    """Prune stale oversized/duplicate/window-overflow tool results.

    Returns the pruned view plus tombstones for every pruned result so the
    operation is a durable, replayable fact (PLAN-0341 I5).
    """
    size = len(history)
    if size <= KEEP_RECENT_TAIL:
        return PruneResult(messages=list(history))
    window_start = size - KEEP_RECENT_TAIL
    seen_contents: set[str] = set()
    # Index → reason. Oldest eligible tool results are pruned first when the
    # cumulative kept size exceeds the fixed prune window.
    prune_reasons: dict[int, str] = {}
    kept_tool_chars = 0
    for i, msg in enumerate(history):
        if msg.role != "tool" or i >= window_start:
            continue
        duplicated = msg.content in seen_contents
        oversized = len(msg.content) > TOOL_RESULT_MASK_CHARS
        if duplicated:
            prune_reasons[i] = "duplicate"
        elif oversized:
            prune_reasons[i] = "oversized"
        else:
            kept_tool_chars += len(msg.content)
            if kept_tool_chars > prune_window_chars:
                prune_reasons[i] = "window"
        seen_contents.add(msg.content)
    if not prune_reasons:
        return PruneResult(messages=list(history))
    tombstones: list[PruneTombstone] = []
    result: list[Message] = []
    for i, msg in enumerate(history):
        if i in prune_reasons:
            digest = hashlib.sha256(msg.content.encode("utf-8", errors="replace")).hexdigest()
            head, tail = _content_head_tail(msg.content)
            tool_call_id = getattr(msg, "tool_call_id", "") or ""
            tombstones.append(
                PruneTombstone(
                    content_hash=digest,
                    size=len(msg.content),
                    head=head,
                    tail=tail,
                    reason=prune_reasons[i],
                    tool_call_id=tool_call_id,
                )
            )
            # PLAN-0381 contract §8: mask swaps content only — pairing fields
            # (id/name/status/degraded) survive so V9 keeps pairs intact.
            if isinstance(msg, TextMessage):
                result.append(replace(msg, content=MASK_PLACEHOLDER))
            else:
                result.append(TextMessage(role="tool", content=MASK_PLACEHOLDER))
        else:
            result.append(msg)
    return PruneResult(messages=result, tombstones=tombstones)


# Back-compat alias used by existing unit tests (PLAN-294 surface).
def _mask_history_tool_results(history: Sequence[Message]) -> list[Message]:
    return prune_history_tool_results(history).messages



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
        # PLAN-0326 决策 #9：本地（非网关路由）工具名集合——事件 origin 判别的依据。
        # approval 是控制流原语（事件被抑制），generate_image 是本地执行工具。
        self._event_adapter = event_adapter or LangGraphEventAdapter(
            local_tool_names={"request_approval", "generate_image"}
        )

    async def stream(
        self,
        messages: list[Message],
        config: RunnerConfig,
    ) -> AsyncIterator[AgentEvent]:
        context = config.context or AgentContext.empty(aggregate_id=str(uuid4()))
        # PLAN-0410 T2.3: the prompt is assembled ONLY from the branch CP gave
        # this run — a config/context branch mismatch fails closed instead of
        # silently building a prompt from a different path.
        config_branch = (getattr(config, "branch_id", "") or "").strip()
        context_branch = (context.branch_id or "").strip()
        if config_branch and context_branch and config_branch != context_branch:
            raise RuntimeError(
                f"runner branch {config_branch} does not match the CP-given context branch {context_branch}"
            )
        prompt_events = (
            [TextMessage(role="human", content=config.admitted_prompt)]
            if config.admitted_prompt is not None
            else messages
        )
        await self._append_prompt_admitted(prompt_events, context)

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
        history: Sequence[Message] = [] if config.template_context else list(context.messages)
        # PLAN-0341 T1.2: assembly fuse only — never orphan a tool result.
        if len(history) > HISTORY_TRUNCATION_LIMIT:
            fuse_start = _align_truncation_start(history, HISTORY_TRUNCATION_LIMIT)
            history = history[fuse_start:]
        # PLAN-0341 T1.2: prune is the real shrinkage; emit tombstones as
        # durable facts so replay cannot resurrect pruned content.
        prune_result = prune_history_tool_results(
            history, prune_window_chars=getattr(config, "prune_window_chars", DEFAULT_PRUNE_WINDOW_CHARS)
        )
        history = prune_result.messages
        if prune_result.tombstones:
            await self._append_prune_event(context, prune_result.tombstones)
        assembled = list(messages) if config.template_context else [*history, *messages]

        system_messages = [] if config.template_context else self._build_system_messages(config, context)
        langchain_messages: list[AnyMessage | dict[str, Any]] = [*system_messages]
        langchain_messages.extend(_to_langchain_messages(assembled))

        agent = create_react_agent(
            model,
            tools=tools,
        )

        inputs: InputAgentState = {"messages": langchain_messages}
        seen_tool_ids: set[str] = set()
        cancel_event = config.cancel_event
        cancelled = False
        assistant_parts: list[str] = []

        try:
            raw_stream = agent.astream_events(inputs, version="v2").__aiter__()
            # ensure_future accepts the Awaitable returned by __anext__ (typeshed
            # types it as Awaitable, not Coroutine; asyncio still schedules it).
            raw_task: asyncio.Future[Any] = asyncio.ensure_future(raw_stream.__anext__())
            approval_task = asyncio.create_task(approval_events.get())
            cancel_wait_task: asyncio.Task[bool] | None = (
                asyncio.create_task(cancel_event.wait()) if cancel_event is not None else None
            )
            try:
                while True:
                    wait_set: set[asyncio.Future[Any]] = {raw_task, approval_task}
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
                        raw_task = asyncio.ensure_future(raw_stream.__anext__())
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
        except litellm.exceptions.ContextWindowExceededError as e:
            # PLAN-294 decision #10 (M3): provider-side overflow is a
            # structured terminal outcome, not a crash — the CP compaction
            # gate consumes CONTEXT_OVERFLOW as the reactive trigger and the
            # retry passes the pre-run gate after compaction.
            logger.info("LangGraph stream hit context window overflow: {}", e)
            yield AgentEvent(
                type="error",
                data={"error": "Context window exceeded", "code": "CONTEXT_OVERFLOW", "retryable": True},
            )
        except Exception as e:
            logger.error("LangGraph stream failed", exc_info=e)
            # PLAN-0410 T2.3: this error already surfaces as the terminal
            # outcome — drop the failure ledger so the post-run check below
            # does not re-raise a duplicate of the same failure.
            context.metadata.pop(EVENT_STORE_FAILURES_KEY, None)
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
                            correlation_id=_run_correlation(context),
                        )
                    )
                except Exception as e:
                    # PLAN-0410 T2.3: required assistant event — recorded here,
                    # converged to a failing run by the post-run check below
                    # (raising inside `finally` would mask the original outcome
                    # and break GeneratorExit cleanup).
                    logger.error("Failed to append assistant.responded event: {}", e, exc_info=True)
                    _record_event_store_failure(context, "assistant.responded", e)
            if cancelled:
                yield AgentEvent(
                    type="error",
                    data={"error": "Run cancelled", "code": "cancelled"},
                )
            yield AgentEvent(type="usage", data=usage.to_event_payload())

        # PLAN-0410 T2.3/spec §4: required prompt/assistant/tool appends that
        # failed (including ones a downstream framework absorbed) converge the
        # run to failure — never a context-less success.
        _raise_if_event_store_failed(context)

    async def create_agent(
        self,
        tools: list[BaseAgentTool],
        config: RunnerConfig,
    ) -> str:
        return str(uuid4())

    async def _append_prompt_admitted(self, messages: Sequence[Message], context: AgentContext) -> None:
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
                        # PLAN-0410 T2.3/spec §7: prompt.admitted MUST carry the
                        # durable run correlation — its sequence is the User
                        # anchor cursor, and an uncorrelated row is explicitly
                        # unanchorable (409), never a silent root guess.
                        correlation_id=_run_correlation(context),
                    )
                )
            except Exception as e:
                logger.error("Failed to append prompt.admitted event: {}", e, exc_info=True)
                _record_event_store_failure(context, "prompt.admitted", e)
                raise

    async def _append_prune_event(self, context: AgentContext, tombstones: list[PruneTombstone]) -> None:
        """PLAN-0341 T1.2/I5: eventize prune as durable tombstones."""
        if self._event_store is None or not tombstones:
            return
        try:
            await self._event_store.append(
                Event(
                    aggregate_id=context.aggregate_id,
                    sequence=0,
                    type="context.prune",
                    payload={
                        "tombstones": [t.to_payload() for t in tombstones],
                        "pruned_count": len(tombstones),
                        "runId": context.metadata.get("runId"),
                    },
                    created_at=datetime.now(UTC),
                    # PLAN-0410 T2.3: tombstones follow their Run's branch.
                    correlation_id=_run_correlation(context),
                )
            )
            logger.info(
                "Prune applied: count={} reasons={}",
                len(tombstones),
                [t.reason for t in tombstones],
            )
        except Exception as e:
            # Not in the spec §4 required set, but never silent: observable
            # error with stacktrace (anti-resurrection facts may be missing).
            logger.error("Failed to append context.prune event: {}", e, exc_info=True)

    def _build_system_messages(
        self,
        config: RunnerConfig,
        context: AgentContext,
    ) -> list[SystemMessage]:
        """PLAN-0307 #28/G5 + PLAN-0340 #19/#32: L0 → L1 → SUM.

        L1 lives in epoch.l1_rendered (or derived from sources) and must not
        depend on history truncation. SUM remains epoch.system_messages.
        """
        messages: list[SystemMessage] = []
        summaries = list(context.epoch.system_messages) if context.epoch and context.epoch.system_messages else []
        if config.system_prompt:
            messages.append(SystemMessage(content=config.system_prompt))
        elif summaries:
            logger.warning(
                "Baseline system prompt missing while compaction summary present; "
                "injecting summary only (PLAN-0307 decision #28)"
            )

        l1_text = ""
        if context.epoch:
            # PLAN-0382 Q2=A (spec §3): the fail-closed family never injects —
            # neither rendered text nor the legacy `sources` fallback may feed
            # the model without an ok state (BL-48: no unmarked fallback).
            # "" (legacy key-absent) with content stays injectable: upgrades
            # must not blank every pre-0382 session's L1.
            l1_status = getattr(context.epoch, "l1_status", "")
            if l1_status not in ("failed", "unavailable", "missing"):
                l1_text = context.epoch.l1_rendered or ""
                if not l1_text and context.epoch.sources:
                    parts = []
                    for source in context.epoch.sources:
                        if source.key.upper().startswith("AGENTS"):
                            parts.append(source.content)
                    l1_text = "\n\n".join(p for p in parts if p)
        if l1_text:
            messages.append(SystemMessage(content=l1_text))

        env_text = _render_env_block(context.epoch)
        if env_text:
            messages.append(SystemMessage(content=env_text))

        for text in summaries:
            messages.append(SystemMessage(content=text))
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

        if usage:
            for event in events:
                if event.type == "tool_call":
                    usage.record_tool_call()
                elif event.type == "tool_result":
                    usage.record_tool_result()
                elif event.type == "token":
                    usage.record_turn()
                elif event.type == "llm_usage":
                    usage.record_llm_usage(
                        input_tokens=event.data.get("inputTokens", 0),
                        output_tokens=event.data.get("outputTokens", 0),
                    )
                    usage.source = str(event.data.get("source", "real"))

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


def _render_env_block(epoch=None) -> str:
    """PLAN-0382 T2.2 (spec §2.1/§4): env facts come ONLY from the snapshot
    (Runtime-reported via CP) — the Agent host never fills cwd/platform/shell
    for a workspace. Unknown/absent facts render as `unknown`, never as a
    host value. `date` is a neutral clock fact (design §3: kept as-is)."""
    from datetime import UTC, datetime

    env_cwd = getattr(epoch, "env_cwd", None)
    env_platform = getattr(epoch, "env_platform", None)
    env_shell = getattr(epoch, "env_shell", None)
    lines = [
        f"cwd: {env_cwd or 'unknown'}",
        f"platform: {env_platform or 'unknown'}",
        f"date: {datetime.now(UTC).strftime('%Y-%m-%d')}",
        f"shell: {env_shell or 'unknown'}",
    ]
    if epoch is not None and getattr(epoch, "env_is_repository", False):
        branch = getattr(epoch, "env_branch", "") or "unknown"
        head = getattr(epoch, "env_head", "") or "unknown"
        lines.append(f"git.branch: {branch}")
        lines.append(f"git.head: {head}")
    body = "\n".join(lines)
    if len(body.encode()) > 4096:
        body = body.encode()[:4096].decode(errors="ignore")
        lines = body.split("\n")
        body = "\n".join(lines)
    return (
        f"<system-reminder>\nWorkspace environment (semi-trusted facts; not project rules):\n{body}\n</system-reminder>"
    )


# PLAN-0381 contract §7: explicit markers for wire-invalid history states.
MISSING_TOOL_RESULT_CONTENT = "[missing tool result: run interrupted]"


def _langchain_tool_status(status: str) -> Literal["success", "error"]:
    """Contract §7: our status domain → LangChain's success/error literal.

    Legacy messages carry no status (the presence of a result event means
    the call completed) → success; failed/interrupted/expired → error.
    """
    normalized = (status or "").strip().lower()
    if normalized in ("", "completed", "success"):
        return "success"
    return "error"


def to_langchain_messages(messages: list[Message]) -> list[AnyMessage]:
    """PLAN-0381 T1.4 / contract §7: provider mapping with explicit pairing.

    Reconstructs assistant tool-call declarations + tool results into the
    provider protocol shape without ever re-executing historical calls:
    unanswered calls get an explicit missing-result marker, unpaired results
    degrade to system text facts (never a fabricated pair).
    """
    result: list[AnyMessage] = []
    pending: dict[str, str] = {}  # tool_call_id -> tool_name (contract §7)

    def _flush_missing() -> None:
        # Contract §7.5: a declaration must be answered before any non-tool
        # message — synthesized marker keeps the wire protocol valid while
        # never claiming a completed result.
        for missing_id in list(pending):
            missing_name = pending.pop(missing_id)
            result.append(
                ToolMessage(
                    content=MISSING_TOOL_RESULT_CONTENT,
                    tool_call_id=missing_id,
                    name=missing_name or None,
                    status="error",
                )
            )

    for message in messages:
        role = message.role
        if role == "ai":
            tool_calls = getattr(message, "tool_calls", ())
            if tool_calls:
                _flush_missing()
                result.append(
                    AIMessage(
                        content=message.content,
                        tool_calls=[
                            {
                                "name": ref.tool_name,
                                "args": bound_tool_arguments(ref.arguments),
                                "id": ref.call_id,
                            }
                            for ref in tool_calls
                        ],
                    )
                )
                for ref in tool_calls:
                    pending[ref.call_id] = ref.tool_name
                continue
            _flush_missing()
            result.append(AIMessage(content=message.content))
            continue
        if role == "tool":
            call_id = getattr(message, "tool_call_id", "") or ""
            tool_name = getattr(message, "tool_name", "") or "unknown"
            if call_id and call_id in pending:
                pending.pop(call_id, None)
                # Frozen #1 历史回放条款（review P1-2）：回放进模型前统一 4096
                # 界。本函数只塑造回放前缀——当前轮 ToolMessage 由 LangGraph
                # 自建、不经过这里，因此当轮诊断块/jit 不受影响。
                content, _ = bound_tool_preview(message.content, None)
                result.append(
                    ToolMessage(
                        content=content,
                        tool_call_id=call_id,
                        name=getattr(message, "tool_name", "") or None,
                        status=_langchain_tool_status(getattr(message, "status", "")),
                    )
                )
                continue
            # Contract §7.4: no declaration (legacy/fork/compaction-split) —
            # degrade to a text fact, never a fabricated pair. 先组装降级事实
            # 再整体加界（标签前缀计入 4096 预算）。
            logger.warning("Degrading unpaired tool result to a text fact: toolCallId={!r}", call_id)
            degraded, _ = bound_tool_preview(
                f"[unpaired tool result: {tool_name}] {message.content}", None
            )
            result.append(SystemMessage(content=degraded))
            continue
        # human / system / plain ai: flush pending declarations first (§7.5)
        _flush_missing()
        if role == "system":
            result.append(SystemMessage(content=message.content))
        elif role == "human":
            result.append(HumanMessage(content=message.content))
        else:
            result.append(AIMessage(content=message.content))
    _flush_missing()
    return result


# Back-compat alias: existing call sites and tests import the private name.
_to_langchain_messages = to_langchain_messages
