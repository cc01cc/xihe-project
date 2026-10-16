"""`POST /internal/v1/agent/chat` — SSE chat streaming route.

Moved verbatim from `main.py` (PLAN-0473 T2.2); request parsing, run-config
resolution, event translation, and terminal-outcome semantics unchanged.
"""

import asyncio
from typing import Any
from uuid import uuid4

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse, StreamingResponse
from litellm import get_llm_provider as _litellm_get_llm_provider  # noqa: F401  (provider util parity)
from loguru import logger

from xihe_agent.adapters.api_chat_model import ApiChatModel, native_history, native_tools
from xihe_agent.adapters.approval_tool import ApprovalExecutorUnsupportedError, ApprovalTerminalError
from xihe_agent.adapters.sse_adapter import render_sse
from xihe_agent.agent_runner import LangGraphRunner
from xihe_agent.agent_runner.langgraph_runner import prune_history_tool_results
from xihe_agent.api.shared import problem_details, verify_api_token
from xihe_agent.app_state import (
    AGENT_USER_NAME,
    USE_SUPERVISOR,
    _classify_llm_exception,
    _content_length,
    _estimate_input_tokens,
    _estimate_native_body_tokens,
    _get_tools_for_mode,
    _merge_run_domain,
    _model_window_tokens,
    _normalize_run_overrides,
    _normalize_tool_timeouts,
    _resolve_loop_guard,
    _resolve_policy_for_model,
    _resolve_run_budget,
    _validate_run_overrides,
    approval_tool,
    config_client,
    context_provider,
    cp_event_store_client,
    generate_image_tool,
    run_cancel_registry,
)
from xihe_agent.config_client import ProviderLeaseError
from xihe_agent.interfaces.agent_runner import AgentEvent, RunnerConfig
from xihe_agent.interfaces.chat_run_context import ContextBuildError
from xihe_agent.interfaces.event import Event
from xihe_agent.interfaces.message import TextMessage
from xihe_agent.llm.api_request import ApiRequestError, render_request, uses_rag_context, validate_snapshot
from xihe_agent.llm.base import LLMConfig, parse_model_params
from xihe_agent.llm.models import fetch_model_catalog  # noqa: F401  (import parity with prior main)
from xihe_agent.rag.chat_context import retrieve_chat_context

router = APIRouter()

# PLAN-0416 T2.3: normalized provider counter -> usage wire field.
_PROVIDER_USAGE_WIRE: dict[str, str] = {
    "input_tokens": "inputTokens",
    "output_tokens": "outputTokens",
    "cache_read_input_tokens": "cacheReadInputTokens",
}


def _apply_provider_usage(usage_data: dict[str, Any], model: ApiChatModel) -> None:
    """Separate provider truth from local estimation (PLAN-0416 T2.3).

    Only counters the provider actually returned are surfaced; a counter no
    dispatched step reported is dropped from the wire and listed as unknown
    instead of being reported as 0. `source` keeps describing the provider
    counters, so cost mapping still sees `real` only for real numbers.
    """
    reported = model.provider_reported
    totals = model.provider_usage_totals
    for counter, wire in _PROVIDER_USAGE_WIRE.items():
        if counter in reported:
            usage_data[wire] = totals[counter]
        else:
            usage_data.pop(wire, None)
    if {"input_tokens", "output_tokens"} <= reported:
        usage_data["totalTokens"] = totals["input_tokens"] + totals["output_tokens"]
    else:
        usage_data.pop("totalTokens", None)
    unknown = sorted(model.provider_unknown)
    if unknown:
        usage_data["providerUnknownFields"] = unknown
    else:
        usage_data.pop("providerUnknownFields", None)
    if reported:
        usage_data["source"] = "real"
    else:
        usage_data["source"] = "estimated" if usage_data.get("estimatedInputTokens") else "fallback"


def _rag_config_defaults() -> dict[str, Any]:
    """PLAN-0307 T2.4: RAG defaults come from the DB `rag` domain; request params win."""
    from xihe_agent.app_state import embedding_enabled  # noqa: F401

    return {
        "chunkSize": int(config_client.get("rag", "chunkSize") or 1000),
        "chunkOverlap": int(config_client.get("rag", "chunkOverlap") or 200),
        "topK": int(config_client.get("rag", "topK") or 5),
        "minScore": float(config_client.get("rag", "minScore") or 0.0),
    }


@router.post("/internal/v1/agent/chat", dependencies=[Depends(verify_api_token)])
async def chat(request: Request):
    data = await request.json()
    content: str = data.get("content", "")
    session_id: str = data.get("sessionId", "default")
    workspace_id: str | None = data.get("workspaceId") or None
    request_id: str = request.headers.get("X-Request-Id") or str(uuid4())
    run_id: str = request.headers.get("X-Chat-Run-Id") or data.get("runId") or str(uuid4())
    model_override: str | None = data.get("model")
    provider_override: str | None = data.get("provider")
    tool_mode: str = data.get("toolMode", "none")
    # PLAN-0416 T3.1: instructions are CP-owned and arrive only via the chat
    # request (resolved from the AgentPrincipal). The Agent keeps no
    # process-level AGENT_INSTRUCTIONS fallback; an absent/blank baseline fails
    # closed before any provider dispatch. Summary/RAG/tool/file data must never
    # fill this authority slot - the check runs before RAG enrichment so
    # retrieved context cannot stand in for the CP-owned baseline.
    raw_instructions = data.get("instructions", "")
    instructions: str = raw_instructions if isinstance(raw_instructions, str) else ""
    if not instructions.strip():
        logger.warning(
            "Chat rejected requestId={} runId={} code=BASELINE_UNAUTHORIZED",
            request_id,
            run_id,
        )
        return problem_details(
            request_id,
            400,
            "BASELINE_UNAUTHORIZED",
            "Agent instructions baseline is missing or empty",
        )
    credential_lease: str | None = data.get("credentialLease") or None
    provider_connection_id: str | None = data.get("providerConnectionId") or None
    connection_revision = data.get("connectionRevision")

    # PLAN-0308 M1（spec S1/S2）：CP 计算好的 per-tool 等待值（Agent 侧最终值）
    # 与性质标记（per-call | config）。本模块只消费，不计算。
    tool_waits_raw = data.get("toolWaits")
    tool_waits: dict[str, float] = {}
    if isinstance(tool_waits_raw, dict):
        for tool_name, seconds in tool_waits_raw.items():
            if isinstance(seconds, (int, float)) and not isinstance(seconds, bool) and seconds > 0:
                tool_waits[str(tool_name)] = float(seconds)
            else:
                logger.warning("Ignoring invalid toolWaits entry {}={!r}", tool_name, seconds)
    system_tool_wait_raw = data.get("systemToolWait")
    system_tool_wait: float | None = None
    if (
        isinstance(system_tool_wait_raw, (int, float))
        and not isinstance(system_tool_wait_raw, bool)
        and system_tool_wait_raw > 0
    ):
        system_tool_wait = float(system_tool_wait_raw)

    tool_wait_origins: dict[str, str] = {}
    tool_wait_origins_raw = data.get("toolWaitOrigins")
    if isinstance(tool_wait_origins_raw, dict):
        for tool_name, origin in tool_wait_origins_raw.items():
            if origin in ("per-call", "config"):
                tool_wait_origins[str(tool_name)] = str(origin)

    # PLAN-0308 M1 T1.9（决策 #27/#28）：per-call 原始值（CP 已校验、随 run 回传）；
    # 本模块不改值、不计算，仅在工具调用时附带入站头 X-Xihe-Tool-Timeout-Per-Call。
    tool_timeouts = _normalize_tool_timeouts(data.get("toolTimeouts"))

    # PLAN-0307 T2.7 (decision #3=#3a): CP-resolved per-run layer overrides.
    raw_user_overrides = data.get("userOverrides")
    raw_workspace_overrides = data.get("workspaceOverrides")
    for field, raw in (
        ("userOverrides", raw_user_overrides),
        ("workspaceOverrides", raw_workspace_overrides),
    ):
        validation_error = _validate_run_overrides(raw, field)
        if validation_error:
            return JSONResponse(
                status_code=400,
                media_type="application/problem+json",
                headers={"X-Request-Id": request_id},
                content={
                    "type": "https://xihe.dev/problems/invalid-request",
                    "title": "Invalid run overrides",
                    "status": 400,
                    "code": "INVALID_REQUEST",
                    "detail": validation_error,
                    "requestId": request_id,
                    "runId": run_id,
                },
            )
    user_overrides = _normalize_run_overrides(raw_user_overrides)
    workspace_overrides = _normalize_run_overrides(raw_workspace_overrides)

    profile_entries = _merge_run_domain("agent-profile", user_overrides, workspace_overrides)
    user_name: str = data.get("userName") or profile_entries.get("userName") or AGENT_USER_NAME

    if tool_mode not in {"none", "workspace"}:
        return problem_details(request_id, 400, "INVALID_REQUEST", "toolMode must be none or workspace")

    try:
        api_type, template_snapshot = validate_snapshot(data)
        # Validate the source before consuming the one-use lease. Source values
        # and authorized tools are resolved later, but syntax/placement checks
        # use non-secret typed fixtures and send no provider request.
        render_request(
            template_snapshot["template"]["bodySource"],
            api_type,
            {
                "model": str(model_override or ""),
                "user_input": content,
                "agent_instructions": instructions,
                "rag_context": "",
                "conversation_history": [{"role": "user", "content": ""}],
                "tools": [],
            },
        )
        grant = await config_client.redeem_provider_lease(
            {
                "lease": credential_lease,
                "runId": run_id,
                "providerConnectionId": provider_connection_id,
                "providerId": provider_override,
                "model": model_override,
                "connectionRevision": connection_revision,
            },
            request_id=request_id,
        )
        if (
            grant.get("apiTypeId") != api_type.id
            or grant.get("apiTypeVersion") != api_type.version
            or grant.get("operation") != "chat"
            or grant.get("connectionRevision") != connection_revision
            or grant.get("provider") != provider_override
            or grant.get("model") != model_override
        ):
            raise ApiRequestError("API_TYPE_TEMPLATE_MISMATCH", 409)
        rag_context, rag_matches = "", 0
        rag_state: str | None = "disabled"
        if uses_rag_context(template_snapshot["template"]["bodySource"]):
            rag_context, rag_state, rag_matches = await retrieve_chat_context(data, content, run_id, request_id)
    except (ApiRequestError, ProviderLeaseError) as exc:
        code = exc.terminal_code if isinstance(exc, ApiRequestError) else exc.code
        logger.warning("Chat rejected requestId={} runId={} code={}", request_id, run_id, exc.code)
        return JSONResponse(
            status_code=exc.status,
            media_type="application/problem+json",
            headers={"X-Request-Id": request_id},
            content={
                "type": "https://xihe.dev/problems/api-request",
                "title": "Chat request unavailable",
                "status": exc.status,
                "code": code,
                "detail": str(exc),
                "retryable": False,
                "requestId": request_id,
                "runId": run_id,
            },
        )
    except Exception as exc:
        logger.warning(
            "Provider lease transport unavailable requestId={} runId={} errorType={}",
            request_id,
            run_id,
            type(exc).__name__,
        )
        return problem_details(request_id, 503, "PROVIDER_CONNECTION_UNAVAILABLE", "Provider connection unavailable")

    run_llm_entries = _merge_run_domain("llm-provider", user_overrides, workspace_overrides)
    # PLAN-0523 decisions #9/#12: per-model sampling overrides from the layer
    # modelParams map; a valid model-level timeout beats the legacy global key.
    effective_model = str(model_override or "")
    model_params = parse_model_params(run_llm_entries, effective_model)
    request_config = LLMConfig(
        provider=str(provider_override),
        model=effective_model,
        timeout=(
            float(model_params["timeout"])
            if model_params and "timeout" in model_params
            else float(run_llm_entries.get("timeout") or "60")
        ),
    )
    sampling_overrides: dict[str, Any] = {}
    if model_params:
        if "temperature" in model_params:
            sampling_overrides["temperature"] = model_params["temperature"]
        if "maxTokens" in model_params:
            sampling_overrides["max_tokens"] = model_params["maxTokens"]

    logger.info(
        "[LIFECYCLE] service=agent event=chat_stream_started requestId={} sessionId={} workspaceId={} runId={} provider={} model={} contentLength={}",
        request_id,
        session_id,
        workspace_id,
        run_id,
        request_config.provider,
        request_config.model,
        len(content),
    )

    # Register before streaming so CP cancel can reach an in-flight run.
    cancel_event = run_cancel_registry.register(run_id)

    async def event_stream():
        terminal_sent = False
        error_sent = False
        error_seen = False
        llm_request_started = False
        terminal_outcome = "success"
        terminal_error_code: str | None = None
        token_count = 0
        assistant_chars = 0
        event_index = 0

        def correlated_data(event_data: dict[str, Any]) -> dict[str, Any]:
            payload = dict(event_data)
            payload.setdefault("requestId", request_id)
            payload.setdefault("runId", run_id)
            return payload

        try:
            rag_observation: dict[str, Any] = {"phase": "rag", "matches": rag_matches}
            if rag_state is not None:
                rag_observation["state"] = rag_state
            yield render_sse("status", correlated_data(rag_observation))
            mcp_tools = await _get_tools_for_mode(tool_mode, workspace_id)
            if USE_SUPERVISOR and tool_mode == "workspace":
                raise ApprovalExecutorUnsupportedError("Approval is not supported by the buffered supervisor executor")
            else:
                # PLAN-0410 T2.3: the snapshot is scoped to this Run's branch;
                # CP resolves/validates the branch from the durable runId.
                context = await context_provider.load(session_id, after_sequence=0, run_id=run_id)
                context.runtime_state["user_name"] = user_name
                context.runtime_state["instructions"] = instructions
                context.runtime_state["toolWaits"] = tool_waits
                context.runtime_state["toolWaitOrigins"] = tool_wait_origins
                context.runtime_state["systemToolWait"] = system_tool_wait
                context.runtime_state["toolTimeouts"] = tool_timeouts
                context.metadata.update(
                    {
                        "requestId": request_id,
                        "runId": run_id,
                        "sessionId": session_id,
                        "workspaceId": workspace_id,
                        "branchId": context.branch_id,
                    }
                )

                all_tools = [] if tool_mode == "none" else [approval_tool, generate_image_tool]
                if mcp_tools:
                    all_tools = list(mcp_tools) + all_tools

                policy = _resolve_policy_for_model(
                    model_override or request_config.model, user_overrides, workspace_overrides
                )
                pruned = prune_history_tool_results(context.messages, policy.prune_window_chars)
                if pruned.tombstones:
                    from datetime import UTC, datetime

                    await cp_event_store_client.append(
                        Event(
                            aggregate_id=context.aggregate_id,
                            sequence=0,
                            type="context.prune",
                            payload={
                                "tombstones": [item.to_payload() for item in pruned.tombstones],
                                "pruned_count": len(pruned.tombstones),
                                "runId": run_id,
                            },
                            created_at=datetime.now(UTC),
                            correlation_id=run_id,
                        )
                    )
                context.messages = pruned.messages

                # PLAN-0508: the model's transport collector publishes bounded
                # provider-attempt telemetry into this queue; the runner fans it
                # into the same SSE stream, and correlated_data adds
                # requestId/runId on the way out.
                transport_events: asyncio.Queue[AgentEvent] = asyncio.Queue()

                def publish_transport(event_type: str, payload: dict[str, Any]) -> None:
                    transport_events.put_nowait(AgentEvent(type=event_type, data=payload))

                model = ApiChatModel(
                    api_type=api_type,
                    grant=grant,
                    body_source=template_snapshot["template"]["bodySource"],
                    values={
                        "model": str(model_override),
                        "user_input": content,
                        "agent_instructions": instructions,
                        "rag_context": rag_context,
                        "conversation_history": native_history(context.messages, api_type),
                        "tools": native_tools(all_tools, api_type),
                    },
                    request_id=request_id,
                    timeout=request_config.timeout,
                    sampling_overrides=sampling_overrides or None,
                    token_estimator=_estimate_native_body_tokens,
                    transport_sink=publish_transport,
                )
                request_runner = LangGraphRunner(model_factory=lambda _model: model, event_store=cp_event_store_client)
                # The Runner owns approval/durable/tool execution. This prompt is
                # its admitted event input, not a provider-neutral body builder.
                messages = [TextMessage(role="human", content=content)]
                has_template = True

                loop_thresholds, loop_exempt_tools = _resolve_loop_guard(
                    user_overrides, workspace_overrides
                )
                config = RunnerConfig(
                    model=model_override or request_config.model,
                    system_prompt="" if has_template else instructions,
                    tools=all_tools,
                    context=context,
                    cancel_event=cancel_event,
                    # PLAN-0492 T2.1: CP-resolved cumulative budget (ceiling-clamped
                    # observation-only when 0); the runner only enforces.
                    budget=_resolve_run_budget(user_overrides, workspace_overrides),
                    # PLAN-0493 T2.1/T2.2: CP-resolved loop/no-progress guard
                    # (thresholds ceiling-clamped; exempt = builtin ∪ configured).
                    loop=loop_thresholds,
                    loop_exempt_tools=loop_exempt_tools,
                    prune_window_chars=policy.prune_window_chars,
                    branch_id=context.branch_id,
                    template_context=has_template,
                    admitted_prompt=content,
                    # PLAN-0508: bounded provider-attempt telemetry fan-in.
                    transport_events=transport_events,
                )

                llm_request_started = True
                async for event in request_runner.stream(messages, config):
                    if event.type == "token":
                        token_chars = _content_length(event.data.get("content"))
                        token_count += 1
                        event_index += 1
                        if event.data.get("hint") != "reasoning":
                            assistant_chars += token_chars
                        logger.debug(
                            "[LIFECYCLE] service=agent event=chat_stream_chunk requestId={} sessionId={} runId={} eventIndex={} tokenChars={}",
                            request_id,
                            session_id,
                            run_id,
                            event_index,
                            token_chars,
                        )
                        yield render_sse("token", correlated_data(event.data))
                    elif event.type == "error":
                        error_seen = True
                        structured_code = event.data.get("code")
                        if structured_code:
                            terminal_error_code = str(structured_code)
                            error_detail = str(event.data.get("error", "Agent stream failed"))
                            retryable = False
                        else:
                            terminal_error_code, error_detail, retryable = _classify_llm_exception(
                                RuntimeError(str(event.data.get("error", "Agent stream failed")))
                            )
                        terminal_outcome = (
                            "ambiguous"
                            if llm_request_started
                            and terminal_error_code in {"LLM_PROVIDER_UNREACHABLE", "AGENT_STREAM_FAILED"}
                            else "partial"
                            if assistant_chars > 0
                            else "error"
                        )
                        if not error_sent:
                            error_sent = True
                            error_payload = {
                                "code": terminal_error_code,
                                "detail": error_detail,
                                "retryable": retryable,
                                "outcome": terminal_outcome,
                                "type": "error",
                            }
                            # PLAN-0492 T2.2: the exhausted run-budget dimension
                            # must survive the SSE mapping — the CP relay records
                            # it as the durable terminal fact (`budgetDimension`).
                            exhausted_dimension = event.data.get("dimension")
                            if isinstance(exhausted_dimension, str) and exhausted_dimension:
                                error_payload["dimension"] = exhausted_dimension
                            yield render_sse("error", correlated_data(error_payload))
                    elif event.type == "done":
                        if terminal_sent:
                            continue
                        terminal_sent = True
                        done_data = {**event.data, "type": "done", "outcome": terminal_outcome}
                        if terminal_error_code:
                            done_data["errorCode"] = terminal_error_code
                        yield render_sse("done", correlated_data(done_data))
                    elif event.type == "usage":
                        # PLAN-0416 T2.3: the estimate is the final serialized
                        # native request body of the steps this Run actually
                        # dispatched (tools/history/RAG/instructions/current
                        # input), recorded beside — never in place of — the
                        # provider's own counters.
                        usage_data = dict(event.data.get("usage") or {})
                        usage_data["estimatedInputTokens"] = model.estimated_input_tokens or _estimate_input_tokens(
                            messages
                        )
                        _apply_provider_usage(usage_data, model)
                        # PLAN-294 M3 (decision #5): the model window rides
                        # along so the CP compaction gate can evaluate the
                        # percentage threshold without a config dependency.
                        usage_data["windowTokens"] = _model_window_tokens(
                            request_config.model, user_overrides, workspace_overrides
                        )
                        # PLAN-0343 decision #10: the model string is the
                        # aggregation key and the CP pricing lookup key.
                        # Spec key shape is provider/model; request_config.model
                        # is the bare model name, so prefix the CP provider id
                        # (matches pricing.models keys, e.g. deepseek/deepseek-v4-flash).
                        usage_model = model_override or request_config.model
                        if usage_model and request_config.provider and "/" not in usage_model:
                            usage_model = f"{request_config.provider}/{usage_model}"
                        usage_data["model"] = usage_model
                        yield render_sse("usage", correlated_data({"usage": usage_data}))
                    else:
                        yield render_sse(event.type, correlated_data(event.data))
        except ApprovalTerminalError as exc:
            error_seen = True
            terminal_error_code = exc.code
            error_detail = str(exc)
            retryable = False
            terminal_outcome = "error"
            logger.info(
                "[LIFECYCLE] service=agent event=chat_approval_terminal requestId={} sessionId={} workspaceId={} runId={} errorCode={}",
                request_id,
                session_id,
                workspace_id,
                run_id,
                terminal_error_code,
            )
            if not error_sent:
                error_sent = True
                yield render_sse(
                    "error",
                    correlated_data(
                        {
                            "code": terminal_error_code,
                            "detail": error_detail,
                            "retryable": retryable,
                            "outcome": terminal_outcome,
                            "type": "error",
                        }
                    ),
                )
        except ApiRequestError as exc:
            error_seen = True
            terminal_error_code = exc.terminal_code
            terminal_outcome = "partial" if assistant_chars else "error"
            logger.warning("API request rejected requestId={} runId={} code={}", request_id, run_id, exc.code)
            if not error_sent:
                error_sent = True
                yield render_sse(
                    "error",
                    correlated_data(
                        {
                            "code": exc.terminal_code,
                            "detail": exc.code,
                            "retryable": False,
                            "outcome": terminal_outcome,
                            "type": "error",
                        }
                    ),
                )
        except ContextBuildError as exc:
            error_seen = True
            terminal_error_code = "CONTEXT_BUILD_FAILED"
            terminal_outcome = "error"
            logger.warning(
                "Context template build failed requestId={} runId={} errorType={}",
                request_id,
                run_id,
                type(exc).__name__,
                exc_info=True,
            )
            if not error_sent:
                error_sent = True
                yield render_sse(
                    "error",
                    correlated_data(
                        {
                            "code": terminal_error_code,
                            "detail": "Context template snapshot is invalid",
                            "retryable": False,
                            "outcome": terminal_outcome,
                            "type": "error",
                        }
                    ),
                )
        except Exception as exc:
            error_seen = True
            terminal_error_code, error_detail, retryable = _classify_llm_exception(exc)
            terminal_outcome = (
                "ambiguous"
                if llm_request_started and terminal_error_code in {"LLM_PROVIDER_UNREACHABLE", "AGENT_STREAM_FAILED"}
                else "partial"
                if assistant_chars > 0
                else "error"
            )
            logger.error(
                "[LIFECYCLE] service=agent event=chat_stream_failed requestId={} sessionId={} workspaceId={} runId={} errorCode={} errorType={}",
                request_id,
                session_id,
                workspace_id,
                run_id,
                terminal_error_code,
                type(exc).__name__,
            )
            if not error_sent:
                error_sent = True
                yield render_sse(
                    "error",
                    correlated_data(
                        {
                            "code": terminal_error_code,
                            "detail": error_detail,
                            "retryable": retryable,
                            "outcome": terminal_outcome,
                            "type": "error",
                        }
                    ),
                )
        finally:
            # Always drop the cancel handle when the run body ends (terminal,
            # abort, or client disconnect) so later cancels report unknown.
            run_cancel_registry.unregister(run_id)

        if not terminal_sent:
            terminal_sent = True
            if not error_seen:
                terminal_outcome = "ambiguous"
            done_data: dict[str, Any] = {
                "type": "done",
                "synthetic": True,
                "outcome": terminal_outcome,
            }
            if error_seen and terminal_error_code:
                done_data["errorCode"] = terminal_error_code
            yield render_sse("done", correlated_data(done_data))

        logger.info(
            "[LIFECYCLE] service=agent event=chat_stream_finished requestId={} sessionId={} workspaceId={} runId={} tokenCount={} assistantChars={} outcome={}",
            request_id,
            session_id,
            workspace_id,
            run_id,
            token_count,
            assistant_chars,
            terminal_outcome,
        )

    return StreamingResponse(event_stream(), media_type="text/event-stream")


__all__ = ["router", "_rag_config_defaults", "problem_details"]
