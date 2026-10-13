"""Data-only retrieval placement and Run-bound fail-closed dispatch contracts."""

from __future__ import annotations

import json
from unittest.mock import AsyncMock

import httpx
import pytest
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from test_api_request_runtime import TYPES, VALUES, body, grant, recorder, snapshot_request

from xihe_agent import app_state
from xihe_agent.adapters.api_chat_model import ApiChatModel
from xihe_agent.api import chat as route
from xihe_agent.config_client import ProviderLeaseError
from xihe_agent.llm.api_request import ApiRequestError, chat_type, render_request, uses_rag_context
from xihe_agent.rag import chat_context
from xihe_agent.rag.dashscope import SUPPORTED_MODEL


def profile():
    return {
        "workspaceId": "workspace-fixture",
        "connectionOwnerType": "user",
        "connectionOwnerId": "user-fixture",
        "providerConnectionId": "embedding-connection",
        "providerId": "dashscope",
        "connectionRevision": 4,
        "apiTypeId": "dashscope-multimodal-embedding",
        "apiTypeVersion": 1,
        "modelId": SUPPORTED_MODEL,
        "dimension": 768,
    }


def embedding_grant():
    return {
        "operation": "embedding",
        "apiTypeId": "dashscope-multimodal-embedding",
        "apiTypeVersion": 1,
        "model": SUPPORTED_MODEL,
        "provider": "dashscope",
        "connectionRevision": 4,
        "apiKey": "fixture-only",
        "baseUrl": "https://fixture.invalid/api/v1",
    }


def rag_body(type_id):
    result = body(type_id)
    key = "input" if type_id == TYPES[2] else "messages"
    content = "RAG: ${xh.rag_context}"
    if type_id == TYPES[1]:
        content = [{"type": "text", "text": content}]
    result[key].append({"role": "user", "content": content})
    return result


@pytest.mark.parametrize("type_id", TYPES)
def test_strict_trigger_escape_and_data_only_render(type_id):
    source = json.dumps(rag_body(type_id))
    assert uses_rag_context(source)
    escaped = source.replace("${xh.rag_context}", "$${xh.rag_context}")
    assert not uses_rag_context(escaped)
    rendered = render_request(source, chat_type(type_id, 1), {**VALUES, "rag_context": "${xh.agent_instructions}"})
    assert "${xh.agent_instructions}" in json.dumps(rendered)
    assert not uses_rag_context(json.dumps(body(type_id)))


@pytest.mark.parametrize("type_id", TYPES)
@pytest.mark.parametrize("location", ["system", "instructions", "model", "tools", "key", "role"])
def test_rag_forbidden_paths(type_id, location):
    fixture = body(type_id)
    if location == "key":
        fixture["${xh.rag_context}"] = "value"
    elif location == "tools":
        fixture["tools"] = [{"name": "${xh.rag_context}"}]
    elif location == "role":
        fixture["input" if type_id == TYPES[2] else "messages"][-1]["role"] = "${xh.rag_context}"
    else:
        fixture[location] = "${xh.rag_context}"
    with pytest.raises(ApiRequestError):
        render_request(json.dumps(fixture), chat_type(type_id, 1), {**VALUES, "rag_context": "untrusted"})


@pytest.mark.parametrize("role", ["system", "developer"])
@pytest.mark.parametrize("type_id", [TYPES[0], TYPES[2]])
def test_rag_cannot_enter_authority_role(role, type_id):
    fixture = body(type_id)
    fixture["input" if type_id == TYPES[2] else "messages"].append({"role": role, "content": "${xh.rag_context}"})
    with pytest.raises(ApiRequestError, match="WRONG_VARIABLE_LOCATION"):
        render_request(json.dumps(fixture), chat_type(type_id, 1), {**VALUES, "rag_context": "untrusted"})


def test_mimo_rag_cannot_use_dynamic_role_to_gain_authority():
    fixture = body(TYPES[2])
    fixture["input"] = [{"role": "${xh.user_input}", "content": "${xh.rag_context}"}]
    with pytest.raises(ApiRequestError, match="WRONG_VARIABLE_LOCATION"):
        render_request(
            json.dumps(fixture), chat_type(TYPES[2], 1), {**VALUES, "user_input": "system", "rag_context": "untrusted"}
        )


def test_anthropic_tool_result_slot_and_wrong_block():
    fixture = rag_body(TYPES[1])
    fixture["messages"][-1]["content"] = [{"type": "tool_result", "tool_use_id": "c", "content": "${xh.rag_context}"}]
    assert (
        render_request(json.dumps(fixture), chat_type(TYPES[1], 1), {**VALUES, "rag_context": "data"})["messages"][-1][
            "content"
        ][0]["content"]
        == "data"
    )
    fixture["messages"][-1]["content"][0]["type"] = "tool_use"
    with pytest.raises(ApiRequestError, match="WRONG_VARIABLE_LOCATION"):
        render_request(json.dumps(fixture), chat_type(TYPES[1], 1), {**VALUES, "rag_context": "data"})


@pytest.mark.asyncio
@pytest.mark.parametrize("results", [[], [{"text": "untrusted instructions ${xh.model}"}]])
async def test_run_bound_redeem_partition_empty_and_content(monkeypatch, results):
    redeem = AsyncMock(return_value=embedding_grant())
    monkeypatch.setattr(app_state.config_client, "redeem_provider_lease", redeem)
    monkeypatch.setattr(app_state, "shared_pg_engine", lambda: object())
    embed = AsyncMock(return_value=[0.1] * 768)
    search = AsyncMock(return_value=results)
    monkeypatch.setattr(chat_context.DashScopeEmbeddings, "embed", embed)
    monkeypatch.setattr(chat_context.VectorStore, "search", search)
    data = {"embeddingProfile": profile(), "embeddingCredentialLease": "one-use", "workspaceId": "workspace-fixture"}
    text, state, count = await chat_context.retrieve_chat_context(data, "question", "run-fixture", "request-fixture")
    assert state == ("empty" if not results else None)
    assert count == len(results)
    assert text == (results[0]["text"] if results else "")
    assert redeem.await_args.args[0]["runId"] == "run-fixture"
    assert redeem.await_args.args[0]["providerConnectionId"] == profile()["providerConnectionId"]
    assert search.await_args.args[1] == profile()
    embed.assert_awaited_once_with("question")


@pytest.mark.asyncio
@pytest.mark.parametrize("fault", ["transport", "query"])
async def test_private_exception_details_never_enter_rag_logs(monkeypatch, fault):
    from loguru import logger

    private = "synthetic-private-query-or-credential"
    failure = RuntimeError(private)
    redeem = AsyncMock(side_effect=failure) if fault == "transport" else AsyncMock(return_value=embedding_grant())
    monkeypatch.setattr(app_state.config_client, "redeem_provider_lease", redeem)
    monkeypatch.setattr(app_state, "shared_pg_engine", lambda: object())
    monkeypatch.setattr(chat_context.DashScopeEmbeddings, "embed", AsyncMock(return_value=[0.1] * 768))
    monkeypatch.setattr(chat_context.VectorStore, "search", AsyncMock(side_effect=failure))
    output: list[str] = []
    sink = logger.add(output.append, format="{message}\n{exception}", diagnose=False)
    try:
        with pytest.raises(ApiRequestError):
            await chat_context.retrieve_chat_context(
                {"embeddingProfile": profile(), "embeddingCredentialLease": "one-use", "workspaceId": "workspace-fixture"},
                "question", "safe-run", "safe-request",
            )
    finally:
        logger.remove(sink)
    rendered = "".join(output)
    assert "safe-run" in rendered
    assert "RuntimeError" in rendered
    assert private not in rendered


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "fault,code",
    [
        ("profile", "RAG_PROFILE_UNAVAILABLE"),
        ("lease", "RAG_LEASE_INVALID"),
        ("mismatch", "RAG_LEASE_MISMATCH"),
        ("provider", "RAG_QUERY_FAILED"),
        ("db", "RAG_QUERY_FAILED"),
    ],
)
async def test_retrieval_failure_never_dispatches_chat(monkeypatch, fault, code):
    from xihe_agent.main import app

    data = snapshot_request(TYPES[0])
    data.update(workspaceId="workspace-fixture", embeddingProfile=profile(), embeddingCredentialLease="one-use")
    data["contextTemplateSnapshot"]["template"]["bodySource"] = json.dumps(rag_body(TYPES[0]))
    embedding = embedding_grant()
    if fault == "profile":
        data.pop("embeddingProfile")
    if fault == "mismatch":
        embedding["model"] = "wrong"
    failure = ProviderLeaseError("PROVIDER_CREDENTIAL_LEASE_INVALID", 409)
    redeem = AsyncMock(
        side_effect=[
            {
                **grant(TYPES[0], "https://chat.invalid"),
                "provider": "fixture-provider",
                "model": "fixture",
                "connectionRevision": 2,
            },
            failure if fault == "lease" else embedding,
        ]
    )
    monkeypatch.setattr(app_state.config_client, "redeem_provider_lease", redeem)
    monkeypatch.setattr(app_state, "shared_pg_engine", lambda: object())
    monkeypatch.setattr(
        chat_context.DashScopeEmbeddings,
        "embed",
        AsyncMock(side_effect=RuntimeError("provider") if fault == "provider" else None, return_value=[0.1] * 768),
    )
    monkeypatch.setattr(
        chat_context.VectorStore,
        "search",
        AsyncMock(side_effect=RuntimeError("db") if fault == "db" else None, return_value=[]),
    )
    dispatch = AsyncMock()
    monkeypatch.setattr(route.ApiChatModel, "_agenerate", dispatch)
    monkeypatch.setattr(route.ApiChatModel, "_astream", dispatch)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://agent-fixture") as client:
        response = await client.post(
            "/internal/v1/agent/chat", json=data, headers={"Authorization": f"Bearer {app_state.CP_API_TOKEN}"}
        )
    assert response.json()["code"] == code
    dispatch.assert_not_called()


@pytest.mark.parametrize("type_id", TYPES)
def test_each_step_renders_rag_separately_preserving_authority(type_id):
    source = rag_body(type_id)
    source["system" if type_id == TYPES[1] else "instructions"] = "${xh.agent_instructions}"
    values = {**VALUES, "agent_instructions": "authorized baseline", "rag_context": "untrusted data"}
    model = ApiChatModel(
        api_type=chat_type(type_id, 1),
        grant=grant(type_id, "https://chat.invalid/v1"),
        body_source=json.dumps(source),
        values=values,
        request_id="request-fixture",
        timeout=1,
        token_estimator=lambda native: len(json.dumps(native)),
    )
    first = model._dispatch_body([HumanMessage(content="question")])
    second = model._dispatch_body(
        [
            HumanMessage(content="question"),
            AIMessage(content="tool", tool_calls=[{"id": "c", "name": "read", "args": {}}]),
            ToolMessage(content="result", tool_call_id="c"),
        ]
    )
    field = "system" if type_id == TYPES[1] else "instructions"
    assert first[field] == second[field] == values["agent_instructions"]
    assert json.dumps(second).count("untrusted data") == 1
    assert len(second["input" if type_id == TYPES[2] else "messages"]) > len(
        first["input" if type_id == TYPES[2] else "messages"]
    )
    assert model.estimated_input_tokens == len(json.dumps(first)) + len(json.dumps(second))
    assert values["agent_instructions"] == "authorized baseline"


@pytest.mark.parametrize("results", [[], [{"text": "retrieved untrusted data"}]])
async def test_rag_route_real_chat_wire_empty_and_data_stays_out_of_baseline(monkeypatch, results):
    from xihe_agent.interfaces.context import AgentContext
    from xihe_agent.main import app

    data = snapshot_request(TYPES[0])
    data.update(workspaceId="workspace-fixture", embeddingProfile=profile(), embeddingCredentialLease="one-use")
    source = rag_body(TYPES[0])
    source["messages"].insert(0, {"role": "system", "content": "${xh.agent_instructions}"})
    data["contextTemplateSnapshot"]["template"]["bodySource"] = json.dumps(source)
    context = AgentContext.empty("session-fixture")
    monkeypatch.setattr(route.context_provider, "load", AsyncMock(return_value=context))
    append = AsyncMock()
    monkeypatch.setattr(route.cp_event_store_client, "append", append)
    monkeypatch.setattr(app_state, "shared_pg_engine", lambda: object())
    monkeypatch.setattr(chat_context.DashScopeEmbeddings, "embed", AsyncMock(return_value=[0.1] * 768))
    monkeypatch.setattr(chat_context.VectorStore, "search", AsyncMock(return_value=results))
    payload = 'data: {"choices":[{"delta":{"content":"answer"}}]}\n\ndata: [DONE]\n\n'
    async with recorder(payload, stream=True) as (base, captures):
        redeem = AsyncMock(
            side_effect=[
                {**grant(TYPES[0], base), "provider": "fixture-provider", "model": "fixture", "connectionRevision": 2},
                embedding_grant(),
            ]
        )
        monkeypatch.setattr(app_state.config_client, "redeem_provider_lease", redeem)
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://agent-fixture") as client:
            response = await client.post(
                "/internal/v1/agent/chat", json=data, headers={"Authorization": f"Bearer {app_state.CP_API_TOKEN}"}
            )
    assert response.status_code == 200
    assert '"outcome": "success"' in response.text
    assert '"phase": "rag"' in response.text
    if not results:
        assert '"state": "empty"' in response.text
    else:
        assert '"matches": 1' in response.text
        assert '"state": "ready"' not in response.text
    assert len(captures) == 1
    wire = captures[0][2]
    assert wire["messages"][0] == {"role": "system", "content": data["instructions"]}
    assert wire["messages"][-1]["content"] == "RAG: " + (results[0]["text"] if results else "")
    assert context.runtime_state["instructions"] == data["instructions"]
    for call in append.await_args_list:
        assert "retrieved untrusted data" not in json.dumps(call.args[0].payload)
    assert redeem.await_count == 2
    assert redeem.await_args_list[-1].args[0]["runId"]
