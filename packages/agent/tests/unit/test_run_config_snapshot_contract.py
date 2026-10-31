"""PLAN-0590 route-level contract: run snapshot identity, fail-closed and toggles.

V6 (identity keys come from the CP payload only), V7 (no snapshot -> fail closed,
never fall back to the process workspace snapshot), and the D4 toggle migration
(`useSupervisor` resolved per run instead of an import-time global).
"""

import json
from typing import Any

import pytest
from fastapi.testclient import TestClient

import xihe_agent.api.chat as chat_api
import xihe_agent.api.misc as misc_api
import xihe_agent.app_state as app_state
from xihe_agent.config_snapshot import ConfigSnapshotUnavailableError, RunConfigSnapshot
from xihe_agent.main import app


class _RecordingResolver:
    """RunConfigResolver double: returns a fixed snapshot and records identities."""

    def __init__(self, snapshot: RunConfigSnapshot | Exception):
        self._snapshot = snapshot
        self.calls: list[tuple[str | None, str | None]] = []

    async def resolve(self, workspace_id: str | None, user_id: str | None) -> RunConfigSnapshot:
        self.calls.append((workspace_id, user_id))
        if isinstance(self._snapshot, Exception):
            raise self._snapshot
        return self._snapshot


def _snapshot(**entries: dict[str, str]) -> RunConfigSnapshot:
    domains = {
        "llm-provider": {},
        "agent-profile": {},
        "rag": {},
        "agent-runtime": {},
        "context-policy": {},
    }
    domains.update(entries)
    return RunConfigSnapshot(
        workspace_id=None,
        user_id=None,
        fetched_at=0.0,
        entries=domains,
        revisions={},
    )


def _post_chat(payload: dict[str, Any]) -> Any:
    body = {
        "content": "snapshot contract probe",
        "sessionId": "s-snapshot-contract",
        "toolMode": "none",
        "instructions": "snapshot contract baseline",
    }
    body.update(payload)
    client = TestClient(app)
    return client.post(
        "/internal/v1/agent/chat",
        json=body,
        headers={"Authorization": "Bearer dev-token-not-secure", "X-Chat-Run-Id": "run-snapshot-contract"},
    )


def test_chat_fails_closed_when_snapshot_unavailable(monkeypatch: pytest.MonkeyPatch) -> None:
    # A populated process cache must NOT be used as a fallback (I3/I5).
    monkeypatch.setattr(
        app_state.config_client,
        "_effective_cache",
        {"context-policy": {"defaults": '{"maxInputTokens": 98765}'}},
    )
    resolver = _RecordingResolver(ConfigSnapshotUnavailableError("ws-a", "u-1", "effective pull failed"))
    monkeypatch.setattr(chat_api, "run_config_resolver", resolver)

    response = _post_chat({"workspaceId": "ws-a", "userId": "u-1"})

    assert response.status_code == 503
    problem = response.json()
    assert problem["code"] == "AGENT_CONFIG_SNAPSHOT_UNAVAILABLE"
    assert resolver.calls == [("ws-a", "u-1")]


def test_chat_resolves_snapshot_from_payload_identity(monkeypatch: pytest.MonkeyPatch) -> None:
    resolver = _RecordingResolver(_snapshot())
    monkeypatch.setattr(chat_api, "run_config_resolver", resolver)
    monkeypatch.setattr(chat_api, "validate_snapshot", lambda data: (_raise("no dispatch"), None))

    # The snapshot resolves before template/lease work, so the request stops at
    # the validation failure but the identity call is already recorded.
    response = _post_chat({"workspaceId": "ws-b", "userId": "u-2"})

    assert response.status_code >= 400
    assert resolver.calls == [("ws-b", "u-2")]


def test_chat_without_workspace_resolves_without_workspace_layer(monkeypatch: pytest.MonkeyPatch) -> None:
    resolver = _RecordingResolver(_snapshot())
    monkeypatch.setattr(chat_api, "run_config_resolver", resolver)
    monkeypatch.setattr(chat_api, "validate_snapshot", lambda data: (_raise("no dispatch"), None))

    _post_chat({"userId": "u-3"})

    assert resolver.calls == [(None, "u-3")]


def test_payload_workspace_wins_over_process_env(monkeypatch: pytest.MonkeyPatch) -> None:
    # I2: the process env binding must never leak into a run's identity.
    monkeypatch.setenv("XIHE_WORKSPACE_ID", "process-bound-ws")
    resolver = _RecordingResolver(_snapshot())
    monkeypatch.setattr(chat_api, "run_config_resolver", resolver)
    monkeypatch.setattr(chat_api, "validate_snapshot", lambda data: (_raise("no dispatch"), None))

    _post_chat({"workspaceId": "payload-ws", "userId": "u-5"})

    assert resolver.calls == [("payload-ws", "u-5")]


def test_supervisor_gate_uses_run_snapshot_not_process_global(monkeypatch: pytest.MonkeyPatch) -> None:
    resolver = _RecordingResolver(_snapshot(**{"agent-runtime": {"useSupervisor": "true"}}))
    monkeypatch.setattr(chat_api, "run_config_resolver", resolver)

    async def _tools(tool_mode: str, workspace_id: str | None) -> list[Any]:
        return []

    monkeypatch.setattr(chat_api, "_get_tools_for_mode", _tools)
    monkeypatch.setattr(
        chat_api,
        "validate_snapshot",
        lambda data: (
            type("ApiType", (), {"id": "stub", "version": 1})(),
            {"template": {"bodySource": '{"model":"${xh.model}"}'}},
        ),
    )
    monkeypatch.setattr(chat_api, "render_request", lambda *a, **k: {})

    async def _redeem(payload: dict[str, Any], request_id: str | None = None) -> dict[str, Any]:
        return {
            "apiTypeId": "stub",
            "apiTypeVersion": 1,
            "operation": "chat",
            "connectionRevision": payload.get("connectionRevision"),
            "provider": payload.get("providerId"),
            "model": payload.get("model"),
        }

    monkeypatch.setattr(app_state.config_client, "redeem_provider_lease", _redeem)

    response = _post_chat({"workspaceId": "ws-c", "userId": "u-4", "toolMode": "workspace"})

    assert response.status_code == 200
    assert '"code": "APPROVAL_EXECUTOR_UNSUPPORTED"' in response.text or "APPROVAL_EXECUTOR_UNSUPPORTED" in response.text


def _raise(message: str):
    raise RuntimeError(message)


@pytest.mark.asyncio
async def test_summarize_uses_request_snapshot_identity(monkeypatch: pytest.MonkeyPatch) -> None:
    model_params = json.dumps({"mock": {"timeout": 12, "maxTokens": 1024}})
    resolver = _RecordingResolver(_snapshot(**{"llm-provider": {"modelParams": model_params}}))
    monkeypatch.setattr(misc_api, "run_config_resolver", resolver)
    captured: dict[str, Any] = {}

    async def _redeem(payload: dict[str, Any], request_id: str | None = None) -> dict[str, Any]:
        return {"provider": "openai", "model": "mock", "apiKey": "k", "baseUrl": "http://fake", "operation": "chat"}

    monkeypatch.setattr(app_state.config_client, "redeem_provider_lease", _redeem)

    def _create_llm(config: Any) -> Any:
        captured["config"] = config
        return object()

    monkeypatch.setattr(app_state, "create_llm", _create_llm)

    async def _summarize(summarizer: Any, text: str, prior: str | None) -> tuple[str, dict[str, Any]]:
        return "[Goal] summarized", {"source": "real"}

    monkeypatch.setattr(misc_api, "summarize_with_llm", _summarize)

    response = TestClient(app).post(
        "/internal/v1/agent/summarize",
        json={
            "sessionId": "s-sum",
            "runId": "r-sum",
            "provider": "openai",
            "model": "mock",
            "credentialLease": "lease",
            "providerConnectionId": "c-1",
            "connectionRevision": 1,
            "text": "long text",
            "workspaceId": "ws-sum",
            "userId": "u-sum",
        },
        headers={"Authorization": "Bearer dev-token-not-secure"},
    )

    assert response.status_code == 200
    assert resolver.calls == [("ws-sum", "u-sum")]
    assert captured["config"].timeout == 12.0
    assert captured["config"].max_tokens == 1024


@pytest.mark.asyncio
async def test_summarize_without_identity_uses_code_defaults(monkeypatch: pytest.MonkeyPatch) -> None:
    resolver = _RecordingResolver(_snapshot(**{"llm-provider": {"timeout": "12"}}))
    monkeypatch.setattr(misc_api, "run_config_resolver", resolver)
    captured: dict[str, Any] = {}

    async def _redeem(payload: dict[str, Any], request_id: str | None = None) -> dict[str, Any]:
        return {"provider": "openai", "model": "mock", "apiKey": "k", "baseUrl": "http://fake", "operation": "chat"}

    monkeypatch.setattr(app_state.config_client, "redeem_provider_lease", _redeem)

    def _create_llm(config: Any) -> Any:
        captured["config"] = config
        return object()

    monkeypatch.setattr(app_state, "create_llm", _create_llm)

    async def _summarize(summarizer: Any, text: str, prior: str | None) -> tuple[str, dict[str, Any]]:
        return "[Goal] summarized", {"source": "real"}

    monkeypatch.setattr(misc_api, "summarize_with_llm", _summarize)

    response = TestClient(app).post(
        "/internal/v1/agent/summarize",
        json={
            "sessionId": "s-sum",
            "runId": "r-sum",
            "provider": "openai",
            "model": "mock",
            "credentialLease": "lease",
            "providerConnectionId": "c-1",
            "connectionRevision": 1,
            "text": "long text",
        },
        headers={"Authorization": "Bearer dev-token-not-secure"},
    )

    assert response.status_code == 200
    assert resolver.calls == []
    # LLMConfig defaults (60s / 4096) then clamped by the summarize 2048 cap.
    assert captured["config"].timeout == 60.0
    assert captured["config"].max_tokens == 2048
