"""PLAN-0485 product tests: DashScope adapter, partition store and RAG routes.

Real ephemeral loopback recorder for the provider wire; sqlite-free. The
partition store SQL paths use a fake engine with recorded statements; real
PostgreSQL behaviour is covered by tests/integration/test_vector_store.py.
"""

import asyncio
import json
from typing import Any

import httpx
import pytest

from xihe_agent.rag.dashscope import (
    DashScopeEmbeddings,
    EmbeddingProviderError,
    SUPPORTED_DIMENSION,
    SUPPORTED_MODEL,
    partition_fields,
    validate_profile,
)
from xihe_agent.rag.store import (
    PARTITION_COLUMNS,
    PARTITION_KEYS,
    VectorStore,
    _sql_predicate,
    partition_filter,
    partition_metadata,
)


PROFILE: dict[str, Any] = {
    "workspaceId": "11111111-1111-1111-1111-111111111111",
    "userId": "22222222-2222-2222-2222-222222222222",
    "connectionOwnerType": "USER",
    "connectionOwnerId": "22222222-2222-2222-2222-222222222222",
    "providerConnectionId": "33333333-3333-3333-3333-333333333333",
    "providerId": "dashscope-qwen",
    "connectionKey": "embedding",
    "connectionRevision": 3,
    "apiTypeId": "dashscope-multimodal-embedding",
    "apiTypeVersion": 1,
    "modelId": SUPPORTED_MODEL,
    "dimension": SUPPORTED_DIMENSION,
    "profileScope": "user",
    "connectionOwnerScope": "user",
    "modelSource": "profile",
}


def vector(dim=SUPPORTED_DIMENSION):
    return [0.01 * (index % 7) for index in range(dim)]


class Recorder:
    def __init__(self):
        self.requests: list[dict[str, Any]] = []

    async def handle(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(
            {
                "path": request.url.path,
                "authorization": request.headers.get("Authorization", ""),
                "body": json.loads(request.content.decode("utf-8")),
            }
        )
        return httpx.Response(
            200,
            json={
                "output": {
                    "embeddings": [
                        {"type": "text", "embedding": vector()}
                        for _ in range(json.loads(request.content.decode("utf-8"))["input"]["contents"].__len__())
                    ]
                },
                "usage": {"total_tokens": 1},
                "request_id": "probe-1",
            },
        )


@pytest.mark.asyncio
async def test_dashscope_wire_body_and_path():
    recorder = Recorder()
    original = httpx.AsyncClient.send

    async def send(self, request, **kwargs):
        return await recorder.handle(request)

    httpx.AsyncClient.send = send
    try:
        adapter = DashScopeEmbeddings(api_key="fixture-only", base_url="https://dashscope.aliyuncs.com/api/v1")
        vectors = await adapter.embed_batch(["a", "b"])
    finally:
        httpx.AsyncClient.send = original
    assert len(vectors) == 2
    assert all(len(item) == SUPPORTED_DIMENSION for item in vectors)
    wire = recorder.requests[0]
    assert wire["path"] == "/api/v1/services/embeddings/multimodal-embedding/multimodal-embedding"
    assert wire["authorization"] == "Bearer fixture-only"
    assert wire["body"]["model"] == SUPPORTED_MODEL
    assert wire["body"]["parameters"] == {"dimension": SUPPORTED_DIMENSION}
    assert wire["body"]["input"]["contents"][0] == {"text": "a"}


@pytest.mark.asyncio
async def test_dashscope_error_mapping():
    adapter = DashScopeEmbeddings(
        api_key="fixture-only", base_url="https://dashscope.aliyuncs.com/api/v1"
    )
    original = httpx.AsyncClient.send

    async def unauthorized(self, request, **kwargs):
        return httpx.Response(401, json={"code": "InvalidApiKey"})

    async def unreachable(self, request, **kwargs):
        raise httpx.ConnectError("boom")

    async def malformed(self, request, **kwargs):
        return httpx.Response(200, json={"output": {"embeddings": []}})

    async def wrong_dimension(self, request, **kwargs):
        return httpx.Response(
            200,
            json={"output": {"embeddings": [{"type": "text", "embedding": vector(1024)}]}},
        )

    cases = [
        (unauthorized, "EMBEDDING_PROVIDER_AUTH_FAILED"),
        (unreachable, "EMBEDDING_PROVIDER_UNREACHABLE"),
        (malformed, "EMBEDDING_RESPONSE_INVALID"),
        (wrong_dimension, "EMBEDDING_DIMENSION_MISMATCH"),
    ]
    for handler, expected in cases:
        httpx.AsyncClient.send = handler
        try:
            with pytest.raises(EmbeddingProviderError) as exc:
                await adapter.embed("probe")
            assert exc.value.code == expected
        finally:
            httpx.AsyncClient.send = original


def test_profile_validation_fail_closed():
    with pytest.raises(EmbeddingProviderError):
        validate_profile({"apiTypeId": "openai-chat-completions"})
    with pytest.raises(EmbeddingProviderError):
        validate_profile({**PROFILE, "modelId": "text-embedding-3-small"})
    with pytest.raises(EmbeddingProviderError):
        validate_profile({**PROFILE, "dimension": 1024})
    without_owner = {key: value for key, value in PROFILE.items() if key != "workspaceId"}
    with pytest.raises(EmbeddingProviderError):
        validate_profile(without_owner)
    validate_profile(PROFILE)


def test_partition_tuple_is_complete():
    fields = partition_fields(PROFILE)
    identity = [key for key in PARTITION_KEYS if key not in ("doc_id", "filename")]
    assert set(fields) == set(identity)
    metadata = partition_metadata(PROFILE, "doc-1", "notes.pdf")
    assert set(metadata) == set(PARTITION_KEYS)
    assert metadata["doc_id"] == "doc-1"
    assert metadata["filename"] == "notes.pdf"
    clause, params = _sql_predicate(partition_filter(PROFILE, doc_id="doc-1"))
    assert clause.count("=") == len(identity) + 1
    assert params["p_0"] == fields["workspace_id"]


class FakeResult:
    def __init__(self, rows=None, scalar=None, rowcount=0):
        self._rows = rows or []
        self._scalar = scalar
        self.rowcount = rowcount

    def scalar(self):
        return self._scalar

    def mappings(self):
        return self

    def __iter__(self):
        return iter(self._rows)


class FakeConnection:
    def __init__(self, statements):
        self.statements = statements

    async def execute(self, stmt, params=None):
        self.statements.append((str(stmt), params))
        text_stmt = str(stmt)
        if "information_schema.columns" in text_stmt:
            rows = [(column.name, "text", "text") for column in PARTITION_COLUMNS]
            rows.append(("embedding", "USER-DEFINED", "vector"))
            return FakeResult(rows=rows)
        if "information_schema.tables" in text_stmt:
            return FakeResult(scalar=1)
        if "COUNT(DISTINCT" in text_stmt:
            return FakeResult(scalar=2)
        if "GROUP BY" in text_stmt:
            return FakeResult(rows=[("doc-1", "a.pdf", 3)])
        return FakeResult(rowcount=1)

    async def commit(self):
        return None

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return False


class FakeEngine:
    def __init__(self):
        self.statements = []

    def connect(self):
        return FakeConnection(self.statements)

    def begin(self):
        return FakeConnection(self.statements)


@pytest.mark.asyncio
async def test_count_and_documents_are_partition_scoped():
    engine = FakeEngine()
    store = VectorStore(dsn="", embedding_service=None, shared_engine=engine)
    total = await store.count(PROFILE)
    documents = await store.documents(PROFILE)
    assert total == 2
    assert documents == [{"id": "doc-1", "filename": "a.pdf", "chunks": 3}]
    count_stmt, count_params = next(
        entry for entry in engine.statements if "COUNT(DISTINCT" in entry[0]
    )
    assert 'COUNT(DISTINCT "doc_id")' in count_stmt
    identity = [key for key in PARTITION_KEYS if key not in ("doc_id", "filename")]
    for key in identity:
        assert f'"{key}" =' in count_stmt
    assert PROFILE["workspaceId"] in count_params.values()


@pytest.mark.asyncio
async def test_delete_requires_full_partition_and_doc():
    engine = FakeEngine()
    store = VectorStore(dsn="", embedding_service=None, shared_engine=engine)
    deleted = await store.delete("doc-9", PROFILE)
    assert deleted is True
    stmt, params = next(entry for entry in engine.statements if entry[0].startswith("DELETE"))
    assert stmt.startswith('DELETE FROM "public"."document_chunks" WHERE')
    identity = [key for key in PARTITION_KEYS if key not in ("doc_id", "filename")]
    assert len(params) == len(identity) + 1


@pytest.mark.asyncio
async def test_add_document_inserts_all_chunks_in_one_transaction(monkeypatch):
    class Embed:
        async def aembed_documents(self, texts):
            return [vector() for _ in texts]

    engine = FakeEngine()
    store = VectorStore(dsn="", embedding_service=Embed(), shared_engine=engine)

    async def skip_schema(_engine):
        return None

    monkeypatch.setattr(store, "_ensure_schema", skip_schema)
    doc_id = await store.add_document(["one", "two", "three"], PROFILE, "notes.pdf")
    assert doc_id
    inserts = [entry for entry in engine.statements if "INSERT INTO" in entry[0]]
    assert len(inserts) == 3
    doc_ids = set()
    for _, params in inserts:
        assert params["workspace_id"] == PROFILE["workspaceId"]
        assert params["doc_id"] == doc_id
        assert params["filename"] == "notes.pdf"
        assert params["dimension"] == SUPPORTED_DIMENSION
        doc_ids.add(params["doc_id"])
    assert doc_ids == {doc_id}

@pytest.mark.asyncio
async def test_add_document_rejects_wrong_vector_length(monkeypatch):
    class Embed:
        async def aembed_documents(self, texts):
            return [vector(1024) for _ in texts]

    store = VectorStore(dsn="", embedding_service=Embed(), shared_engine=FakeEngine())

    async def skip_schema(_engine):
        return None

    monkeypatch.setattr(store, "_ensure_schema", skip_schema)
    from xihe_agent.rag.store import VectorSchemaError

    with pytest.raises(VectorSchemaError):
        await store.add_document(["one"], PROFILE, None)
