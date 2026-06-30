import pytest

from xihe_agent.rag.embeddings import EmbeddingService, LiteLLMEmbeddings


class TestLiteLLMEmbeddings:
    def test_sync_embed_documents_raises_not_implemented(self):
        service = EmbeddingService(model="mock")
        adapter = LiteLLMEmbeddings(service)
        with pytest.raises(NotImplementedError):
            adapter.embed_documents(["test"])

    def test_sync_embed_query_raises_not_implemented(self):
        service = EmbeddingService(model="mock")
        adapter = LiteLLMEmbeddings(service)
        with pytest.raises(NotImplementedError):
            adapter.embed_query("test")


class TestEmbeddingService:
    def test_constructor_defaults_to_env_model(self):
        service = EmbeddingService()
        assert service.model is not None
        assert service.api_key is None

    def test_constructor_accepts_explicit_params(self):
        service = EmbeddingService(model="test-model", api_key="sk-test", api_base="https://test.ai/v1")
        assert service.model == "test-model"
        assert service.api_key == "sk-test"
        assert service.api_base == "https://test.ai/v1"

    @pytest.mark.asyncio
    async def test_embed_raises_on_failure(self):
        service = EmbeddingService(model="nonexistent-model", api_key="bad-key")
        with pytest.raises(Exception):
            await service.embed("test")
