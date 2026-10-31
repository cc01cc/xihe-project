"""PLAN-0605 M1 P0 regression: outbound normalization must not swallow content parts.

``llm/base.py`` collapses pure-string content lists (``[""]``) for MiMo compatibility.
Structured blocks (images) must survive untouched, both at the LangChain message layer
(``_normalize_outbound_messages``) and at the already-serialized wire layer
(``_normalize_message_dict``). Without this pin, M2 image parts would be silently
rewritten into text.
"""

from __future__ import annotations

from langchain_core.messages import HumanMessage, SystemMessage

from xihe_agent.llm.base import _normalize_message_dict, _normalize_outbound_messages

IMAGE_PART = {
    "type": "image_url",
    "image_url": {"url": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg=="},
}


def test_content_parts_survive_message_normalization():
    message = HumanMessage(
        content=[
            {"type": "text", "text": "这张图片是什么颜色？"},
            IMAGE_PART,
        ]
    )
    [normalized] = _normalize_outbound_messages([message])
    assert isinstance(normalized.content, list), "image parts must stay a list"
    assert normalized.content[0]["type"] == "text"
    assert normalized.content[1] == IMAGE_PART
    assert normalized.content[1]["image_url"]["url"].startswith("data:image/png;base64,")


def test_pure_string_list_still_collapses():
    message = HumanMessage(content=["a", "b"])
    [normalized] = _normalize_outbound_messages([message])
    assert normalized.content == "ab"


def test_empty_string_list_collapses_to_empty_string():
    [normalized] = _normalize_outbound_messages([HumanMessage(content=[""])])
    assert normalized.content == ""


def test_plain_string_content_untouched():
    message = SystemMessage(content="system prompt")
    [normalized] = _normalize_outbound_messages([message])
    assert normalized.content == "system prompt"


def test_wire_dict_normalization_keeps_content_parts():
    wire = {
        "role": "user",
        "content": [
            {"type": "text", "text": "describe"},
            IMAGE_PART,
        ],
    }
    normalized = _normalize_message_dict(wire)
    assert normalized["content"] == wire["content"]
    assert normalized["content"][1]["image_url"]["url"].startswith("data:image/png;base64,")


def test_wire_dict_normalization_collapses_string_list():
    wire = {"role": "assistant", "content": ["", "done"]}
    assert _normalize_message_dict(wire)["content"] == "done"


def test_data_url_is_never_rewritten_or_truncated():
    url = "data:image/png;base64," + "A" * 512
    part = {"type": "image_url", "image_url": {"url": url}}
    wire = {"role": "user", "content": [part]}
    assert _normalize_message_dict(wire)["content"][0]["image_url"]["url"] == url
