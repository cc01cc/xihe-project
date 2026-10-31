"""Run-scoped retrieval for a template's data-only RAG slot (PLAN-0416)."""

from __future__ import annotations

from typing import Any

from loguru import logger

from xihe_agent.config_client import ProviderLeaseError
from xihe_agent.config_snapshot import RunConfigSnapshot
from xihe_agent.llm.api_request import ApiRequestError
from xihe_agent.rag.dashscope import DashScopeEmbeddings, EmbeddingProviderError, validate_profile
from xihe_agent.rag.store import VectorSchemaError, VectorStore


async def retrieve_chat_context(
    data: dict[str, Any],
    query: str,
    run_id: str,
    request_id: str,
    snapshot: RunConfigSnapshot,
) -> tuple[str, str | None, int]:
    """Redeem once, query only the complete profile partition, discard grant.

    Return data text and non-sensitive observation; never mutate instructions
    or durable Context. Caller invokes only after strict template validation.
    PLAN-0590: retrieval parameters come from the run's own config snapshot; the
    process-wide effective cache is never read here (spec §7).
    """
    from xihe_agent.app_state import config_client, shared_pg_engine

    profile = data.get("embeddingProfile")
    if not isinstance(profile, dict):
        raise ApiRequestError("RAG_PROFILE_UNAVAILABLE", 409)
    try:
        validate_profile(profile)
        if (
            profile.get("workspaceId") != data.get("workspaceId")
            or not isinstance(profile.get("providerId"), str)
            or type(profile.get("connectionRevision")) is not int
        ):
            raise ApiRequestError("RAG_PROFILE_UNAVAILABLE", 409)
    except EmbeddingProviderError as exc:
        logger.warning("RAG profile unavailable runId={} errorType={}", run_id, type(exc).__name__)
        raise ApiRequestError("RAG_PROFILE_UNAVAILABLE", 409) from exc
    lease = data.get("embeddingCredentialLease")
    if not isinstance(lease, str) or not lease:
        raise ApiRequestError("RAG_LEASE_INVALID", 409)
    try:
        grant = await config_client.redeem_provider_lease(
            {
                "lease": lease,
                "runId": run_id,
                "providerConnectionId": profile.get("providerConnectionId"),
                "providerId": profile.get("providerId"),
                "model": profile.get("modelId"),
                "connectionRevision": profile.get("connectionRevision"),
            },
            request_id=request_id,
        )
    except ProviderLeaseError as exc:
        logger.warning("RAG lease rejected runId={} code={}", run_id, exc.code)
        code = exc.code.removeprefix("PROVIDER_CREDENTIAL_LEASE_")
        raise ApiRequestError(f"RAG_LEASE_{code}", exc.status) from exc
    except Exception as exc:
        logger.warning("RAG lease transport unavailable runId={} errorType={}", run_id, type(exc).__name__)
        raise ApiRequestError("RAG_LEASE_UNAVAILABLE", 503) from exc
    if (
        grant.get("operation") != "embedding"
        or grant.get("apiTypeId") != profile.get("apiTypeId")
        or grant.get("apiTypeVersion") != profile.get("apiTypeVersion")
        or grant.get("model") != profile.get("modelId")
        or grant.get("provider") != profile.get("providerId")
        or grant.get("connectionRevision") != profile.get("connectionRevision")
    ):
        raise ApiRequestError("RAG_LEASE_MISMATCH", 409)
    try:
        adapter = DashScopeEmbeddings(api_key=grant.get("apiKey") or "", base_url=grant.get("baseUrl") or "")
        # No Run/global grant cache: only the request-scoped adapter owns the key.
        del grant
        store = VectorStore(dsn="", embedding_service=adapter, shared_engine=shared_pg_engine())
        vector = await adapter.embed(query)
        top_k = int(snapshot.get("rag", "topK") or 5)
        min_score = float(snapshot.get("rag", "minScore") or 0.0)
        if top_k < 1:
            raise ValueError("Invalid configured topK")
        results = await store.search(vector, profile, top_k=top_k, min_score=min_score)
        text = "\n\n".join(str(result["text"]) for result in results)
    except VectorSchemaError as exc:
        logger.warning("RAG partition unavailable runId={} errorType={}", run_id, type(exc).__name__)
        raise ApiRequestError("RAG_PROFILE_UNAVAILABLE", 409) from exc
    except Exception as exc:
        logger.warning("RAG query failed runId={} errorType={}", run_id, type(exc).__name__)
        raise ApiRequestError("RAG_QUERY_FAILED", 502) from exc
    return text, "empty" if not results else None, len(results)
