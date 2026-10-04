"""PLAN-0415 provider-neutral context builder tests."""

import pytest

from xihe_agent.context.builder import build_context
from xihe_agent.interfaces.chat_run_context import ChatRunContext, ContextBuildError
from xihe_agent.interfaces.context import AgentContext, ContextEpoch, parse_tool_result
from xihe_agent.interfaces.message import TextMessage, ToolCallRef

IID = "61e3d9d0-71c7-4b53-9e55-6ca4211ed67c"


def _run(document: str, components: list[dict], messages=None, epoch=None, sources=None) -> ChatRunContext:
    template_id = "b441b5da-f94a-4d3d-bb76-67a55da8c647"
    snapshot = {"layer": "workspace", "templateId": template_id, "version": 2, "template": {
        "id": template_id, "version": 2, "document": document, "components": components,
    }}
    return ChatRunContext.from_request(
        {"runId": "run", "sessionId": "session", "requestId": "request", "instructions": "safe instructions",
         "platformInstructions": "platform instructions",
         "contextTemplateSnapshot": snapshot, "componentSources": sources or {}},
        AgentContext("session", messages=messages or [], epoch=epoch),
    )


def _component(kind: str, config: dict, iid: str = IID) -> dict:
    return {"instanceId": iid, "type": kind, "enabled": True, "config": config}


class _LengthCounter:
    def estimate_messages(self, messages):
        return sum(len(message["content"]) for message in messages)


def test_parser_preserves_interleaved_document_and_component_order():
    run = _run("before{{component:" + IID + "}}after", [_component("text", {"text": "inside"})])
    built = build_context(run, [], "current")
    assert [m.content for m in built.messages] == ["before", "inside", "after", "current"]
    assert [m.role for m in built.messages] == ["system", "system", "system", "human"]


def test_platform_and_agent_prompts_follow_system_prompt_marker_order():
    components = [
        _component("system_prompt", {"source": "system", "includeAgentPrompt": True}),
        _component("system_prompt", {"source": "agent", "includeAgentPrompt": True}, "a85e6e63-7621-4722-904b-58b1e76923ec"),
    ]
    document = "first {{component:" + IID + "}} middle {{component:a85e6e63-7621-4722-904b-58b1e76923ec}} last"
    run = _run(document, components)
    built = build_context(run, [], "question")
    assert [message.content for message in built.messages] == [
        "first ", "platform instructions", "safe instructions", " middle ",
        "safe instructions", " last", "question",
    ]


def test_template_without_system_prompt_marker_has_no_hidden_instructions():
    run = _run("template text", [_component("text", {"text": "component"})])
    built = build_context(run, [], "question")
    assert [message.content for message in built.messages] == ["template text", "question"]
    assert all("platform instructions" not in message.content for message in built.messages)


def test_parser_normalizes_marker_and_instance_uuid_case():
    upper = IID.upper()
    run = _run("{{component:" + upper + "}}", [_component("text", {"text": "canonical"})])
    assert build_context(run, [], "").messages[0].content == "canonical"


def test_component_instance_id_must_be_canonical_and_unique():
    snapshot = _run("", []).template_snapshot
    snapshot["template"]["components"] = [_component("text", {"text": "a"}), _component("text", {"text": "b"})]
    with pytest.raises(ContextBuildError, match="duplicate"):
        ChatRunContext.from_request({"contextTemplateSnapshot": snapshot}, AgentContext("s"))
    snapshot["template"]["components"] = [_component("text", {"text": "a"}, IID.upper())]
    with pytest.raises(ContextBuildError, match="canonical"):
        ChatRunContext.from_request({"contextTemplateSnapshot": snapshot}, AgentContext("s"))


@pytest.mark.parametrize("marker", ["not-a-uuid", "0e3d9f22-81a4-4ae4-b19a-03882d49f001"])
def test_parser_rejects_invalid_or_unknown_marker(marker):
    run = _run("x{{component:" + marker + "}}y", [_component("text", {"text": "not dropped"})])
    with pytest.raises(ContextBuildError):
        build_context(run, [], "prompt")


def test_context_snapshot_identity_rejects_authority_fields():
    run = _run("", [])
    data = {"contextTemplateSnapshot": run.template_snapshot, "agentPrincipalId": "never"}
    with pytest.raises(ContextBuildError):
        ChatRunContext.from_request(data, AgentContext("s"))


def test_root_agents_status_and_utf8_truncation_are_explicit():
    run = _run("{{component:" + IID + "}}", [_component("root_agents_md", {
        "enabled": True, "refreshPolicy": "per_chat_run", "maxBytes": 4, "missingPolicy": "empty_with_status",
    })], epoch=ContextEpoch("e", "", [], l1_status="ok", l1_rendered="甲乙"))
    result = build_context(run, [], "").components[0]
    assert result.content == "甲"
    assert result.status == "truncated" and result.truncated


@pytest.mark.parametrize("policy", ["fail_run", "empty_with_status"])
def test_root_agents_missing_policy_is_enforced(policy):
    run = _run("{{component:" + IID + "}}", [_component("root_agents_md", {
        "enabled": True, "refreshPolicy": "per_chat_run", "maxBytes": 100, "missingPolicy": policy,
    })], epoch=ContextEpoch("e", "", [], l1_status="missing"))
    if policy == "fail_run":
        with pytest.raises(ContextBuildError, match="missingPolicy=fail_run"):
            build_context(run, [], "")
    else:
        result = build_context(run, [], "").components[0]
        assert result.status == "missing"
        assert result.diagnostics == ("root_agents_md_missing",)


@pytest.mark.parametrize("source_status", ["unavailable", "failed"])
def test_root_agents_unavailable_and_failed_are_fail_closed(source_status):
    run = _run("{{component:" + IID + "}}", [_component("root_agents_md", {
        "enabled": True, "refreshPolicy": "per_chat_run", "maxBytes": 100, "missingPolicy": "empty_with_status",
    })], epoch=ContextEpoch("e", "", [], l1_status=source_status, l1_rendered="stale rules"))
    with pytest.raises(ContextBuildError):
        build_context(run, [], "")


def test_history_and_tool_call_pairs_are_injected_but_not_replayed():
    history = [
        TextMessage("human", "old question"),
        TextMessage("ai", "", tool_calls=(ToolCallRef("call-1", "read_file", {"path": "a"}),)),
        TextMessage("tool", "bounded result", tool_call_id="call-1", tool_name="read_file", status="failed", truncated=True, artifact_ref="ref"),
    ]
    run = _run("{{component:" + IID + "}}", [_component("tool_history", {
        "selection": "all_within_budget", "maxTokens": 1000, "resultMode": "preview",
        "includeFailedCalls": True, "parameterPolicy": "approved_redaction",
    })], messages=history)
    built = build_context(run, [], "new prompt")
    assert [m.content for m in built.messages] == ["", "bounded result", "new prompt"]
    assert built.messages[0].tool_calls[0].call_id == "call-1"
    assert built.messages[1].status == "failed" and built.messages[1].truncated
    assert built.messages[1].content == "bounded result"  # preview mode
    assert built.messages[-1].content == "new prompt"


def test_missing_tree_source_fails_closed_instead_of_becoming_empty():
    run = _run("{{component:" + IID + "}}", [_component("workspace_tree", {
        "root": "session_workspace", "maxDepth": 2, "includeFiles": True, "maxEntries": 20,
    })])
    with pytest.raises(ContextBuildError, match="source status is unknown"):
        build_context(run, [], "")


def test_tree_string_paths_and_approval_required_fail_closed():
    source = {
        "status": "approval_required", "source": "runtime_workspace",
        "items": ["src/main.py", "../escape", "/absolute"], "truncated": False,
        "diagnostics": ["policy_approval_required"],
    }
    run = _run("{{component:" + IID + "}}", [_component("workspace_tree", {
        "root": "session_workspace", "maxDepth": 2, "includeFiles": True, "maxEntries": 10,
    })], sources={IID: source})
    with pytest.raises(ContextBuildError, match="approval_required"):
        build_context(run, [], "")


def test_tree_filters_unsafe_string_paths():
    source = {
        "status": "ready", "source": "runtime_workspace",
        "items": ["src/main.py", "../escape", "/absolute", "C:\\secret", "nul\x00path"],
        "truncated": False, "diagnostics": [],
    }
    run = _run("{{component:" + IID + "}}", [_component("workspace_tree", {
        "root": "session_workspace", "maxDepth": 2, "includeFiles": True, "maxEntries": 10,
    })], sources={IID: source})
    built = build_context(run, [], "")
    assert built.components[0].status == "ready"
    assert built.components[0].items == ("src/main.py",)
    assert built.messages[0].content == "Workspace paths: src/main.py"


def test_tree_rejects_non_session_workspace_root():
    run = _run("{{component:" + IID + "}}", [_component("agents_md_tree", {
        "root": "workspace", "maxDepth": 2, "fileNames": ["AGENTS.md"], "maxEntries": 10,
    })])
    with pytest.raises(ContextBuildError, match="session_workspace"):
        build_context(run, [], "")


@pytest.mark.parametrize("status", ["failed", "unavailable", "unknown"])
def test_tree_non_ready_resolver_states_fail_closed(status):
    source = {"status": status, "source": "runtime_workspace", "items": [], "truncated": False, "diagnostics": []}
    run = _run("{{component:" + IID + "}}", [_component("workspace_tree", {
        "root": "session_workspace", "maxDepth": 2, "includeFiles": True, "maxEntries": 10,
    })], sources={IID: source})
    with pytest.raises(ContextBuildError):
        build_context(run, [], "")


def test_ready_tree_without_entries_is_legally_empty():
    source = {"status": "ready", "source": "runtime_workspace", "items": [], "truncated": False, "diagnostics": []}
    run = _run("{{component:" + IID + "}}", [_component("workspace_tree", {
        "root": "session_workspace", "maxDepth": 2, "includeFiles": True, "maxEntries": 10,
    })], sources={IID: source})
    result = build_context(run, [], "").components[0]
    assert result.status == "empty" and result.items == ()


def test_component_source_shape_is_validated():
    run = _run("", [])
    with pytest.raises(ContextBuildError):
        ChatRunContext.from_request(
            {"contextTemplateSnapshot": run.template_snapshot, "componentSources": {IID: {"status": "ready"}}},
            AgentContext("s"),
        )


@pytest.mark.parametrize("patch", [
    {"layer": "global"},
    {"templateId": "not-a-uuid"},
    {"version": 3},
])
def test_template_reference_layer_id_and_version_are_strict(patch):
    snapshot = _run("", []).template_snapshot
    snapshot.update(patch)
    with pytest.raises(ContextBuildError):
        ChatRunContext.from_request({"contextTemplateSnapshot": snapshot}, AgentContext("s"))


def test_history_budget_keeps_newest_complete_turns_only():
    history = [
        TextMessage("human", "old"), TextMessage("ai", "answer"),
        TextMessage("human", "new"), TextMessage("ai", "reply"),
    ]
    run = _run("{{component:" + IID + "}}", [_component("conversation_history", {
        "selection": "all_within_budget", "maxTokens": 8, "includeCompaction": False,
    })], messages=history)
    built = build_context(run, [], "", token_counter=_LengthCounter())
    assert [message.content for message in built.messages] == ["new", "reply"]
    assert built.components[0].truncated
    assert built.components[0].estimated_tokens == 8


def test_tool_history_budget_keeps_complete_call_result_pair():
    history = [
        TextMessage("ai", "", tool_calls=(ToolCallRef("call-1", "tool", {}),)),
        TextMessage("tool", "one", tool_call_id="call-1"),
        TextMessage("ai", "", tool_calls=(ToolCallRef("call-2", "tool", {}),)),
        TextMessage("tool", "two", tool_call_id="call-2"),
    ]
    run = _run("{{component:" + IID + "}}", [_component("tool_history", {
        "selection": "all_within_budget", "maxTokens": 1000, "resultMode": "preview",
        "includeFailedCalls": True, "parameterPolicy": "approved_redaction",
    })], messages=history)
    built = build_context(run, [], "", token_counter=_LengthCounter())
    assert [message.tool_call_id for message in built.messages if message.role == "tool"] == ["call-1", "call-2"]


def test_tool_history_max_calls_counts_calls_and_pairs_multi_call_message():
    assistant = TextMessage("ai", "", tool_calls=(ToolCallRef("one", "tool", {}), ToolCallRef("two", "tool", {})))
    history = [assistant, TextMessage("tool", "1", tool_call_id="one"), TextMessage("tool", "2", tool_call_id="two")]
    run = _run("{{component:" + IID + "}}", [_component("tool_history", {
        "selection": "recent", "maxCalls": 1, "maxTokens": 1000, "resultMode": "preview",
        "includeFailedCalls": True, "parameterPolicy": "approved_redaction",
    })], messages=history)
    built = build_context(run, [], "")
    assert len(built.messages[0].tool_calls) == 1
    assert built.messages[0].tool_calls[0].call_id == "two"
    assert [message.tool_call_id for message in built.messages if message.role == "tool"] == ["two"]


def test_tool_history_requires_approved_redaction_policy():
    run = _run("{{component:" + IID + "}}", [_component("tool_history", {
        "selection": "recent", "maxTokens": 100, "resultMode": "preview",
        "includeFailedCalls": True, "parameterPolicy": "none",
    })])
    with pytest.raises(ContextBuildError):
        build_context(run, [], "")


def test_tool_history_available_artifact_replaces_preview_and_keeps_statuses_separate():
    history = [
        TextMessage("ai", "", tool_calls=(ToolCallRef("c", "tool", {}),)),
        TextMessage(
            "tool", "sensitive bounded preview", tool_call_id="c", status="failed",
            artifact_ref="opaque-ref", artifact_status="available", truncated=True, size_bytes=900,
        ),
    ]
    run = _run("{{component:" + IID + "}}", [_component("tool_history", {
        "selection": "recent", "maxTokens": 1000, "resultMode": "reference_when_available",
        "includeFailedCalls": True, "parameterPolicy": "approved_redaction",
    })], messages=history)
    built = build_context(run, [], "")
    assert built.components[0].items == ({
        "toolCallId": "c", "artifactRef": "opaque-ref", "artifactStatus": "available",
        "status": "failed", "truncated": True, "sizeBytes": 900,
    },)
    assert "opaque-ref" in built.messages[1].content
    assert "status=available" in built.messages[1].content
    assert "sizeBytes=900" in built.messages[1].content
    assert "sensitive bounded preview" not in built.messages[1].content
    assert built.components[0].diagnostics == ()


@pytest.mark.parametrize("artifact_status", ["expired", "unavailable", "unknown"])
def test_tool_history_non_available_artifact_falls_back_to_preview_with_diagnostic(artifact_status):
    history = [
        TextMessage("ai", "", tool_calls=(ToolCallRef("c", "tool", {}),)),
        TextMessage(
            "tool", "bounded preview", tool_call_id="c", status="completed",
            artifact_ref="opaque-ref", artifact_status=artifact_status,
        ),
    ]
    run = _run("{{component:" + IID + "}}", [_component("tool_history", {
        "selection": "recent", "maxTokens": 1000, "resultMode": "reference_when_available",
        "includeFailedCalls": True, "parameterPolicy": "approved_redaction",
    })], messages=history)
    built = build_context(run, [], "")
    assert built.messages[1].content == "bounded preview"
    assert "opaque-ref" not in built.messages[1].content
    assert built.components[0].diagnostics == (f"artifact_{artifact_status}_preview_fallback",)
    assert built.components[0].items[0]["status"] == "completed"
    assert built.components[0].items[0]["artifactStatus"] == artifact_status


def test_tool_history_missing_artifact_status_falls_back_without_claiming_readable():
    history = [
        TextMessage("ai", "", tool_calls=(ToolCallRef("c", "tool", {}),)),
        TextMessage("tool", "bounded preview", tool_call_id="c", artifact_ref="opaque-ref"),
    ]
    run = _run("{{component:" + IID + "}}", [_component("tool_history", {
        "selection": "recent", "maxTokens": 1000, "resultMode": "reference_when_available",
        "includeFailedCalls": True, "parameterPolicy": "approved_redaction",
    })], messages=history)
    result = build_context(run, [], "")
    assert result.messages[1].content == "bounded preview"
    assert result.components[0].diagnostics == ("artifact_unknown_preview_fallback",)


def test_tool_result_parser_keeps_artifact_status_separate():
    result = parse_tool_result({
        "preview": "bounded", "artifactRef": "opaque", "status": "expired", "truncated": True,
    })
    assert result.artifact_status == "expired"
    assert result.content == "bounded" and result.truncated


def test_tool_definitions_honor_token_budget_and_report_actual_estimate():
    class Tool:
        def __init__(self, name):
            self.spec = type("Spec", (), {"name": name, "description": "d", "input_schema": {}})()

    run = _run("{{component:" + IID + "}}", [_component("tool_definitions", {
        "selection": "all_authorized", "includeDescriptions": True, "includeSchemas": True,
        "maxTools": 5, "maxTokens": 70,
    })])
    built = build_context(run, [Tool("one"), Tool("two")], "", token_counter=_LengthCounter())
    assert len(built.components[0].items) == 1
    assert built.components[0].truncated
    assert built.components[0].estimated_tokens == _LengthCounter().estimate_messages(
        [{"role": "system", "content": built.messages[0].content}]
    )


def test_tool_definitions_budget_empty_is_truncated_not_empty():
    class Tool:
        spec = type("Spec", (), {"name": "tool", "description": "desc", "input_schema": {}})()

    run = _run("{{component:" + IID + "}}", [_component("tool_definitions", {
        "selection": "all_authorized", "includeDescriptions": True, "includeSchemas": True,
        "maxTools": 5, "maxTokens": 1,
    })])
    result = build_context(run, [Tool()], "", token_counter=_LengthCounter()).components[0]
    assert result.status == "truncated" and result.truncated
    assert "tool_definitions_budget_truncated" in result.diagnostics


@pytest.mark.parametrize("status", ["missing", "unavailable", "failed"])
def test_runtime_environment_preserves_non_ready_source_status(status):
    epoch = ContextEpoch("e", "", [], env_status=status, env_platform="must-not-leak")
    run = _run("{{component:" + IID + "}}", [_component("runtime_environment", {
        "fields": ["platform"], "maxTokens": 100, "sourceStatus": "fresh",
    })], epoch=epoch)
    if status in {"failed", "unavailable"}:
        with pytest.raises(ContextBuildError, match=status):
            build_context(run, [], "")
    else:
        built = build_context(run, [], "")
        assert built.components[0].status == status
        assert not built.messages


def test_runtime_environment_unknown_fails_closed():
    epoch = ContextEpoch("e", "", [], env_status="unknown", env_platform="must-not-leak")
    run = _run("{{component:" + IID + "}}", [_component("runtime_environment", {
        "fields": ["platform"], "maxTokens": 100, "sourceStatus": "fresh",
    })], epoch=epoch)
    with pytest.raises(ContextBuildError, match="status is unknown"):
        build_context(run, [], "")


def test_runtime_not_repository_is_ready_and_retains_source_status():
    epoch = ContextEpoch("e", "", [], env_status="not_repository", env_is_repository=False)
    run = _run("{{component:" + IID + "}}", [_component("runtime_environment", {
        "fields": ["git"], "maxTokens": 100, "sourceStatus": "fresh",
    })], epoch=epoch)
    result = build_context(run, [], "").components[0]
    assert result.status == "ready"
    assert result.source["status"] == "not_repository"


def test_system_prompt_uses_only_safe_instructions_text():
    run = _run("{{component:" + IID + "}}", [_component("system_prompt", {
        "source": "agent", "includeAgentPrompt": True,
    })])
    result = build_context(run, [], "").messages[0]
    assert result.content == "safe instructions"


def test_system_prompt_system_source_is_a_reference_not_a_duplicate():
    run = _run("{{component:" + IID + "}}", [_component("system_prompt", {
        "source": "system", "includeAgentPrompt": True,
    })])
    result = build_context(run, [], "").components[0]
    assert result.status == "ready"
    assert result.content == "platform instructions\nsafe instructions"


def test_system_source_without_agent_prompt_emits_only_platform_prompt():
    run = _run("{{component:" + IID + "}}", [_component("system_prompt", {
        "source": "system", "includeAgentPrompt": False,
    })])
    built = build_context(run, [], "")
    assert [message.content for message in built.messages] == ["platform instructions"]


def test_agent_source_without_agent_prompt_emits_nothing():
    run = _run("{{component:" + IID + "}}", [_component("system_prompt", {
        "source": "agent", "includeAgentPrompt": False,
    })])
    result = build_context(run, [], "").components[0]
    assert result.status == "empty" and result.content is None


def test_agent_system_prompt_without_safe_text_is_missing():
    run = _run("{{component:" + IID + "}}", [_component("system_prompt", {
        "source": "agent", "includeAgentPrompt": True,
    })])
    run = ChatRunContext.from_request({"contextTemplateSnapshot": run.template_snapshot}, AgentContext("s"))
    assert build_context(run, [], "").components[0].status == "missing"


def test_system_source_without_platform_text_is_missing_not_silent():
    run = _run("{{component:" + IID + "}}", [_component("system_prompt", {
        "source": "system", "includeAgentPrompt": False,
    })])
    run = ChatRunContext.from_request({"contextTemplateSnapshot": run.template_snapshot}, AgentContext("s"))
    result = build_context(run, [], "").components[0]
    assert result.status == "missing"
    assert result.diagnostics == ("platform_instructions_missing",)


@pytest.mark.parametrize(
    ("kind", "config", "epoch", "sources", "expected_status"),
    [
        ("text", {"text": "plain"}, None, {}, "ready"),
        ("system_prompt", {"source": "system", "includeAgentPrompt": False}, None, {}, "ready"),
        ("conversation_history", {"selection": "all_within_budget", "maxTokens": 50, "includeCompaction": True}, None, {}, "empty"),
        ("tool_definitions", {"selection": "all_authorized", "includeDescriptions": True, "includeSchemas": True, "maxTools": 3, "maxTokens": 200}, None, {}, "empty"),
        ("workspace_tree", {"root": "session_workspace", "maxDepth": 2, "includeFiles": True, "maxEntries": 10}, None, {IID: {"status": "ready", "source": "runtime_workspace", "items": ["src"], "truncated": False, "diagnostics": []}}, "ready"),
        ("runtime_environment", {"fields": ["platform", "git"], "maxTokens": 30, "sourceStatus": "fresh"}, ContextEpoch("e", "", [], env_status="ok", env_platform="linux"), {}, "ready"),
    ],
)
def test_first_batch_component_resolution(kind, config, epoch, sources, expected_status):
    run = _run("{{component:" + IID + "}}", [_component(kind, config)], epoch=epoch, sources=sources)
    result = build_context(run, [], "").components[0]
    assert result.type == kind
    assert result.status == expected_status
