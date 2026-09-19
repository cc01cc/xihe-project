"""PLAN-0354 spec §8: LLM semantic summarization for CP compaction.

The Agent is the only LLM holder (PLAN-0341 boundary), so the CP summary hop
lands here: build a sectioned-summary prompt, call the model once, and return
the text plus 0343-shaped usage. No events, no persistence, no approval/SC data
(main.py owns the route and credential lease redemption).
"""

from __future__ import annotations

from typing import Any

from langchain_core.messages import HumanMessage, SystemMessage
from loguru import logger

from xihe_agent.llm.token_counter import TokenCounter

# PLAN-0354 spec §8: the six content sections. [Constraints] is deliberately
# absent — CP appends it from the rule-based extractor after the call (I3).
SUMMARIZE_SECTIONS = (
    "[Goal]",
    "[Work State]",
    "[Next Move]",
    "[Files&Artifacts]",
    "[Errors]",
    "[Recent]",
)

SUMMARIZE_SYSTEM_PROMPT = (
    "You compress an agent conversation into a compact, structured summary that "
    "is fed back as long-term memory. Output ONLY the following sections, in "
    "this order, each starting on its own line with the exact header:\n"
    "[Goal] one or two sentences on the user's current objective\n"
    "[Work State] Active: ... ; Completed: ...\n"
    "[Next Move] the single most useful next action\n"
    "[Files&Artifacts] comma-separated workspace-relative file paths, verbatim\n"
    "[Errors] concrete failures/errors still relevant, otherwise omit the section\n"
    "[Recent] brief semantic notes on the last turns (conflicts resolved in favor of newer facts)\n"
    "Rules: never output a [Constraints] section (handled elsewhere); never "
    "invent facts; keep file paths, commands and numbers verbatim; total under "
    "1200 words."
)

_token_counter = TokenCounter()


def build_summarize_messages(text: str, prior_summary: str | None) -> list[Any]:
    """System instruction + prior summary + new conversation excerpt."""
    parts: list[str] = []
    if prior_summary and prior_summary.strip():
        parts.append("Prior summary (carry forward what is still true):\n" + prior_summary.strip())
    parts.append("Conversation excerpt to compact:\n" + (text or "").strip())
    return [SystemMessage(content=SUMMARIZE_SYSTEM_PROMPT), HumanMessage(content="\n\n".join(parts))]


def _content_text(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        blocks = []
        for block in content:
            if isinstance(block, str):
                blocks.append(block)
            elif isinstance(block, dict) and block.get("type") in (None, "text"):
                blocks.append(str(block.get("text", "")))
        return "".join(blocks)
    return str(content or "")


def extract_usage(result: Any, prompt_text: str) -> dict[str, Any]:
    """0343-named usage: provider metadata (real) else local estimate."""
    meta = getattr(result, "usage_metadata", None)
    estimated = _token_counter.estimate_text(prompt_text or "")
    if isinstance(meta, dict) and (meta.get("input_tokens") or meta.get("output_tokens")):
        input_tokens = int(meta.get("input_tokens", 0))
        output_tokens = int(meta.get("output_tokens", 0))
        total = int(meta.get("total_tokens", 0) or (input_tokens + output_tokens))
        return {
            "inputTokens": input_tokens,
            "outputTokens": output_tokens,
            "totalTokens": total,
            "estimatedInputTokens": estimated,
            "source": "real",
        }
    if estimated > 0:
        return {
            "inputTokens": estimated,
            "outputTokens": 0,
            "totalTokens": estimated,
            "estimatedInputTokens": estimated,
            "source": "estimated",
        }
    return {
        "inputTokens": 0,
        "outputTokens": 0,
        "totalTokens": 0,
        "estimatedInputTokens": 0,
        "source": "fallback",
    }


async def summarize_with_llm(llm: Any, text: str, prior_summary: str | None) -> tuple[str, dict[str, Any]]:
    """One bounded LLM call; returns (sectioned summary, usage)."""
    messages = build_summarize_messages(text, prior_summary)
    prompt_text = "\n".join(str(getattr(m, "content", "")) for m in messages)
    result = await llm.ainvoke(messages)
    summary = _content_text(getattr(result, "content", "")).strip()
    usage = extract_usage(result, prompt_text)
    logger.info(
        "[LIFECYCLE] service=agent event=summarize_llm_completed summaryChars={} inputTokens={} outputTokens={} source={}",
        len(summary),
        usage.get("inputTokens"),
        usage.get("outputTokens"),
        usage.get("source"),
    )
    return summary, usage
