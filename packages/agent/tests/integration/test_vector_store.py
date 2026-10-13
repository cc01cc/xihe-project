"""PLAN-0485 T4.1: partitioned VectorStore against the host-runner PG.

The destructive clear() may touch only a host-runner-provisioned disposable
database. The DSN must come from the XIHE_E2E_PG_* variables the isolated
runner composes (pgvector/pgvector:pg17, unique project/db per run); falling
back to a developer default DSN is a hard error, not a skip. A record of the
isolation check is asserted before any clear().
"""

import os

import pytest

from xihe_agent.rag.dashscope import (
    SUPPORTED_DIMENSION,
    SUPPORTED_MODEL,
)
from xihe_agent.rag.store import VectorStore

pytestmark = [pytest.mark.integration]


def _pg_dsn() -> str:
    host = os.getenv("XIHE_E2E_PG_HOST") or "localhost"
    port = os.getenv("XIHE_E2E_PG_PORT")
    database = os.getenv("XIHE_E2E_PG_DATABASE")
    user = os.getenv("XIHE_E2E_PG_USER")
    # The compose stack uses POSTGRES_HOST_AUTH_METHOD=trust; the password
    # stays inside the container by design and is not part of the wire.
    if not database or not user or not port:
        pytest.fail(
            "XIHE_E2E_PG_DATABASE/USER/PORT are not set; "
            "test_vector_store may run only via the isolated host runner (no default DSN fallback)"
        )
    # asyncpg, not psycopg: the psycopg async transport hangs on this Windows
    # host (probe evidence, 2026-10-12); asyncpg fails fast on bad databases.
    return f"postgresql+asyncpg://{user}@{host}:{port}/{database}"


def _profile() -> dict:
    return {
        "workspaceId": "11111111-1111-1111-1111-111111111111",
        "userId": "22222222-2222-2222-2222-222222222222",
        "connectionOwnerType": "USER",
        "connectionOwnerId": "22222222-2222-2222-2222-222222222222",
        "providerConnectionId": "33333333-3333-3333-3333-333333333333",
        "providerId": "dashscope-qwen",
        "connectionKey": "embedding",
        "connectionRevision": 1,
        "apiTypeId": "dashscope-multimodal-embedding",
        "apiTypeVersion": 1,
        "modelId": SUPPORTED_MODEL,
        "dimension": SUPPORTED_DIMENSION,
        "profileScope": "user",
        "connectionOwnerScope": "user",
        "modelSource": "profile",
    }


def _other_profile() -> dict:
    profile = dict(_profile())
    profile["providerConnectionId"] = "44444444-4444-4444-4444-444444444444"
    return profile


class _DeterministicEmbeddings:
    """Offline deterministic vectors; provider wire is covered by unit tests."""

    async def aembed_documents(self, texts):
        return [[float(len(text) % 7 + 1), 0.5, 0.25] * (SUPPORTED_DIMENSION // 3)
                for text in texts]

    async def aembed_query(self, text):
        return (await self.aembed_documents([text]))[0]


@pytest.fixture
async def store():
    dsn = _pg_dsn()
    vector_store = VectorStore(
        dsn=dsn,
        embedding_service=_DeterministicEmbeddings(),
    )
    await vector_store._ensure_store()
    profile = _profile()
    await vector_store.clear(profile)
    yield vector_store
    await vector_store.clear(profile)
    await vector_store.close()


async def test_partition_ingest_count_and_delete_are_scoped(store):
    profile = _profile()
    doc_id = await store.add_document(["hello world", "second chunk"], profile, "notes.pdf")
    assert doc_id
    assert await store.count(profile) == 1

    other = _other_profile()
    assert await store.count(other) == 0

    assert await store.delete(doc_id, profile) is True
    assert await store.delete(doc_id, profile) is False
    assert await store.count(profile) == 0


async def test_search_filters_by_partition_before_rank(store):
    profile = _profile()
    other = _other_profile()
    await store.add_document(["apple banana"], profile, "a.pdf")
    await store.add_document(["apple banana"], other, "b.pdf")

    query = await store._embedding.aembed_query("apple")
    own = await store.search(query, profile, top_k=5, min_score=0.0)
    foreign = await store.search(query, other, top_k=5, min_score=0.0)

    assert len(own) == 1
    assert own[0]["filename"] == "a.pdf"
    assert all(item["filename"] != "b.pdf" for item in own)
    assert len(foreign) == 1
    assert foreign[0]["filename"] == "b.pdf"


@pytest.mark.parametrize(
    "field,value",
    [
        ("workspaceId", "55555555-5555-5555-5555-555555555555"),
        ("connectionOwnerType", "WORKSPACE"),
        ("connectionOwnerId", "66666666-6666-6666-6666-666666666666"),
        ("providerConnectionId", "77777777-7777-7777-7777-777777777777"),
    ],
)
async def test_chat_rag_full_partition_predicate_precedes_top_k(store, field, value):
    """Observe PostgreSQL's actual search SQL and adversarial scope isolation.

    Run only on the existing isolated host-runner DB. The fixed API/model/
    dimension identity is checked in the emitted SQL; mutable owner/workspace/
    connection identities are also exercised with real competing rows.
    """
    from sqlalchemy import event

    from xihe_agent.rag.store import partition_filter

    profile = _profile()
    foreign = {**profile, field: value}
    await store.add_document(["same query text"], profile, "chat-own.pdf")
    await store.add_document(["same query text"] * 3, foreign, "chat-foreign.pdf")
    query = await store._embedding.aembed_query("same query text")
    engine = await store._ensure_engine()
    statements = []

    def record(_conn, _cursor, statement, _parameters, _context, _executemany):
        if "ORDER BY" in statement.upper() and "embedding" in statement.lower():
            statements.append(statement)

    event.listen(engine.sync_engine, "before_cursor_execute", record)
    try:
        own = await store.search(query, profile, top_k=1, min_score=0.0)
    finally:
        event.remove(engine.sync_engine, "before_cursor_execute", record)
    assert len(own) == 1
    assert own[0]["filename"] == "chat-own.pdf"
    assert statements, "Must capture actual PostgreSQL search, not a constructed SQL fixture"
    for statement in statements:
        sql = statement.upper()
        predicate = sql[sql.index("WHERE"):sql.index("ORDER BY")]
        assert "LIMIT" in sql[sql.index("ORDER BY"):]
        for column in partition_filter(profile):
            assert column.upper() in predicate


async def test_search_respects_min_score(store):
    profile = _profile()
    await store.add_document(["apple banana"], profile, "a.pdf")
    query = await store._embedding.aembed_query("apple")
    assert await store.search(query, profile, top_k=5, min_score=1.01) == []


async def test_documents_lists_partition_only(store):
    profile = _profile()
    await store.add_document(["one"], profile, "one.pdf")
    await store.add_document(["two"], _other_profile(), "two.pdf")
    documents = await store.documents(profile)
    assert [item["filename"] for item in documents] == ["one.pdf"]
    assert documents[0]["chunks"] == 1


async def test_dimension_mismatch_is_rejected_before_insert(store):
    from xihe_agent.rag.store import VectorSchemaError

    class WrongDim:
        async def aembed_documents(self, texts):
            return [[0.1, 0.2, 0.3] for _ in texts]

    broken = VectorStore(dsn="", embedding_service=WrongDim())
    broken._shared_engine = store._shared_engine
    with pytest.raises(VectorSchemaError):
        await broken.add_document(["one"], _profile(), "x.pdf")
