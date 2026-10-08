"""Provider-neutral per-dispatch context types (PLAN-0415 M1)."""

from dataclasses import dataclass, field
from typing import Any
from uuid import UUID

from xihe_agent.interfaces.context import AgentContext
from xihe_agent.interfaces.message import Message


class ContextBuildError(ValueError):
    """Invalid template snapshot or unsupported context component."""


@dataclass(frozen=True)
class ComponentResult:
    instance_id: str
    type: str
    status: str
    source: Any = None
    content: str | None = None
    items: tuple[Any, ...] = ()
    estimated_tokens: int = 0
    truncated: bool = False
    diagnostics: tuple[str, ...] = ()


@dataclass(frozen=True)
class BuildContext:
    messages: tuple[Message, ...]
    components: tuple[ComponentResult, ...]
    estimated_tokens: int
    diagnostics: tuple[str, ...] = ()


@dataclass(frozen=True)
class ChatRunContext:
    run_id: str
    session_id: str
    user_id: str
    workspace_id: str | None
    request_id: str
    provider: str
    model: str
    tool_mode: str
    agent_instructions: str
    platform_instructions: str
    template_snapshot: dict[str, Any]
    agent_context: AgentContext
    component_sources: dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_request(cls, data: dict[str, Any], agent_context: AgentContext) -> "ChatRunContext":
        forbidden = {
            "agentprincipalid", "principalid", "agentpermissionid", "agentpermissions",
            "permissionsnapshot", "permissionsnapshotid", "grant", "grants", "grantids",
            "permission", "permissions", "permissionids", "perms", "permsnapshot",
            "capability", "capabilities", "capabilityids", "roleid", "roleids",
        }

        def has_forbidden(value: Any) -> bool:
            if isinstance(value, dict):
                keys = {str(key).replace("_", "").lower() for key in value}
                return bool(forbidden.intersection(keys)) or any(has_forbidden(item) for item in value.values())
            if isinstance(value, list):
                return any(has_forbidden(item) for item in value)
            return False

        if has_forbidden(data):
            raise ContextBuildError("authority-bearing principal fields are not accepted by Agent")
        snap = data.get("contextTemplateSnapshot")
        if not isinstance(snap, dict):
            raise ContextBuildError("contextTemplateSnapshot must be an object")
        template = snap.get("template")
        if not isinstance(template, dict):
            raise ContextBuildError("template must be an object")
        template_id, version = snap.get("templateId"), snap.get("version")
        layer = snap.get("layer")
        if layer not in {"instance", "user", "workspace"}:
            raise ContextBuildError("context template layer is invalid")
        if not isinstance(template_id, str) or not isinstance(version, int) or isinstance(version, bool):
            raise ContextBuildError("template reference requires templateId and integer version")
        try:
            template_id = str(UUID(template_id)).lower()
        except ValueError as exc:
            raise ContextBuildError("templateId must be a UUID") from exc
        inner_template_id = template.get("id")
        try:
            inner_template_id = str(UUID(inner_template_id)).lower()
        except (ValueError, TypeError) as exc:
            raise ContextBuildError("template.id must be a UUID") from exc
        inner_version = template.get("version")
        if (
            inner_template_id != template_id
            or not isinstance(inner_version, int)
            or isinstance(inner_version, bool)
            or inner_version != version
        ):
            raise ContextBuildError("template reference does not match snapshot")
        components = template.get("components")
        if not isinstance(components, list):
            raise ContextBuildError("template components must be a list")
        seen: set[str] = set()
        for component in components:
            if not isinstance(component, dict):
                raise ContextBuildError("component must be an object")
            instance_id = component.get("instanceId")
            if not isinstance(instance_id, str) or not instance_id:
                raise ContextBuildError("component instanceId is required")
            try:
                normalized_id = str(UUID(instance_id)).lower()
            except ValueError as exc:
                raise ContextBuildError("component instanceId must be a UUID") from exc
            if instance_id != normalized_id:
                raise ContextBuildError("component instanceId must be canonical lowercase UUID")
            if normalized_id in seen:
                raise ContextBuildError("duplicate component instanceId")
            seen.add(normalized_id)
            if not isinstance(component.get("type"), str) or not isinstance(component.get("config"), dict):
                raise ContextBuildError("component type/config is invalid")
        sources = data.get("componentSources", {})
        if not isinstance(sources, dict):
            raise ContextBuildError("componentSources must be an object")
        source_ids: set[str] = set()
        for instance_id, entry in sources.items():
            if not isinstance(instance_id, str) or not isinstance(entry, dict):
                raise ContextBuildError("componentSources entries must be objects keyed by instanceId")
            if not isinstance(entry.get("status"), str) or not isinstance(entry.get("source"), str):
                raise ContextBuildError("component source requires string status and source")
            try:
                source_id = str(UUID(instance_id)).lower()
            except ValueError as exc:
                raise ContextBuildError("componentSources key must be a component UUID") from exc
            if source_id not in seen:
                raise ContextBuildError("componentSources references an unknown component")
            if source_id in source_ids:
                raise ContextBuildError("duplicate componentSources instanceId")
            source_ids.add(source_id)
            if (
                not isinstance(entry.get("items"), list)
                or not all(isinstance(item, str) for item in entry["items"])
                or not isinstance(entry.get("truncated"), bool)
            ):
                raise ContextBuildError("component source items/truncated shape is invalid")
            if not isinstance(entry.get("diagnostics"), list) or not all(
                isinstance(item, str) for item in entry["diagnostics"]
            ):
                raise ContextBuildError("component source diagnostics must be a string list")
        instructions = data.get("instructions", "")
        if not isinstance(instructions, str):
            raise ContextBuildError("instructions must be text")
        platform_instructions = data.get("platformInstructions", "")
        if not isinstance(platform_instructions, str):
            raise ContextBuildError("platformInstructions must be local text")
        return cls(
            run_id=str(data.get("runId") or ""), session_id=str(data.get("sessionId") or ""),
            user_id=str(data.get("userId") or ""), workspace_id=data.get("workspaceId"),
            request_id=str(data.get("requestId") or ""),
            provider=str(data.get("provider") or ""), model=str(data.get("model") or ""),
            tool_mode=str(data.get("toolMode") or "none"), agent_instructions=instructions,
            platform_instructions=platform_instructions,
            template_snapshot=snap, agent_context=agent_context, component_sources=sources,
        )
