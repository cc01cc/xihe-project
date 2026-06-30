import re
from typing import Any


def chunk_document(
    text: str,
    chunk_size: int = 1000,
    chunk_overlap: int = 200,
    metadata: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    if chunk_overlap >= chunk_size:
        chunk_overlap = chunk_size // 2

    step = chunk_size - chunk_overlap
    chunks: list[dict[str, Any]] = []

    for i in range(0, max(len(text), 1), step):
        end = min(i + chunk_size, len(text))
        chunk_text = text[i:end]

        if not chunk_text.strip():
            continue

        chunks.append({
            "text": chunk_text,
            "metadata": {
                "chunk_index": len(chunks),
                "start_char": i,
                "end_char": end,
                **(metadata or {}),
            },
        })

        if end >= len(text):
            break

    return chunks


def split_into_paragraphs(text: str) -> list[str]:
    paragraphs = re.split(r"\n\s*\n", text)
    return [p.strip() for p in paragraphs if p.strip()]
