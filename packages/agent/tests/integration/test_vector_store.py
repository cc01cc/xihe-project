"""
VectorStore integration tests using real PostgreSQL (pgvector).
Requires PostgreSQL running at the configured DSN.
Uses the same skip-if-unavailable pattern as test_agent_cp_integration.py.

Run with: uv run pytest tests/integration/test_vector_store.py -v
Or all integration: uv run pytest tests/integration/ -v
"""
import os

import pytest

from xihe_agent.rag.embeddings import EmbeddingService, LiteLLMEmbeddings
from xihe_agent.rag.store import VectorStore

PG_DSN = os.getenv(
    "XIHE_PG_DSN",
    "postgresql+psycopg://xihe:xihe123@postgres:5432/xihe",
)


def is_pg_available() -> bool:
    try:
        import subprocess
        # Extract host from DSN
        dsn = PG_DSN.replace("postgresql+psycopg://", "")
        host = dsn.split("@")[1].split(":")[0] if "@" in dsn else dsn.split(":")[0]
        port = dsn.split(":")[2].split("/")[0] if ":" in dsn else "5432"

        result = subprocess.run(
            ["pg_isready", "-h", host, "-p", port, "-t", "3"],
            capture_output=True, text=True, timeout=5,
        )
        return result.returncode == 0
    except Exception:
        return False


pg_available = is_pg_available()


@pytest.fixture
async def vector_store():
    store = VectorStore(dsn=PG_DSN, embedding_service=LiteLLMEmbeddings(
        service=EmbeddingService(
            model=os.getenv("XIHE_EMBEDDING_MODEL", "text-embedding-3-small"),
            api_key=os.getenv("XIHE_EMBEDDING_API_KEY", ""),
            api_base=os.getenv("XIHE_EMBEDDING_API_BASE", ""),
        )
    ))
    await store._ensure_store()
    await store.clear()
    yield store
    await store.clear()


@pytest.mark.integration
@pytest.mark.skipif(not pg_available, reason=f"PostgreSQL not available at {PG_DSN}")
@pytest.mark.asyncio
class TestVectorStore:
    async def test_add_and_count(self, vector_store):
        test_meta = {"source": "test_add"}
        doc_id = await vector_store.add("hello world", test_meta)
        assert doc_id is not None
        assert len(doc_id) == 36

        count = await vector_store.count()
        assert count >= 1

        await vector_store.delete(doc_id)

    async def test_search_returns_results(self, vector_store):
        await vector_store.add("apple banana fruit", {"type": "fruit"})
        await vector_store.add("dog cat animal", {"type": "animal"})

        query_emb = await vector_store._embedding.aembed_query("fruit")
        results = await vector_store.search(query_emb, top_k=5, min_score=0.0)

        assert len(results) >= 1
        assert results[0]["score"] > 0
        assert "text" in results[0]

    async def test_search_with_min_score(self, vector_store):
        await vector_store.add("sky blue color", {"type": "color"})

        query_emb = await vector_store._embedding.aembed_query("fruit")
        results = await vector_store.search(query_emb, top_k=5, min_score=0.9)
        assert len(results) == 0

    async def test_delete_removes_document(self, vector_store):
        doc_id = await vector_store.add("delete me", {"test": "delete"})
        assert await vector_store.count() >= 1

        deleted = await vector_store.delete(doc_id)
        assert deleted

        count = await vector_store.count()
        assert count == 0

    async def test_clear_removes_all(self, vector_store):
        await vector_store.add("doc a", {"idx": 1})
        await vector_store.add("doc b", {"idx": 2})
        assert await vector_store.count() >= 2

        await vector_store.clear()
        assert await vector_store.count() == 0
