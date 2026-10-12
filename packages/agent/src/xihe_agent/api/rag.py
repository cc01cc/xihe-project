"""PLAN-0485 RAG routes: request-scoped profile/lease per operation.

Round-4 items 2-6:
- CP derives owner/profile from the authenticated TenantContext and sends the
  non-secret ``embeddingProfile`` plus a separate opaque one-use
  ``embeddingCredentialLease``; no owner values are accepted from callers.
- Every operation redeems its own lease and builds a request-scoped
  DashScope adapter; only the DB engine/pool is process-shared.
- Errors use stable RFC 9457 codes and never carry provider payloads, keys,
  vectors or raw upstream text. A valid retrieval with zero matches stays a
  success; failures are never surfaced as empty results.
"""

import json as _json
from typing import Any

from fastapi import APIRouter, Depends, File, Form, Request, UploadFile
from fastapi.responses import JSONResponse

from xihe_agent.api.shared import problem_details, verify_api_token
from xihe_agent.config_client import ProviderLeaseError
from xihe_agent.rag import chunk_document as rag_chunk
from xihe_agent.rag.dashscope import (
    SUPPORTED_DIMENSION,
    SUPPORTED_MODEL,
    DashScopeEmbeddings,
    EmbeddingProviderError,
    validate_profile,
)
from xihe_agent.rag.store import VectorSchemaError, VectorStore

router = APIRouter()

REDEEM_ATTEMPTED_CODES = {
    "EMBEDDING_PROVIDER_UNREACHABLE",
    "EMBEDDING_PROVIDER_AUTH_FAILED",
    "EMBEDDING_RESPONSE_INVALID",
    "EMBEDDING_DIMENSION_MISMATCH",
}


def _rag_config_defaults() -> dict[str, int | float]:
    """PLAN-0307 T2.4: RAG defaults come from the DB `rag` domain; request params win."""
    from xihe_agent.app_state import config_client

    return {
        "chunkSize": int(config_client.get("rag", "chunkSize") or 1000),
        "chunkOverlap": int(config_client.get("rag", "chunkOverlap") or 200),
        "topK": int(config_client.get("rag", "topK") or 5),
        "minScore": float(config_client.get("rag", "minScore") or 0.0),
    }


def _parse_profile(raw: str | None) -> dict[str, Any]:
    if not raw:
        raise EmbeddingProviderError("EMBEDDING_PROFILE_REQUIRED", 409)
    try:
        profile = _json.loads(raw)
    except ValueError:
        raise EmbeddingProviderError("EMBEDDING_PROFILE_CONFLICT", 409)
    validate_profile(profile)
    return profile


def _reject_legacy_profile(payload: dict[str, Any]) -> None:
    if "providerId" not in payload and "modelId" not in payload:
        raise EmbeddingProviderError("EMBEDDING_PROFILE_REQUIRED", 409)


def _request_id(request: Request) -> str:
    return request.headers.get("X-Request-Id") or ""


def _problem(request_id: str, exc: EmbeddingProviderError) -> JSONResponse:
    return problem_details(request_id, exc.status, exc.code, exc.code)


def _build_store(profile: dict[str, Any], grant: dict[str, Any]) -> VectorStore:
    """Request-scoped store: shared engine/pool, per-request embedding adapter."""
    from xihe_agent.app_state import shared_pg_engine

    adapter = DashScopeEmbeddings(
        api_key=grant.get("apiKey") or "",
        base_url=grant.get("baseUrl") or "",
    )
    return VectorStore(
        dsn="",
        embedding_service=adapter,
        shared_engine=shared_pg_engine(),
    )


async def _redeem(profile: dict[str, Any], lease: str | None) -> dict[str, Any]:
    from xihe_agent.app_state import config_client

    if not lease:
        raise EmbeddingProviderError("PROVIDER_CREDENTIAL_LEASE_INVALID", 409)
    return await config_client.redeem_provider_lease(
        {
            "lease": lease,
            "runId": None,
            "providerConnectionId": profile.get("providerConnectionId"),
            "providerId": profile.get("providerId"),
            "model": profile.get("modelId"),
            "connectionRevision": profile.get("connectionRevision"),
        }
    )


@router.post("/internal/v1/agent/rag/embedding/test", dependencies=[Depends(verify_api_token)])
async def rag_embedding_test(request: Request) -> JSONResponse:
    """One provider request; response is sanitized model/dimension/requestId only."""
    request_id = _request_id(request)
    try:
        payload = await request.json()
    except ValueError:
        payload = {}
    if not isinstance(payload, dict):
        payload = {}
    _reject_legacy_profile(payload)
    profile = _parse_profile(_json.dumps(payload.get("embeddingProfile") or {}))
    try:
        grant = await _redeem(profile, payload.get("embeddingCredentialLease"))
        if grant.get("operation") != "embedding":
            raise EmbeddingProviderError("API_TYPE_OPERATION_MISMATCH", 400)
        adapter = DashScopeEmbeddings(
            api_key=grant.get("apiKey") or "",
            base_url=grant.get("baseUrl") or "",
        )
        vector = await adapter.embed("xihe embedding test")
        if len(vector) != SUPPORTED_DIMENSION:
            raise EmbeddingProviderError("EMBEDDING_DIMENSION_MISMATCH", 502)
    except EmbeddingProviderError as exc:
        return _problem(request_id, exc)
    except ProviderLeaseError as exc:
        return problem_details(request_id, exc.status, exc.code, exc.code)
    return JSONResponse(
        status_code=200,
        headers={"X-Request-Id": request_id},
        content={
            "status": "ok",
            "model": SUPPORTED_MODEL,
            "dimension": SUPPORTED_DIMENSION,
            "requestId": request_id,
        },
    )


@router.post("/internal/v1/agent/rag/ingest", dependencies=[Depends(verify_api_token)])
async def rag_ingest(
    request: Request,
    file: UploadFile = File(...),
    chunk_size: int | None = Form(None, alias="chunkSize"),
    chunk_overlap: int | None = Form(None, alias="chunkOverlap"),
    embedding_profile: str | None = Form(None, alias="embeddingProfile"),
    embedding_credential_lease: str | None = Form(None, alias="embeddingCredentialLease"),
):
    request_id = _request_id(request)
    try:
        profile = _parse_profile(embedding_profile)
        defaults = _rag_config_defaults()
        resolved_chunk_size = int(defaults["chunkSize"] if chunk_size is None else chunk_size)
        resolved_chunk_overlap = int(defaults["chunkOverlap"] if chunk_overlap is None else chunk_overlap)
        content = (await file.read()).decode("utf-8", errors="replace")
        chunks = rag_chunk(
            content,
            chunk_size=resolved_chunk_size,
            chunk_overlap=resolved_chunk_overlap,
            metadata={"filename": file.filename},
        )
        grant = await _redeem(profile, embedding_credential_lease)
        if grant.get("operation") != "embedding":
            raise EmbeddingProviderError("API_TYPE_OPERATION_MISMATCH", 400)
        store = _build_store(profile, grant)
        doc_id = await store.add_document(
            [chunk["text"] for chunk in chunks], profile, file.filename
        )
    except EmbeddingProviderError as exc:
        return _problem(request_id, exc)
    except ProviderLeaseError as exc:
        return problem_details(request_id, exc.status, exc.code, exc.code)
    except VectorSchemaError as exc:
        return problem_details(request_id, 409, exc.code, exc.code)
    return JSONResponse(
        status_code=200,
        headers={"X-Request-Id": request_id},
        content={"status": "ok", "docId": doc_id, "chunks": len(chunks)},
    )


@router.post("/internal/v1/agent/rag/search", dependencies=[Depends(verify_api_token)])
async def rag_search(
    request: Request,
):
    request_id = _request_id(request)
    try:
        payload = await request.json()
    except ValueError:
        payload = {}
    if not isinstance(payload, dict):
        payload = {}
    _reject_legacy_profile(payload)
    try:
        profile = _parse_profile(_json.dumps(payload.get("embeddingProfile") or {}))
        defaults = _rag_config_defaults()
        resolved_top_k = int(defaults["topK"] if payload.get("topK") is None else payload["topK"])
        resolved_min_score = float(
            defaults["minScore"] if payload.get("minScore") is None else payload["minScore"]
        )
        grant = await _redeem(profile, payload.get("embeddingCredentialLease"))
        if grant.get("operation") != "embedding":
            raise EmbeddingProviderError("API_TYPE_OPERATION_MISMATCH", 400)
        store = _build_store(profile, grant)
        query_embedding = await store._embedding.embed(str(payload.get("query") or ""))
        results = await store.search(
            query_embedding,
            profile,
            top_k=resolved_top_k,
            min_score=resolved_min_score,
        )
    except EmbeddingProviderError as exc:
        return _problem(request_id, exc)
    except ProviderLeaseError as exc:
        return problem_details(request_id, exc.status, exc.code, exc.code)
    except VectorSchemaError as exc:
        return problem_details(request_id, 409, exc.code, exc.code)
    return JSONResponse(
        status_code=200,
        headers={"X-Request-Id": request_id},
        content={"results": results},
    )


@router.post("/internal/v1/agent/rag/stats", dependencies=[Depends(verify_api_token)])
async def rag_stats(request: Request):
    """Counts only the active partition; no provider call or lease (item 2)."""
    request_id = _request_id(request)
    try:
        payload = await request.json()
    except ValueError:
        payload = {}
    if not isinstance(payload, dict):
        payload = {}
    _reject_legacy_profile(payload)
    try:
        profile = _parse_profile(_json.dumps(payload.get("embeddingProfile") or {}))
        from xihe_agent.app_state import shared_pg_engine

        store = VectorStore(dsn="", embedding_service=None, shared_engine=shared_pg_engine())
        total = await store.count(profile)
        documents = await store.documents(profile)
    except EmbeddingProviderError as exc:
        return _problem(request_id, exc)
    except VectorSchemaError as exc:
        return problem_details(request_id, 409, exc.code, exc.code)
    return JSONResponse(
        status_code=200,
        headers={"X-Request-Id": request_id},
        content={"totalDocuments": total, "documents": documents},
    )


@router.post("/internal/v1/agent/rag/documents/{doc_id}/delete", dependencies=[Depends(verify_api_token)])
async def rag_delete(doc_id: str, request: Request):
    request_id = _request_id(request)
    try:
        payload = await request.json()
    except ValueError:
        payload = {}
    if not isinstance(payload, dict):
        payload = {}
    _reject_legacy_profile(payload)
    try:
        profile = _parse_profile(_json.dumps(payload.get("embeddingProfile") or {}))
        from xihe_agent.app_state import shared_pg_engine

        store = VectorStore(dsn="", embedding_service=None, shared_engine=shared_pg_engine())
        deleted = await store.delete(doc_id, profile)
    except EmbeddingProviderError as exc:
        return _problem(request_id, exc)
    except VectorSchemaError as exc:
        return problem_details(request_id, 409, exc.code, exc.code)
    if not deleted:
        return problem_details(request_id, 404, "RAG_DOCUMENT_NOT_FOUND", "Document not found")
    return JSONResponse(
        status_code=200,
        headers={"X-Request-Id": request_id},
        content={"deleted": True},
    )
