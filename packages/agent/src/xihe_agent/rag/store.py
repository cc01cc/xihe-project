"""PLAN-0485: partitioned pgvector store for RAG chunks.

Round-4 items 5-6:
- Every row carries the complete logical partition tuple
  (workspace_id, connection_owner_type/id, provider_connection_id,
  api_type_id/version, model_id, dimension) plus doc_id/filename.
- One ingest allocates one docId and inserts all chunks in one transaction.
- Search applies the full equality predicate in PostgreSQL before the vector
  ORDER BY / LIMIT (langchain_postgres builds ``WHERE {filter} ORDER BY
  embedding <=> :q LIMIT :k`` for a metadata filter).
- Startup creates only an absent table or validates a compatible schema; an
  incompatible existing table refuses RAG instead of resetting implicitly.
- The fresh-store vector size is fixed at 768 (V1 model contract); the legacy
  1024 default no longer exists.
"""

from typing import Any
from uuid import uuid4

from langchain_postgres import PGEngine, PGVectorStore
from langchain_postgres.v2.engine import Column
from loguru import logger
from sqlalchemy import text
from sqlalchemy.exc import ProgrammingError
from sqlalchemy.ext.asyncio import AsyncEngine, create_async_engine

VECTOR_SIZE = 768
TABLE_NAME = "document_chunks"

PARTITION_COLUMNS: list[Column] = [
    Column(name="workspace_id", data_type="UUID", nullable=False),
    Column(name="connection_owner_type", data_type="TEXT", nullable=False),
    Column(name="connection_owner_id", data_type="TEXT", nullable=False),
    Column(name="provider_connection_id", data_type="UUID", nullable=False),
    Column(name="api_type_id", data_type="TEXT", nullable=False),
    Column(name="api_type_version", data_type="INTEGER", nullable=False),
    Column(name="model_id", data_type="TEXT", nullable=False),
    Column(name="dimension", data_type="INTEGER", nullable=False),
    Column(name="doc_id", data_type="UUID", nullable=False),
    Column(name="filename", data_type="TEXT", nullable=False),
]

PARTITION_KEYS = [column.name for column in PARTITION_COLUMNS]
# The partition predicate covers the identity tuple; doc_id/filename are
# document columns inside the partition, not identity fields.
IDENTITY_KEYS = PARTITION_KEYS[:-2]


class VectorSchemaError(RuntimeError):
    """The existing table cannot serve the current contract; RAG refuses."""

    def __init__(self, detail: str):
        super().__init__(detail)
        self.code = "EMBEDDING_PROFILE_CONFLICT"


def partition_filter(profile: dict[str, Any], doc_id: str | None = None) -> dict[str, Any]:
    """Equality predicate for the whole partition tuple (optionally one doc).

    langchain_postgres metadata filters map ``$eq`` to a parameterized equality
    clause that lands inside the WHERE built before ORDER BY / LIMIT.
    """
    from xihe_agent.rag.dashscope import partition_fields

    fields = partition_fields(profile)
    predicate: dict[str, Any] = {
        key: {"$eq": fields[key]}
        for key in PARTITION_KEYS
        if key not in ("doc_id", "filename")
    }
    if doc_id is not None:
        predicate["doc_id"] = {"$eq": doc_id}
    return predicate


def partition_metadata(profile: dict[str, Any], doc_id: str, filename: str | None) -> dict[str, Any]:
    """Row metadata for one chunk of a document inside this partition."""
    from xihe_agent.rag.dashscope import partition_fields

    fields = partition_fields(profile)
    metadata = dict(fields)
    metadata["doc_id"] = doc_id
    metadata["filename"] = filename or ""
    return metadata


class VectorStore:
    """Request-scoped pgvector store; only the DB engine/pool may be shared."""

    def __init__(self, dsn: str, embedding_service, shared_engine: AsyncEngine | None = None):
        self._dsn = dsn
        self._shared_engine = shared_engine
        self._owned_engine: AsyncEngine | None = None
        self._engine: PGEngine | None = None
        self._store: PGVectorStore | None = None
        self._embedding = embedding_service

    async def _ensure_engine(self) -> AsyncEngine:
        if self._shared_engine is not None:
            return self._shared_engine
        if self._owned_engine is None:
            self._owned_engine = create_async_engine(self._dsn)
        return self._owned_engine

    async def close(self) -> None:
        if self._owned_engine is not None:
            await self._owned_engine.dispose()
            self._owned_engine = None
        self._engine = None
        self._store = None

    async def _ensure_store(self) -> PGVectorStore:
        if self._store is None:
            engine = await self._ensure_engine()
            if self._engine is None:
                self._engine = PGEngine.from_engine(engine)
            await self._ensure_schema(engine)
            self._store = await PGVectorStore.create(
                engine=self._engine,
                embedding_service=self._embedding,
                table_name=TABLE_NAME,
                metadata_columns=[column.name for column in PARTITION_COLUMNS],
            )
        return self._store

    async def _ensure_schema(self, engine: AsyncEngine) -> None:
        """Create the 768 partitioned table when absent; validate when present."""
        if self._engine is None:
            self._engine = PGEngine.from_engine(engine)
        async with engine.connect() as conn:
            exists = (
                await conn.execute(
                    text(
                        "SELECT 1 FROM information_schema.tables "
                        "WHERE table_schema = 'public' AND table_name = :table"
                    ),
                    {"table": TABLE_NAME},
                )
            ).scalar()
        if exists:
            await self._validate_schema(engine)
            return
        try:
            create_engine = self._engine
            if create_engine is None:
                raise RuntimeError("VectorStore PGEngine was not initialized")
            await create_engine.ainit_vectorstore_table(
                TABLE_NAME,
                vector_size=VECTOR_SIZE,
                metadata_columns=list(PARTITION_COLUMNS),
                metadata_json_column="langchain_metadata",
                overwrite_existing=False,
            )
            async with engine.begin() as conn:
                await conn.execute(
                    text(
                        'CREATE INDEX IF NOT EXISTS "document_chunks_partition_idx" ON '
                        '"public"."document_chunks" '
                        '("workspace_id", "connection_owner_type", "connection_owner_id", '
                        '"provider_connection_id", "api_type_id", "api_type_version", '
                        '"model_id", "dimension", "doc_id")'
                    )
                )
        except ProgrammingError:
            logger.debug("Table document_chunks already exists")

    async def _validate_schema(self, engine: AsyncEngine) -> None:
        """Refuse incompatible legacy tables instead of resetting implicitly."""
        async with engine.connect() as conn:
            result = await conn.execute(
                text(
                    "SELECT column_name, data_type, udt_name FROM information_schema.columns "
                    "WHERE table_schema = 'public' AND table_name = :table"
                ),
                {"table": TABLE_NAME},
            )
            # pgvector columns report data_type=USER-DEFINED with udt_name=vector.
            columns = {row[0]: (row[1], row[2]) for row in result}
        missing = [name for name, _ in [(c.name, c.data_type) for c in PARTITION_COLUMNS] if name not in columns]
        if missing:
            raise VectorSchemaError(
                "document_chunks is missing partition columns: " + ", ".join(sorted(missing))
            )
        embedding_type = columns.get("embedding")
        if embedding_type is None or "vector" not in str(embedding_type):
            raise VectorSchemaError("document_chunks.embedding is not a pgvector column")

    async def add_document(
        self,
        chunks: list[str],
        profile: dict[str, Any],
        filename: str | None,
    ) -> str:
        """Embed every chunk, then insert all rows in one transaction (item 6).

        langchain_postgres ``aadd_embeddings`` commits per row, so the insert
        path is implemented here to keep one ingest atomic: a provider or
        database failure halfway through leaves no document fragments.
        """
        if not chunks:
            raise ValueError("Cannot ingest an empty document")
        from xihe_agent.rag.dashscope import SUPPORTED_DIMENSION

        doc_id = str(uuid4())
        metadata = partition_metadata(profile, doc_id, filename)
        vectors = await self._embedding.aembed_documents(list(chunks))
        for vector in vectors:
            if len(vector) != SUPPORTED_DIMENSION:
                raise VectorSchemaError(
                    f"Provider returned a {len(vector)}-dimension vector; expected {SUPPORTED_DIMENSION}"
                )
        engine = await self._ensure_engine()
        await self._ensure_schema(engine)
        columns = ['"langchain_id"', '"content"', '"embedding"'] + [
            f'"{name}"' for name in PARTITION_KEYS
        ]
        placeholders = [":chunk_id", ":content", ":embedding"] + [
            f":{name}" for name in PARTITION_KEYS
        ]
        insert_sql = (
            f'INSERT INTO "public"."{TABLE_NAME}" ({", ".join(columns)}) '
            f'VALUES ({", ".join(placeholders)})'
        )
        async with engine.begin() as conn:
            for chunk_text, vector in zip(chunks, vectors):
                params: dict[str, Any] = {
                    "chunk_id": str(uuid4()),
                    "content": chunk_text,
                    "embedding": f"[{', '.join(repr(float(value)) for value in vector)}]",
                }
                params.update(metadata)
                await conn.execute(text(insert_sql), params)
        return doc_id

    async def search(
        self,
        query_embedding: list[float],
        profile: dict[str, Any],
        top_k: int = 5,
        min_score: float = 0.0,
    ) -> list[dict[str, Any]]:
        store = await self._ensure_store()
        results = await store.asimilarity_search_with_score_by_vector(
            query_embedding,
            k=top_k,
            filter=partition_filter(profile),
        )
        output = []
        for document, score in results:
            if score < min_score:
                continue
            output.append(
                {
                    "id": str(document.id),
                    "docId": document.metadata.get("doc_id"),
                    "filename": document.metadata.get("filename"),
                    "text": document.page_content,
                    "metadata": {
                        key: value
                        for key, value in document.metadata.items()
                        if key not in PARTITION_KEYS
                    },
                    "score": round(float(score), 4),
                }
            )
        return output

    async def _table_exists(self, engine: AsyncEngine) -> bool:
        async with engine.connect() as conn:
            return bool(
                (
                    await conn.execute(
                        text(
                            "SELECT 1 FROM information_schema.tables "
                            "WHERE table_schema = 'public' AND table_name = :table"
                        ),
                        {"table": TABLE_NAME},
                    )
                ).scalar()
            )

    async def count(self, profile: dict[str, Any]) -> int:
        """Count documents (not chunks) inside one partition; empty if absent."""
        engine = await self._ensure_engine()
        if not await self._table_exists(engine):
            return 0
        predicate = partition_filter(profile)
        clause, params = _sql_predicate(predicate)
        async with engine.connect() as conn:
            result = await conn.execute(
                text(
                    f'SELECT COUNT(DISTINCT "doc_id") FROM "public"."{TABLE_NAME}" WHERE {clause}'
                ),
                params,
            )
            value = result.scalar()
            return int(value) if value is not None else 0

    async def documents(self, profile: dict[str, Any]) -> list[dict[str, Any]]:
        engine = await self._ensure_engine()
        if not await self._table_exists(engine):
            return []
        predicate = partition_filter(profile)
        clause, params = _sql_predicate(predicate)
        async with engine.connect() as conn:
            result = await conn.execute(
                text(
                    f'SELECT "doc_id", MAX("filename") AS filename, COUNT(*) AS chunks '
                    f'FROM "public"."{TABLE_NAME}" WHERE {clause} '
                    f'GROUP BY "doc_id" ORDER BY "doc_id"'
                ),
                params,
            )
            return [
                {"id": str(row[0]), "filename": row[1], "chunks": int(row[2])}
                for row in result
            ]

    async def delete(self, doc_id: str, profile: dict[str, Any]) -> bool:
        engine = await self._ensure_engine()
        if not await self._table_exists(engine):
            return False
        predicate = partition_filter(profile, doc_id=doc_id)
        clause, params = _sql_predicate(predicate)
        async with engine.begin() as conn:
            result = await conn.execute(
                text(f'DELETE FROM "public"."{TABLE_NAME}" WHERE {clause}'),
                params,
            )
            return result.rowcount > 0

    async def clear(self, profile: dict[str, Any]) -> None:
        """Test-only full-partition clear; requires an isolated disposable DB."""
        engine = await self._ensure_engine()
        predicate = partition_filter(profile)
        clause, params = _sql_predicate(predicate)
        async with engine.begin() as conn:
            await conn.execute(
                text(f'DELETE FROM "public"."{TABLE_NAME}" WHERE {clause}'),
                params,
            )


def _sql_predicate(predicate: dict[str, Any]) -> tuple[str, dict[str, Any]]:
    """Parameterized SQL for the partition equality predicate."""
    clauses: list[str] = []
    params: dict[str, Any] = {}
    for index, (key, condition) in enumerate(predicate.items()):
        value = condition["$eq"] if isinstance(condition, dict) else condition
        placeholder = f"p_{index}"
        clauses.append(f'"{key}" = :{placeholder}')
        params[placeholder] = value
    return " AND ".join(clauses), params
