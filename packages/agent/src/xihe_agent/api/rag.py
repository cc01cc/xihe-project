"""RAG ingest/search/stats/delete routes.

Moved verbatim from `main.py` (PLAN-0473 T2.2); Form/File parsing, defaults,
and 503 gating unchanged. RAG components live in `app_state` and are swapped
by the config refresh.
"""

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile

from xihe_agent.api.shared import verify_api_token
from xihe_agent.app_state import (
    embedding_enabled,
    embedding_service,
    vector_store,
)
from xihe_agent.rag import chunk_document as rag_chunk

router = APIRouter()


def _rag_config_defaults() -> dict[str, int | float]:
    """PLAN-0307 T2.4: RAG defaults come from the DB `rag` domain; request params win."""
    from xihe_agent.app_state import config_client

    return {
        "chunkSize": int(config_client.get("rag", "chunkSize") or 1000),
        "chunkOverlap": int(config_client.get("rag", "chunkOverlap") or 200),
        "topK": int(config_client.get("rag", "topK") or 5),
        "minScore": float(config_client.get("rag", "minScore") or 0.0),
    }


@router.post("/internal/v1/agent/rag/ingest", dependencies=[Depends(verify_api_token)])
async def rag_ingest(
    file: UploadFile = File(...),
    chunk_size: int | None = Form(None, alias="chunkSize"),
    chunk_overlap: int | None = Form(None, alias="chunkOverlap"),
):
    if not embedding_enabled:
        raise HTTPException(status_code=503, detail="RAG embedding provider is not configured")
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
    doc_ids = []
    for chunk in chunks:
        doc_id = await vector_store.add(chunk["text"], chunk["metadata"])
        doc_ids.append(doc_id)
    return {"status": "ok", "chunks": len(chunks), "docIds": doc_ids}


@router.post("/internal/v1/agent/rag/search", dependencies=[Depends(verify_api_token)])
async def rag_search(
    query: str = Form(...),
    top_k: int | None = Form(None, alias="topK"),
    min_score: float | None = Form(None, alias="minScore"),
):
    if not embedding_enabled:
        raise HTTPException(status_code=503, detail="RAG embedding provider is not configured")
    defaults = _rag_config_defaults()
    resolved_top_k = int(defaults["topK"] if top_k is None else top_k)
    resolved_min_score = float(defaults["minScore"] if min_score is None else min_score)
    query_emb = await embedding_service.embed(query)
    results = await vector_store.search(query_emb, top_k=resolved_top_k, min_score=resolved_min_score)
    return {"results": results}


@router.get("/internal/v1/agent/rag/stats", dependencies=[Depends(verify_api_token)])
async def rag_stats():
    return {"totalDocuments": await vector_store.count()}


@router.delete("/internal/v1/agent/rag/documents/{doc_id}", dependencies=[Depends(verify_api_token)])
async def rag_delete(doc_id: str):
    ok = await vector_store.delete(doc_id)
    return {"deleted": ok}
