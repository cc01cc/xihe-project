
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
