from uuid import uuid4

from langchain_core.documents import Document
from langchain_postgres import PGEngine, PGVectorStore
from loguru import logger
from sqlalchemy import text
from sqlalchemy.exc import ProgrammingError
from sqlalchemy.ext.asyncio import AsyncEngine, create_async_engine

DEFAULT_VECTOR_SIZE = 1024


class VectorStore:
    def __init__(self, dsn: str, embedding_service, vector_size: int | None = None):
        self._dsn = dsn
        self._vector_size = vector_size or DEFAULT_VECTOR_SIZE
        self._async_engine: AsyncEngine | None = None
        self._engine: PGEngine | None = None
        self._store: PGVectorStore | None = None
        self._embedding = embedding_service

    async def _ensure_store(self) -> PGVectorStore:
        if self._store is None:
            if self._async_engine is None:
                self._async_engine = create_async_engine(self._dsn)
                self._engine = PGEngine.from_engine(self._async_engine)
            if self._engine is None:
                raise RuntimeError("VectorStore PGEngine was not initialized")
            try:
                await self._engine.ainit_vectorstore_table(
                    "document_chunks",
                    vector_size=DEFAULT_VECTOR_SIZE,
                    overwrite_existing=False,
                )
            except ProgrammingError:
                logger.debug("Table document_chunks already exists")
            self._store = await PGVectorStore.create(
                engine=self._engine,
                embedding_service=self._embedding,
                table_name="document_chunks",
            )
        store = self._store
        if store is None:
            raise RuntimeError("VectorStore PGVectorStore was not initialized")
        return store

    async def _ensure_engine(self) -> AsyncEngine:
        await self._ensure_store()
        engine = self._async_engine
        if engine is None:
            raise RuntimeError("VectorStore engine was not initialized")
        return engine

    async def add(self, text: str, metadata: dict | None = None) -> str:
        store = await self._ensure_store()
        doc_id = str(uuid4())
        doc = Document(id=doc_id, page_content=text, metadata=metadata or {})
        await store.aadd_documents([doc], ids=[doc_id])
        return doc_id

    async def search(self, query_embedding: list[float], top_k: int = 5, min_score: float = 0.0):
        store = await self._ensure_store()
        results = await store.asimilarity_search_with_score_by_vector(query_embedding, k=top_k)
        return [
            {"id": doc.id, "text": doc.page_content, "metadata": doc.metadata, "score": round(score, 4)}
            for doc, score in results
            if score >= min_score
        ]

    async def delete(self, doc_id: str) -> bool:
        store = await self._ensure_store()
        await store.adelete([doc_id])
        return True

    async def count(self) -> int:
        engine = await self._ensure_engine()
        async with engine.connect() as conn:
            result = await conn.execute(text("SELECT COUNT(*) FROM document_chunks"))
            value = result.scalar()
            return int(value) if value is not None else 0

    async def clear(self) -> None:
        engine = await self._ensure_engine()
        async with engine.connect() as conn:
            await conn.execute(text("DELETE FROM document_chunks"))
            await conn.commit()
