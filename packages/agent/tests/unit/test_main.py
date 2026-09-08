"""Tests for Agent readiness and request-boundary helpers."""

import pytest

from xihe_agent.llm.base import LLMConfig
from xihe_agent.main import _classify_llm_exception, _derive_llm_ready, _llm_readiness_error_code


def _report(status: str) -> dict:
    return {"domains": {"llm-provider": {"effective": status}}}


def test_derive_llm_ready_requires_verified_default_model():
    config = LLMConfig(
        provider="openai",
        api_key="test-key",
        api_base="https://provider.test/v1",
        model="gpt-test",
    )
    catalog = {
        "providers": {
            "openai": {
                "status": "ready",
                "verifiedAt": "2026-09-05T13:00:00Z",
                "models": [{"name": "gpt-test", "capabilities": {"chat": True}}],
            },
        },
    }

    readiness, verified_at = _derive_llm_ready(_report("ok"), catalog, config)

    assert readiness == "ready"
    assert verified_at == "2026-09-05T13:00:00Z"


def test_derive_llm_ready_does_not_fail_open_on_sync_failure():
    config = LLMConfig(provider="openai", api_key="test-key", model="gpt-test")
    catalog = {
        "providers": {
            "openai": {"status": "ready", "models": [{"name": "gpt-test"}]},
        },
    }

    readiness, _ = _derive_llm_ready(_report("unreachable"), catalog, config)

    assert readiness == "unknown"


def test_readiness_error_codes_are_actionable():
    assert _llm_readiness_error_code("missing_credentials") == "LLM_NOT_CONFIGURED"
    assert _llm_readiness_error_code("invalid_credentials") == "LLM_CREDENTIALS_INVALID"
    assert _llm_readiness_error_code("unknown") == "AGENT_UNAVAILABLE"


def test_classify_llm_exception_preserves_provider_failure_class():
    assert _classify_llm_exception(RuntimeError("Missing credentials"))[0] == "LLM_NOT_CONFIGURED"
    assert _classify_llm_exception(RuntimeError("Authentication failed"))[0] == "LLM_CREDENTIALS_INVALID"
    assert _classify_llm_exception(TimeoutError("request timed out"))[0] == "LLM_PROVIDER_UNREACHABLE"


@pytest.mark.asyncio
async def test_pure_chat_does_not_initialize_mcp(monkeypatch):
    from xihe_agent import main as agent_main

    async def unexpected_initialize(**_kwargs):
        raise AssertionError("MCP must not initialize for pure chat")

    monkeypatch.setattr(agent_main.mcp_manager, "initialize", unexpected_initialize)

    assert await agent_main._get_tools_for_mode("none", "workspace-a") == []


@pytest.mark.asyncio
async def test_mcp_workspace_context_conflict_fails_fast(monkeypatch):
    from xihe_agent import main as agent_main

    monkeypatch.setattr(agent_main.mcp_manager, "_initialized", True)
    monkeypatch.setattr(agent_main.mcp_manager, "workspace_id", "workspace-a")

    with pytest.raises(RuntimeError, match="cannot be reused"):
        await agent_main._get_tools_for_mode("workspace", "workspace-b")


@pytest.mark.asyncio
async def test_workspace_tool_mode_requires_workspace_id():
    from xihe_agent import main as agent_main

    with pytest.raises(RuntimeError, match="workspaceId is required"):
        await agent_main._get_tools_for_mode("workspace", None)


@pytest.mark.asyncio
async def test_workspace_mcp_initialization_failure_is_not_silenced(monkeypatch):
    from xihe_agent import main as agent_main

    async def failed_initialize(**_kwargs):
        raise OSError("runtime unavailable")

    monkeypatch.setattr(agent_main.mcp_manager, "initialize", failed_initialize)

    with pytest.raises(RuntimeError, match="MCP workspace initialization failed"):
        await agent_main._get_tools_for_mode("workspace", "workspace-a")


def test_health_reports_stable_process_instance_id():
    import uuid

    from xihe_agent import main as agent_main

    first = uuid.UUID(agent_main._instance_id)
    second = uuid.UUID(agent_main._instance_id)

    assert first == second
    assert agent_main._instance_id == str(first)
