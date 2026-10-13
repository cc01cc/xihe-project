"""PLAN-0485: DashScope Multimodal-Embedding request-scoped adapter.

V1 is pinned to ``tongyi-embedding-vision-flash-2026-03-06`` at dimension 768
via the dedicated Multimodal-Embedding endpoint. This is a native HTTP sender,
not the LiteLLM OpenAI-compatible ``aembedding`` path (spec §Operation Type).
The API key lives only inside a request-scoped instance built from a redeemed
credential grant; nothing here is cached on the process.
"""

from typing import Any

import httpx
from langchain_core.embeddings import Embeddings
from loguru import logger

SUPPORTED_MODEL = "tongyi-embedding-vision-flash-2026-03-06"
SUPPORTED_DIMENSION = 768
EMBEDDING_API_TYPE_ID = "dashscope-multimodal-embedding"
EMBEDDING_API_TYPE_VERSION = 1


class EmbeddingProviderError(RuntimeError):
    """Stable embedding provider failure categories; never carries raw payload."""

    def __init__(self, code: str, status: int):
        super().__init__(code)
        self.code = code
        self.status = status


def validate_profile(profile: dict[str, Any]) -> None:
    """Fail closed on any profile/model/dimension outside the V1 contract."""
    if not isinstance(profile, dict):
        raise EmbeddingProviderError("EMBEDDING_PROFILE_CONFLICT", 409)
    if profile.get("apiTypeId") != EMBEDDING_API_TYPE_ID:
        raise EmbeddingProviderError("API_TYPE_OPERATION_MISMATCH", 400)
    if profile.get("apiTypeVersion") != EMBEDDING_API_TYPE_VERSION:
        raise EmbeddingProviderError("API_TYPE_OPERATION_MISMATCH", 400)
    if profile.get("modelId") != SUPPORTED_MODEL:
        raise EmbeddingProviderError("EMBEDDING_MODEL_UNSUPPORTED", 400)
    if profile.get("dimension") != SUPPORTED_DIMENSION:
        raise EmbeddingProviderError("EMBEDDING_DIMENSION_MISMATCH", 502)
    connection_id = profile.get("providerConnectionId")
    owner_type = profile.get("connectionOwnerType")
    owner_id = profile.get("connectionOwnerId")
    workspace_id = profile.get("workspaceId")
    if not connection_id or not owner_type or not owner_id or not workspace_id:
        raise EmbeddingProviderError("EMBEDDING_PROFILE_CONFLICT", 409)


def partition_fields(profile: dict[str, Any]) -> dict[str, Any]:
    """The complete logical partition tuple persisted with every row."""
    validate_profile(profile)
    return {
        "workspace_id": profile.get("workspaceId"),
        "connection_owner_type": profile.get("connectionOwnerType"),
        "connection_owner_id": profile.get("connectionOwnerId"),
        "provider_connection_id": profile.get("providerConnectionId"),
        "api_type_id": profile.get("apiTypeId"),
        "api_type_version": profile.get("apiTypeVersion"),
        "model_id": profile.get("modelId"),
        "dimension": profile.get("dimension"),
    }


class DashScopeEmbeddings(Embeddings):
    """Request-scoped Multimodal-Embedding sender + LangChain adapter.

    Extends the LangChain ``Embeddings`` interface so pgvector can consume it;
    the network sender is a native httpx call to the Multimodal-Embedding
    endpoint, not the OpenAI-compatible path.
    """

    def __init__(self, api_key: str, base_url: str, model_id: str = SUPPORTED_MODEL):
        if base_url is None or not str(base_url).startswith("https://"):
            raise EmbeddingProviderError("EMBEDDING_PROFILE_CONFLICT", 409)
        self._api_key = api_key
        self._base_url = str(base_url).rstrip("/")
        self.model = model_id
        self.dimension = SUPPORTED_DIMENSION

    async def embed(self, text: str) -> list[float]:
        vectors = await self.embed_batch([text])
        return vectors[0]

    async def embed_batch(self, texts: list[str]) -> list[list[float]]:
        if self._api_key is None:
            raise EmbeddingProviderError("EMBEDDING_PROVIDER_AUTH_FAILED", 502)
        body = {
            "model": self.model,
            "input": {"contents": [{"text": text} for text in texts]},
            "parameters": {"dimension": SUPPORTED_DIMENSION},
        }
        # The connection baseUrl is host-pinned with the required /api/v1
        # suffix (catalog V4), so the endpoint appends only the service path.
        url = f"{self._base_url}/services/embeddings/multimodal-embedding/multimodal-embedding"
        try:
            async with httpx.AsyncClient(timeout=30.0) as client:
                response = await client.post(
                    url,
                    json=body,
                    headers={"Authorization": f"Bearer {self._api_key}"},
                )
        except httpx.HTTPError:
            logger.warning("DashScope embedding transport failure")
            raise EmbeddingProviderError("EMBEDDING_PROVIDER_UNREACHABLE", 502)
        if response.status_code in (401, 403):
            raise EmbeddingProviderError("EMBEDDING_PROVIDER_AUTH_FAILED", 502)
        if response.status_code != 200:
            raise EmbeddingProviderError("EMBEDDING_PROVIDER_UNREACHABLE", 502)
        try:
            payload = response.json()
        except ValueError:
            raise EmbeddingProviderError("EMBEDDING_RESPONSE_INVALID", 502)
        return _parse_embeddings(payload, len(texts))

    # LangChain Embeddings interface (pgvector consumes these)
    def embed_documents(self, texts: list[str]) -> list[list[float]]:
        raise NotImplementedError("Use aembed_documents() in async context")

    def embed_query(self, text: str) -> list[float]:
        raise NotImplementedError("Use aembed_query() in async context")

    async def aembed_documents(self, texts: list[str]) -> list[list[float]]:
        return await self.embed_batch(texts)

    async def aembed_query(self, text: str) -> list[float]:
        return await self.embed(text)


def _parse_embeddings(payload: dict[str, Any], expected: int) -> list[list[float]]:
    output = payload.get("output") if isinstance(payload, dict) else None
    embeddings = output.get("embeddings") if isinstance(output, dict) else None
    if not isinstance(embeddings, list) or len(embeddings) != expected:
        raise EmbeddingProviderError("EMBEDDING_RESPONSE_INVALID", 502)
    vectors: list[list[float]] = []
    for item in embeddings:
        if not isinstance(item, dict) or item.get("type") != "text":
            raise EmbeddingProviderError("EMBEDDING_RESPONSE_INVALID", 502)
        vector = item.get("embedding")
        if not isinstance(vector, list) or len(vector) != SUPPORTED_DIMENSION:
            raise EmbeddingProviderError("EMBEDDING_DIMENSION_MISMATCH", 502)
        if not all(isinstance(value, (int, float)) and value == value for value in vector):
            raise EmbeddingProviderError("EMBEDDING_RESPONSE_INVALID", 502)
        vectors.append([float(value) for value in vector])
    return vectors

