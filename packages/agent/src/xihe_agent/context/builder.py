"""Build ordered provider-neutral messages from a frozen template snapshot."""

import json
import re
import uuid
from dataclasses import replace
from pathlib import PurePosixPath
from typing import Any

from xihe_agent.interfaces.chat_run_context import (
    BuildContext,
    ChatRunContext,
    ComponentResult,
    ContextBuildError,
)
from xihe_agent.interfaces.message import TextMessage

_MARKER = re.compile(r"\{\{component:([^{}]+)\}\}")
_STATUSES = {"ready", "empty", "missing", "unavailable", "unknown", "truncated", "failed"}


def _config(component: dict[str, Any], required: tuple[str, ...], enums: dict[str, set[str]] | None = None) -> dict[str, Any]:
    config = component["config"]
    if any(key not in config for key in required):
        raise ContextBuildError(f"{component['type']} config is missing required fields")
    for key, allowed in (enums or {}).items():
        if config.get(key) not in allowed:
            raise ContextBuildError(f"{component['type']}.{key} is invalid")
    return config


def _safe_utf8(text: str, limit: int) -> tuple[str, bool]:
    raw = text.encode("utf-8")
    if len(raw) <= limit:
        return text, False
    return raw[:limit].decode("utf-8", errors="ignore"), True


def _tokens(messages: list[TextMessage], counter: Any) -> int:
    payload = []
    for message in messages:
        body = message.content
        if message.role == "ai" and message.tool_calls:
            body += json.dumps(
                [{"id": call.call_id, "name": call.tool_name, "arguments": call.arguments} for call in message.tool_calls],
                ensure_ascii=False,
            )
        payload.append({"role": message.role, "content": body})
    return counter.estimate_messages(payload) if counter is not None else sum(len(item["content"]) // 4 for item in payload)


def _take_newest(groups: list[list[TextMessage]], budget: int, counter: Any) -> tuple[list[TextMessage], bool]:
    chosen: list[list[TextMessage]] = []
    for group in reversed(groups):
        candidate = [*group, *(message for selected in chosen for message in selected)]
        if _tokens(candidate, counter) > max(0, budget):
            break
        chosen.insert(0, group)
    return [message for group in chosen for message in group], len(chosen) != len(groups)


def _render(component: dict[str, Any], run: ChatRunContext, tools: list[Any], token_counter: Any) -> tuple[ComponentResult, list[TextMessage]]:
    kind, iid = component["type"], component["instanceId"]
    if component.get("enabled", True) is False:
        return ComponentResult(iid, kind, "empty"), []
    cfg = component["config"]
    messages: list[TextMessage] = []
    content: str | None = None
    items: tuple[Any, ...] = ()
    source: Any = {"kind": "context_projection"}
    diagnostics: tuple[str, ...] = ()
    status = "ready"
    cut = False
    if kind == "text":
        cfg = _config(component, ("text",))
        content = cfg["text"]
        if not isinstance(content, str):
            raise ContextBuildError("text.text must be a string")
        if content:
            messages.append(TextMessage("system", content))
        else:
            status = "empty"
    elif kind == "system_prompt":
        _config(component, ("source", "includeAgentPrompt"), {"source": {"system", "agent"}})
        if cfg["source"] == "system":
            content = run.platform_instructions
            if content:
                messages.append(TextMessage("system", content))
            else:
                status = "missing"
                diagnostics = ("platform_instructions_missing",)
            if cfg["includeAgentPrompt"]:
                if run.agent_instructions:
                    messages.append(TextMessage("system", run.agent_instructions))
                else:
                    status = "missing"
                    diagnostics = (*diagnostics, "agent_instructions_missing")
        elif cfg["includeAgentPrompt"]:
            content = run.agent_instructions
            if content:
                messages.append(TextMessage("system", content))
            else:
                status = "missing"
                diagnostics = ("agent_instructions_missing",)
        else:
            status = "empty"
        content = "\n".join(message.content for message in messages) or None
    elif kind == "root_agents_md":
        cfg = _config(
            component,
            ("enabled", "refreshPolicy", "maxBytes", "missingPolicy"),
            {"refreshPolicy": {"per_chat_run", "per_session"}, "missingPolicy": {"fail_run", "empty_with_status"}},
        )
        epoch = run.agent_context.epoch
        source_status = getattr(epoch, "l1_status", "") if epoch else ""
        source = {"kind": "context_projection", "status": source_status or "unknown"}
        if source_status == "ok":
            content, cut = _safe_utf8(getattr(epoch, "l1_rendered", "") or "", max(0, cfg["maxBytes"]))
            status = "empty" if not content else ("truncated" if cut else "ready")
            if content:
                messages.append(TextMessage("system", content))
        elif source_status == "missing":
            if cfg["missingPolicy"] == "fail_run":
                raise ContextBuildError("root AGENTS.md is missing and missingPolicy=fail_run")
            status = "missing"
            diagnostics = ("root_agents_md_missing",)
        elif source_status in {"unavailable", "failed"}:
            raise ContextBuildError(f"root AGENTS.md source is {source_status}")
        elif source_status in {"", "unknown"}:
            raise ContextBuildError("root AGENTS.md source status is unknown")
        else:
            raise ContextBuildError("root AGENTS.md source status is invalid")
    elif kind == "conversation_history":
        cfg = _config(component, ("selection", "maxTokens", "includeCompaction"), {"selection": {"recent", "all_within_budget"}})
        groups: list[list[TextMessage]] = []
        pending: list[TextMessage] = []
        for message in run.agent_context.messages:
            if message.role == "human":
                if pending:
                    groups.append(pending)
                pending = [message]
            elif message.role == "ai" and not message.tool_calls:
                if pending:
                    pending.append(message)
        if pending:
            groups.append(pending)
        if cfg["includeCompaction"] and run.agent_context.epoch:
            summaries = [TextMessage("system", text) for text in run.agent_context.epoch.system_messages if text]
            if summaries:
                groups.insert(0, summaries)
        if cfg["selection"] == "recent" and isinstance(cfg.get("maxTurns"), int):
            groups = groups[-max(0, cfg["maxTurns"]) :]
        history, cut = _take_newest(groups, cfg["maxTokens"], token_counter)
        items = tuple(history)
        messages.extend(history)
        status = "truncated" if cut else "ready" if history else "empty"
    elif kind == "tool_history":
        cfg = _config(
            component,
            ("selection", "maxTokens", "resultMode", "includeFailedCalls", "parameterPolicy"),
            {"selection": {"recent", "all_within_budget"}, "resultMode": {"preview", "reference_when_available"}, "parameterPolicy": {"approved_redaction"}},
        )
        groups = []
        artifact_diagnostics: list[str] = []
        history = run.agent_context.messages
        index = 0
        while index < len(history):
            assistant = history[index]
            if assistant.role != "ai" or not assistant.tool_calls:
                index += 1
                continue
            results = []
            cursor = index + 1
            while cursor < len(history) and history[cursor].role == "tool":
                results.append(history[cursor])
                cursor += 1
            by_call = {message.tool_call_id: message for message in results if message.tool_call_id}
            for call in assistant.tool_calls:
                result = by_call.get(call.call_id)
                if result is None or (not cfg["includeFailedCalls"] and result.status in {"failed", "interrupted", "expired"}):
                    continue
                provider_result = result
                if cfg["resultMode"] == "reference_when_available":
                    artifact_status = result.artifact_status if result.artifact_status in {"available", "expired", "unavailable"} else "unknown"
                    if result.artifact_ref and artifact_status == "available":
                        size = f", sizeBytes={result.size_bytes}" if result.size_bytes is not None else ""
                        note = f"Tool output is available by artifact reference: {result.artifact_ref} (status=available{size})."
                        provider_result = replace(result, content=note)
                    else:
                        code = f"artifact_{artifact_status}_preview_fallback" if result.artifact_ref else "artifact_reference_missing_preview_fallback"
                        artifact_diagnostics.append(code)
                groups.append([replace(assistant, tool_calls=(call,)), provider_result])
            index = cursor
        if isinstance(cfg.get("maxCalls"), int):
            groups = groups[-max(0, cfg["maxCalls"]):] if cfg["maxCalls"] > 0 else []
        history, cut = _take_newest(groups, cfg["maxTokens"], token_counter)
        refs = []
        if cfg["resultMode"] == "reference_when_available":
            for message in history:
                if message.role == "tool":
                    artifact_status = message.artifact_status if message.artifact_status in {"available", "expired", "unavailable"} else "unknown"
                    refs.append({
                        "toolCallId": message.tool_call_id,
                        "artifactRef": message.artifact_ref or None,
                        "artifactStatus": artifact_status,
                        "status": message.status,
                        "truncated": message.truncated,
                        "sizeBytes": message.size_bytes,
                    })
        items = tuple(refs) if refs else tuple(history)
        if artifact_diagnostics:
            diagnostics = tuple(artifact_diagnostics)
        messages.extend(history)
        status = "truncated" if cut else "ready" if history else "empty"
    elif kind == "tool_definitions":
        cfg = _config(component, ("selection", "includeDescriptions", "includeSchemas", "maxTools", "maxTokens"), {"selection": {"all_authorized"}})
        authorized = [{"name": t.spec.name, "description": t.spec.description if cfg["includeDescriptions"] else "", "schema": t.spec.input_schema if cfg["includeSchemas"] else {}} for t in tools]
        had_tools = bool(authorized)
        if isinstance(cfg["maxTools"], int) and len(authorized) > cfg["maxTools"]:
            authorized = authorized[: max(0, cfg["maxTools"])]
            status = "truncated"
            cut = True
            diagnostics = ("tool_definitions_max_tools_reached",)
        budget = max(0, cfg["maxTokens"])
        while authorized:
            content = "Authorized tools: " + json.dumps(authorized, ensure_ascii=False)
            if _tokens([TextMessage("system", content)], token_counter) <= budget:
                break
            authorized.pop()
            status = "truncated"
            cut = True
            diagnostics = (*diagnostics, "tool_definitions_budget_truncated")
        items = tuple(authorized)
        content = "Authorized tools: " + json.dumps(authorized, ensure_ascii=False) if authorized else ""
        if content:
            messages.append(TextMessage("system", content))
        if not authorized:
            status = "truncated" if had_tools else "empty"
    elif kind in {"workspace_tree", "agents_md_tree"}:
        required = ("root", "maxDepth", "maxEntries") if kind == "workspace_tree" else ("root", "maxDepth", "fileNames", "maxEntries")
        cfg = _config(component, required)
        if cfg["root"] != "session_workspace":
            raise ContextBuildError(f"{kind}.root must be session_workspace")
        entry = next(
            (value for key, value in run.component_sources.items() if key.lower() == str(uuid.UUID(iid)).lower()),
            None,
        )
        if not isinstance(entry, dict):
            raise ContextBuildError(f"{kind} source status is unknown")
        else:
            owner_status = entry.get("status")
            if owner_status in {"failed", "unavailable", "approval_required"}:
                raise ContextBuildError(f"{kind} source is {owner_status}")
            if owner_status == "unknown" or owner_status not in _STATUSES:
                raise ContextBuildError(f"{kind} source status is unknown")
            status = owner_status
            source = {"kind": entry.get("source"), "status": owner_status, "diagnostics": entry.get("diagnostics", [])}
            diagnostics = tuple(entry.get("diagnostics", []))
            if owner_status == "missing" and not diagnostics:
                diagnostics = (f"{kind}_missing",)
            raw_items = entry.get("items", [])
            if isinstance(raw_items, list):
                items = tuple(raw_items[: max(0, cfg["maxEntries"])])
                cut = owner_status == "truncated" or bool(entry.get("truncated")) or len(raw_items) > max(0, cfg["maxEntries"])
                if cut:
                    status = "truncated"
            paths = [item if isinstance(item, str) else item.get("path", "") for item in items]
            safe_paths = [
                path
                for path in paths
                if isinstance(path, str)
                and path
                and not PurePosixPath(path.replace("\\", "/")).is_absolute()
                and not re.match(r"^[A-Za-z]:", path)
                and ".." not in path.replace("\\", "/").split("/")
                and "\x00" not in path
            ]
            items = tuple(safe_paths)
            content = "Workspace paths: " + ", ".join(safe_paths)
            if (owner_status == "ready" and not safe_paths) or owner_status == "empty":
                status = "empty"
            if items:
                messages.append(TextMessage("system", content))
    elif kind == "runtime_environment":
        cfg = _config(component, ("fields", "maxTokens", "sourceStatus"))
        epoch = run.agent_context.epoch
        owner_status = getattr(epoch, "env_status", "") if epoch else ""
        status = "ready" if owner_status in {"ok", "not_repository"} else owner_status or "unknown"
        if status in {"failed", "unavailable"}:
            raise ContextBuildError(f"runtime environment source is {status}")
        if status == "unknown":
            raise ContextBuildError("runtime environment source status is unknown")
        if status not in {"ready", "missing", "empty"}:
            status = "unknown"
            raise ContextBuildError("runtime environment source status is unknown")
        if status == "missing":
            diagnostics = ("runtime_environment_missing",)
        facts: dict[str, Any] = {}
        if epoch and owner_status in {"ok", "not_repository"}:
            allowed = set(cfg["fields"] if isinstance(cfg["fields"], list) else [])
            values = {"cwd": epoch.env_cwd, "platform": epoch.env_platform, "shell": epoch.env_shell, "git": {"isRepository": epoch.env_is_repository, "branch": epoch.env_branch, "head": epoch.env_head}}
            facts = {key: values[key] for key in allowed if key in values}
        source = {"kind": "context_projection", "status": owner_status or "unknown"}
        items = (facts,) if facts else ()
        content = "Runtime environment: " + str(facts) if facts else None
        if content:
            message = TextMessage("system", content)
            budget = max(0, cfg["maxTokens"])
            if _tokens([message], token_counter) > budget:
                # Prefer the useful factual fields in declared order and stay within budget.
                allowed_fields = cfg["fields"] if isinstance(cfg["fields"], list) else []
                selected: dict[str, Any] = {}
                for key in allowed_fields:
                    if key in facts:
                        candidate = {**selected, key: facts[key]}
                        candidate_message = TextMessage("system", "Runtime environment: " + str(candidate))
                        if _tokens([candidate_message], token_counter) <= budget:
                            selected = candidate
                facts = selected
                content = "Runtime environment: " + str(facts) if facts else None
                items = (facts,) if facts else ()
                status = "truncated" if facts else "empty"
                cut = True
            if content:
                messages.append(TextMessage("system", content))
    else:
        raise ContextBuildError(f"unknown component type: {kind}")
    if status not in _STATUSES:
        status = "unknown"
    tokens = _tokens(messages, token_counter)
    return ComponentResult(iid, kind, status, source, content, items, tokens, cut or status == "truncated", diagnostics), messages


def build_context(run: ChatRunContext, tools: list[Any], current_prompt: str, token_counter: Any = None) -> BuildContext:
    template = run.template_snapshot["template"]
    document = template.get("document")
    components = {str(uuid.UUID(item["instanceId"])).lower(): item for item in template["components"]}
    if not isinstance(document, str):
        raise ContextBuildError("template document must be text")
    nodes: list[tuple[str, str]] = []
    last = 0
    for match in _MARKER.finditer(document):
        marker = match.group(1)
        try:
            canonical = str(uuid.UUID(marker)).lower()
        except (ValueError, AttributeError) as exc:
            raise ContextBuildError(f"invalid component marker UUID: {marker}") from exc
        if canonical != marker.lower() or marker.lower() not in components:
            raise ContextBuildError(f"unknown component marker: {marker}")
        if match.start() > last:
            text = document[last : match.start()]
            if "{{" in text or "}}" in text:
                raise ContextBuildError("malformed or unsupported template marker")
            nodes.append(("text", text))
        nodes.append(("component", marker.lower()))
        last = match.end()
    if "{{" in document[last:] or "}}" in document[last:]:
        raise ContextBuildError("malformed or unsupported template marker")
    if last < len(document):
        nodes.append(("text", document[last:]))
    messages: list[TextMessage] = []
    results: list[ComponentResult] = []
    for node_type, value in nodes:
        if node_type == "text":
            if value:
                messages.append(TextMessage("system", value))
            continue
        result, resolved = _render(components[value], run, tools, token_counter)
        results.append(result)
        messages.extend(resolved)
    if current_prompt:
        messages.append(TextMessage("human", current_prompt))
    # Count the final message sequence once; component estimates describe the
    # same payload and are diagnostic metadata, not an additional budget.
    estimate = _tokens(messages, token_counter)
    return BuildContext(tuple(messages), tuple(results), estimate)
