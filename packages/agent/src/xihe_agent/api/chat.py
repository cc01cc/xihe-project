"""`POST /internal/v1/agent/chat` — SSE chat streaming route.

Moved verbatim from `main.py` (PLAN-0473 T2.2); request parsing, run-config
resolution, event translation, and terminal-outcome semantics unchanged.
"""

from typing import Any, cast
from uuid import uuid4

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse, StreamingResponse
from litellm import get_llm_provider as _litellm_get_llm_provider  # noqa: F401  (provider util parity)
from loguru import logger

from xihe_agent.adapters.approval_tool import ApprovalExecutorUnsupportedError, ApprovalTerminalError
from xihe_agent.adapters.sse_adapter import render_sse
from xihe_agent.agent_runner import LangGraphRunner
from xihe_agent.api.shared import problem_details, verify_api_token
from xihe_agent.app_state import (
    AGENT_INSTRUCTIONS,
    AGENT_USER_NAME,
    USE_REGISTRY,
    USE_SUPERVISOR,
    _classify_llm_exception,
    _content_length,
    _deserialize_messages,
    _enrich_with_rag_context,
    _estimate_input_tokens,
    _get_tools_for_mode,
    _has_instance_fallback_credentials,
    _llm_readiness_error_code,
    _merge_run_domain,
    _model_catalog,
    _model_window_tokens,
    _normalize_run_overrides,
    _normalize_tool_timeouts,
    _resolve_policy_for_model,
    _to_langchain_messages,
    _token_counter,
    _validate_run_overrides,
    approval_tool,
    config_client,
    context_provider,
    cp_event_store_client,
    generate_image_tool,
    llm_config,
    run_cancel_registry,
    worker_registry,
)
from xihe_agent.context.builder import build_context
from xihe_agent.interfaces.agent_runner import RunnerConfig
from xihe_agent.interfaces.chat_run_context import ChatRunContext, ContextBuildError
from xihe_agent.interfaces.message import TextMessage
from xihe_agent.llm.base import LLMConfig, ProviderName, create_llm, fallback_provider_configs
from xihe_agent.llm.models import fetch_model_catalog  # noqa: F401  (import parity with prior main)

router = APIRouter()

_SAFE_CONTEXT_DIAGNOSTIC_CODES = {
    "root_agents_md_missing",
    "runtime_environment_missing",
    "tool_definitions_max_tools_reached",
    "tool_definitions_budget_truncated",
    "artifact_status_available",
    "artifact_status_expired",
    "artifact_status_unavailable",
    "artifact_status_unknown",
    "invalid_session_workspace_binding",
    "unsupported_tree_root",
    "runtime_returned_invalid_path",
    "entry_limit_reached",
}


def _rag_config_defaults() -> dict[str, Any]:
    """PLAN-0307 T2.4: RAG defaults come from the DB `rag` domain; request params win."""
    from xihe_agent.app_state import embedding_enabled, vector_store  # noqa: F401

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
    safe_agent_instructions: str = data.get("instructions", "")
    instructions: str = safe_agent_instructions or AGENT_INSTRUCTIONS
    chat_history_raw: list[dict[str, Any]] = data.get("history", [])
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

    from xihe_agent.app_state import _llm_ready

    if _llm_ready != "ready" and not credential_lease:
        error_code = _llm_readiness_error_code(_llm_ready)
        return JSONResponse(
            status_code=503,
            media_type="application/problem+json",
            headers={"X-Request-Id": request_id},
            content={
                "type": "https://xihe.dev/problems/llm-not-ready",
                "title": "LLM is not ready",
                "status": 503,
                "code": error_code,
                "detail": f"Agent LLM readiness is {_llm_ready}",
                "retryable": True,
                "provider": llm_config.provider,
                "model": model_override or llm_config.model,
                "requestId": request_id,
                "runId": run_id,
            },
        )

    if tool_mode not in {"none", "workspace"}:
        return JSONResponse(
            status_code=400,
            media_type="application/problem+json",
            headers={"X-Request-Id": request_id},
            content={
                "type": "https://xihe.dev/problems/invalid-tool-mode",
                "title": "Invalid tool mode",
                "status": 400,
                "code": "INVALID_REQUEST",
                "detail": "toolMode must be none or workspace",
                "requestId": request_id,
                "runId": run_id,
            },
        )

    run_llm_entries = _merge_run_domain("llm-provider", user_overrides, workspace_overrides)
    run_llm_config = LLMConfig.from_entries(run_llm_entries)

    request_config: LLMConfig
    if credential_lease:
        try:
            grant = await config_client.redeem_provider_lease(
                {
                    "lease": credential_lease,
                    "runId": run_id,
                    "providerConnectionId": provider_connection_id or "",
                    "providerId": provider_override or "",
                    "model": model_override or "",
                    "connectionRevision": int(connection_revision or 0),
                }
            )
        except Exception as exc:
            logger.warning(
                "Provider credential lease unavailable runId={} connectionId={} errorType={}",
                run_id,
                provider_connection_id,
                type(exc).__name__,
            )
            return JSONResponse(
                status_code=503,
                media_type="application/problem+json",
                headers={"X-Request-Id": request_id},
                content={
                    "type": "https://xihe.dev/problems/provider-connection-unavailable",
                    "title": "Provider connection unavailable",
                    "status": 503,
                    "code": "PROVIDER_CONNECTION_UNAVAILABLE",
                    "detail": "The selected provider connection is unavailable",
                    "retryable": True,
                    "provider": provider_override or "",
                    "model": model_override or "",
                    "requestId": request_id,
                    "runId": run_id,
                },
            )
        request_config = LLMConfig(
            provider=str(grant.get("provider", provider_override or "")),
            route_provider=str(grant.get("routeProvider", grant.get("provider", ""))),
            api_key=str(grant.get("apiKey") or ""),
            api_base=str(grant.get("baseUrl") or ""),
            model=str(grant.get("model") or model_override or ""),
            # T2.7: user/workspace model params apply even when the lease owns
            # the credential (grant carries key/base/model only).
            timeout=run_llm_config.timeout,
            max_tokens=run_llm_config.max_tokens,
            temperature=run_llm_config.temperature,
        )
    else:
        request_config = run_llm_config
    if not credential_lease and provider_override and provider_override != run_llm_config.provider:
        provider_info = _model_catalog.get("providers", {}).get(provider_override)
        provider_runtime = fallback_provider_configs(run_llm_entries).get(provider_override)
        if not isinstance(provider_info, dict) or provider_info.get("status") != "ready" or not provider_runtime:
            return JSONResponse(
                status_code=503,
                media_type="application/problem+json",
                headers={"X-Request-Id": request_id},
                content={
                    "type": "https://xihe.dev/problems/model-unavailable",
                    "title": "Provider is not ready",
                    "status": 503,
                    "code": "LLM_MODEL_UNAVAILABLE",
                    "detail": "Selected provider is not ready",
                    "retryable": True,
                    "provider": provider_override,
                    "model": model_override or "",
                    "requestId": request_id,
                    "runId": run_id,
                },
            )
        request_config = LLMConfig(
            provider=cast(ProviderName, provider_override),
            api_key=str(provider_runtime.get("apiKey", "")),
            api_base=str(provider_runtime.get("baseUrl", "")),
            model=str(provider_runtime.get("model", "")),
            timeout=run_llm_config.timeout,
            max_tokens=run_llm_config.max_tokens,
            temperature=run_llm_config.temperature,
        )
    if model_override:
        request_config = request_config.with_model(model_override)

    # PLAN-0307 T2.13 fail-closed: a run without a lease relies on the instance
    # env fallback; stop before calling the provider with empty credentials.
    if not credential_lease and not _has_instance_fallback_credentials(request_config):
        return JSONResponse(
            status_code=503,
            media_type="application/problem+json",
            headers={"X-Request-Id": request_id},
            content={
                "type": "https://xihe.dev/problems/llm-not-configured",
                "title": "LLM credentials are not configured",
                "status": 503,
                "code": "LLM_NOT_CONFIGURED",
                "detail": "No provider connection lease and no instance fallback credentials",
                "retryable": True,
                "provider": request_config.provider,
                "model": request_config.model,
                "requestId": request_id,
                "runId": run_id,
            },
        )

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

    # Enrich with RAG context if knowledge base has content
    instructions = await _enrich_with_rag_context(content, instructions)

    chat_history = _deserialize_messages(chat_history_raw)
    model = create_llm(request_config)
    # Register before streaming so CP cancel can reach an in-flight run.
    cancel_event = run_cancel_registry.register(run_id)
    request_runner = LangGraphRunner(
        model_factory=lambda _model: create_llm(request_config),
        event_store=cp_event_store_client,
    )

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
            mcp_tools = await _get_tools_for_mode(tool_mode, workspace_id)
            if USE_SUPERVISOR and tool_mode == "workspace":
                raise ApprovalExecutorUnsupportedError("Approval is not supported by the buffered supervisor executor")
                # Supervisor path remains on legacy tools until full migration.
                from langchain_core.messages import HumanMessage

                from xihe_agent.agent.supervisor import build_supervisor

                custom_tools = [approval_tool, generate_image_tool]
                supervisor = build_supervisor(
                    model,
                    mcp_tools,
                    custom_tools,
                    registry=worker_registry if USE_REGISTRY else None,
                )
                result = await supervisor.ainvoke(
                    {"messages": _to_langchain_messages(chat_history) + [HumanMessage(content=content)]}
                )
                for msg in result["messages"]:
                    if hasattr(msg, "content") and msg.content:
                        token_count += 1
                        msg_content = _content_length(msg.content)
                        assistant_chars += msg_content
                        event_index += 1
                        logger.debug(
                            "[LIFECYCLE] service=agent event=chat_stream_chunk requestId={} sessionId={} runId={} eventIndex={} tokenChars={}",
                            request_id,
                            session_id,
                            run_id,
                            event_index,
                            msg_content,
                        )
                        yield render_sse("token", correlated_data({"content": msg.content, "type": "token"}))
                terminal_sent = True
                yield render_sse("done", correlated_data({"type": "done"}))
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

                has_template = "contextTemplateSnapshot" in data
                if has_template:
                    run_context = ChatRunContext.from_request(
                        {
                            **data,
                            "runId": run_id,
                            "sessionId": session_id,
                            "workspaceId": workspace_id,
                            "requestId": request_id,
                            "provider": request_config.provider,
                            "model": model_override or request_config.model,
                            "toolMode": tool_mode,
                            "instructions": safe_agent_instructions,
                            "platformInstructions": AGENT_INSTRUCTIONS,
                        },
                        context,
                    )
                    built = build_context(run_context, all_tools, content, token_counter=_token_counter)
                    messages = list(built.messages)
                    for component_result in built.components:
                        raw_source = component_result.source
                        source_kind = raw_source.get("kind") if isinstance(raw_source, dict) else "unknown"
                        if source_kind not in {"context_projection", "runtime_workspace", "runtime"}:
                            source_kind = "unknown"
                        diagnostic_codes = [
                            code
                            for code in component_result.diagnostics
                            if code in _SAFE_CONTEXT_DIAGNOSTIC_CODES
                        ]
                        logger.info(
                            "Context component resolved type={} status={} sourceKind={} estimatedTokens={} truncated={} diagnosticCodes={}",
                            component_result.type,
                            component_result.status,
                            source_kind,
                            component_result.estimated_tokens,
                            component_result.truncated,
                            diagnostic_codes,
                        )
                    logger.info(
                        "Context template built templateId={} version={} components={} estimatedTokens={}",
                        run_context.template_snapshot.get("templateId"),
                        run_context.template_snapshot.get("version"),
                        len(built.components),
                        built.estimated_tokens,
                    )
                else:
                    messages = list(chat_history)
                    messages.append(TextMessage(role="human", content=content))

                config = RunnerConfig(
                    model=model_override or request_config.model,
                    system_prompt="" if has_template else instructions,
                    tools=all_tools,
                    context=context,
                    cancel_event=cancel_event,
                    prune_window_chars=_resolve_policy_for_model(
                        model_override or request_config.model,
                        user_overrides,
                        workspace_overrides,
                    ).prune_window_chars,
                    branch_id=context.branch_id,
                    template_context=has_template,
                    admitted_prompt=content,
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
                    elif event.type == "done":
                        if terminal_sent:
                            continue
                        terminal_sent = True
                        done_data = {**event.data, "type": "done", "outcome": terminal_outcome}
                        if terminal_error_code:
                            done_data["errorCode"] = terminal_error_code
                        yield render_sse("done", correlated_data(done_data))
                    elif event.type == "usage":
                        # PLAN-294 decision #14: when no provider usage chunk
                        # arrived (source=fallback), estimate the input size
                        # from the assembled request so the compression signal
                        # and audit trail still carry a usable value.
                        usage_data = dict(event.data.get("usage") or {})
                        if usage_data.get("source") in (None, "fallback"):
                            estimated = _estimate_input_tokens(messages)
                            usage_data.setdefault("estimatedInputTokens", estimated)
                            usage_data["source"] = "estimated" if estimated else "fallback"
                        else:
                            usage_data.setdefault("estimatedInputTokens", 0)
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
                    correlated_data({
                        "code": terminal_error_code,
                        "detail": "Context template snapshot is invalid",
                        "retryable": False,
                        "outcome": terminal_outcome,
                        "type": "error",
                    }),
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
            logger.exception(
                "[LIFECYCLE] service=agent event=chat_stream_failed requestId={} sessionId={} workspaceId={} runId={} errorCode={}",
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


__all__ = ["router", "_rag_config_defaults", "_SAFE_CONTEXT_DIAGNOSTIC_CODES", "problem_details"]
