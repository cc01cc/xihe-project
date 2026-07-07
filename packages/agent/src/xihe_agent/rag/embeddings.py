import os
from typing import Any

from langchain_core.embeddings import Embeddings
from litellm import aembedding
from loguru import logger


def _default_model() -> str:
    return os.getenv("XIHE_EMBEDDING_MODEL", "text-embedding-3-small")


class EmbeddingService:
    def __init__(
        self,
        model: str | None = None,
        api_base: str | None = None,
        api_key: str | None = None,
    ):
        self.model = model or _default_model()
        self.api_base = api_base
        self.api_key = api_key

    async def embed(self, text: str) -> list[float]:
        kwargs: dict[str, Any] = {
            "model": self.model,
            "input": [text],
        }
        if self.api_base:
            kwargs["api_base"] = self.api_base
        if self.api_key:
            kwargs["api_key"] = self.api_key

        try:
            response = await aembedding(**kwargs)
            return response.data[0]["embedding"]
        except Exception as e:
            logger.error("Embedding failed: model=%s, error=%s", self.model, e, exc_info=True)
            raise

    async def embed_batch(self, texts: list[str]) -> list[list[float]]:
        kwargs: dict[str, Any] = {
            "model": self.model,
            "input": texts,
        }
        if self.api_base:
            kwargs["api_base"] = self.api_base
        if self.api_key:
            kwargs["api_key"] = self.api_key

        try:
            response = await aembedding(**kwargs)
            return [d["embedding"] for d in response.data]
        except Exception as e:
            logger.error("Embedding batch failed: model=%s, len=%d, error=%s", self.model, len(texts), e, exc_info=True)
            raise


class LiteLLMEmbeddings(Embeddings):
    """LangChain ``Embeddings`` adapter wrapping ``EmbeddingService``.

    The core embedding implementation is ``EmbeddingService``, which has no
    LangChain dependency. This class only exists so ``langchain_postgres.PGVectorStore``
    can consume it through the LangChain ``Embeddings`` interface.
    """

    def __init__(self, service: EmbeddingService):
        self._service = service

    def embed_documents(self, texts: list[str]) -> list[list[float]]:
        raise NotImplementedError("Use aembed_documents() in async context")

    def embed_query(self, text: str) -> list[float]:
        raise NotImplementedError("Use aembed_query() in async context")

    async def aembed_documents(self, texts: list[str]) -> list[list[float]]:
        return await self._service.embed_batch(texts)

    async def aembed_query(self, text: str) -> list[float]:
        return await self._service.embed(text)
