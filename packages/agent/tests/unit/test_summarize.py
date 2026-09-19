"""PLAN-0354 spec §8: Agent summarize prompt, usage extraction and route contract."""

from typing import Any

import pytest
from fastapi.testclient import TestClient
from langchain_core.messages import AIMessage

from xihe_agent import main as main_module
from xihe_agent.llm.summarize import (
    SUMMARIZE_SECTIONS,
    SUMMARIZE_SYSTEM_PROMPT,
    build_summarize_messages,
    extract_usage,
    summarize_with_llm,
)

DEV_TOKEN = {"Authorization": "Bearer dev-token-not-secure"}


# ── prompt and usage ─────────────────────────────────────────────────────────


def test_system_prompt_carries_all_six_sections_without_constraints_data():
    for section in SUMMARIZE_SECTIONS:
        assert section in SUMMARIZE_SYSTEM_PROMPT
    assert "[Constraints]" not in SUMMARIZE_SECTIONS


def test_build_messages_includes_prior_summary_and_excerpt():
    messages = build_summarize_messages("human: hi", "[Goal] keep this")
    assert messages[0].content == SUMMARIZE_SYSTEM_PROMPT
    human = messages[1].content
    assert "[Goal] keep this" in human
    assert "human: hi" in human


def test_extract_usage_prefers_provider_metadata():
    result = AIMessage(
        content="[Goal] g",
        usage_metadata={"input_tokens": 120, "output_tokens": 30, "total_tokens": 150},
    )
    usage = extract_usage(result, "some prompt text")
    assert usage["inputTokens"] == 120
    assert usage["outputTokens"] == 30
    assert usage["totalTokens"] == 150
    assert usage["source"] == "real"


def test_extract_usage_falls_back_to_local_estimate():
    result = AIMessage(content="[Goal] g")
    usage = extract_usage(result, "some longer prompt text for estimation")
    assert usage["source"] == "estimated"
    assert usage["inputTokens"] > 0


class _FakeLLM:
    def __init__(self, message: AIMessage):
        self._message = message

    async def ainvoke(self, messages: Any) -> AIMessage:
        assert messages
        return self._message


@pytest.mark.asyncio
async def test_summarize_with_llm_returns_content_and_usage():
    llm = _FakeLLM(
        AIMessage(
            content="[Goal] g\n[Work State] Active: T1",
            usage_metadata={"input_tokens": 10, "output_tokens": 4, "total_tokens": 14},
        )
    )
    summary, usage = await summarize_with_llm(llm, "human: do the thing", None)
    assert summary.startswith("[Goal] g")
    assert usage["source"] == "real"
    assert usage["inputTokens"] == 10


# ── route contract ──────────────────────────────────────────────────────────


def _install_lease(monkeypatch, error: Exception | None = None) -> None:
    async def fake_redeem(_payload: dict[str, Any]) -> dict[str, Any]:
        if error is not None:
            raise error
        return {
            "provider": "deepseek",
            "routeProvider": "deepseek",
            "apiKey": "sk-test",
            "baseUrl": "http://localhost:1",
            "model": "m1",
            "connectionRevision": 1,
        }

    monkeypatch.setattr(main_module.config_client, "redeem_provider_lease", fake_redeem)


def test_summarize_endpoint_returns_summary_and_usage(monkeypatch):
    _install_lease(monkeypatch)
    monkeypatch.setattr(
        main_module,
        "create_llm",
        lambda _config: _FakeLLM(
            AIMessage(
                content="[Goal] ship it\n[Recent] r",
                usage_metadata={"input_tokens": 20, "output_tokens": 5, "total_tokens": 25},
            )
        ),
    )
    client = TestClient(main_module.app)

    resp = client.post(
        "/internal/v1/agent/summarize",
        json={
            "sessionId": "s-1",
            "runId": "",
            "provider": "deepseek",
            "model": "m1",
            "credentialLease": "pl_test",
            "providerConnectionId": "conn-1",
            "connectionRevision": 1,
            "text": "human: hello",
        },
        headers=DEV_TOKEN,
    )

    assert resp.status_code == 200
    body = resp.json()
    assert body["summary"].startswith("[Goal] ship it")
    assert body["usage"]["inputTokens"] == 20
    assert body["usage"]["model"] == "deepseek/m1"
    assert body["usage"]["source"] == "real"


def test_summarize_endpoint_requires_credential_lease():
    client = TestClient(main_module.app)

    resp = client.post(
        "/internal/v1/agent/summarize",
        json={"sessionId": "s-1", "text": "human: hello"},
        headers=DEV_TOKEN,
    )

    assert resp.status_code == 400
    assert resp.json()["code"] == "INVALID_REQUEST"


def test_summarize_endpoint_maps_lease_failure_to_503(monkeypatch):
    _install_lease(monkeypatch, error=RuntimeError("lease unavailable"))
    client = TestClient(main_module.app)

    resp = client.post(
        "/internal/v1/agent/summarize",
        json={"sessionId": "s-1", "text": "human: hello", "credentialLease": "pl_dead"},
        headers=DEV_TOKEN,
    )

    assert resp.status_code == 503
    assert resp.json()["code"] == "PROVIDER_CONNECTION_UNAVAILABLE"
