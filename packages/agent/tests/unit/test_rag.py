
from unittest.mock import AsyncMock, MagicMock

import pytest

from xihe_agent import main
from xihe_agent.rag.chunking import chunk_document, split_into_paragraphs


class TestChunking:
    def test_chunk_small_document(self):
        chunks = chunk_document("hello world", chunk_size=100, chunk_overlap=0)
        assert len(chunks) == 1
        assert chunks[0]["text"] == "hello world"

    def test_chunk_large_document(self):
        text = " ".join(["word"] * 500)
        chunks = chunk_document(text, chunk_size=100, chunk_overlap=20)
        assert len(chunks) > 1
        for c in chunks:
            assert len(c["text"]) <= 100

    def test_chunk_with_metadata(self):
        chunks = chunk_document("test", metadata={"source": "test.txt"})
        assert chunks[0]["metadata"]["source"] == "test.txt"
        assert chunks[0]["metadata"]["chunk_index"] == 0

    def test_split_paragraphs(self):
        result = split_into_paragraphs("a\n\nb\n\nc")
        assert result == ["a", "b", "c"]


@pytest.mark.asyncio
async def test_rag_enrichment_skips_unconfigured_embedding(monkeypatch):
    embedding_service = MagicMock()
    embedding_service.embed = AsyncMock()
    monkeypatch.setattr(main, "embedding_enabled", False)
    monkeypatch.setattr(main, "embedding_service", embedding_service)

    result = await main._enrich_with_rag_context("question", "instructions")

    assert result == "instructions"
    embedding_service.embed.assert_not_awaited()


class TestRagConfigDefaults:
    def test_defaults_come_from_rag_domain(self, monkeypatch):
        values = {
            ("rag", "chunkSize"): "2048",
            ("rag", "chunkOverlap"): "256",
            ("rag", "topK"): "9",
            ("rag", "minScore"): "0.42",
        }
        monkeypatch.setattr(
            main.config_client, "get", lambda domain, key: values.get((domain, key))
        )

        assert main._rag_config_defaults() == {
            "chunkSize": 2048,
            "chunkOverlap": 256,
            "topK": 9,
            "minScore": 0.42,
        }

    def test_defaults_fall_back_when_unset(self, monkeypatch):
        monkeypatch.setattr(main.config_client, "get", lambda domain, key: None)

        assert main._rag_config_defaults() == {
            "chunkSize": 1000,
            "chunkOverlap": 200,
            "topK": 5,
            "minScore": 0.0,
        }
