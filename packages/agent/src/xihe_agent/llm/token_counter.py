"""Token counting for context management (PLAN-294 decisions #5/#11/#12).

Two channels with distinct roles:
  - local estimation (this module) decides whether to compact BEFORE a call;
  - provider-reported usage (llm_usage events) is the calibration truth and
    updates after every call.

Tokenizer resolution: `tokenizerRef` from llm-provider config contextPolicy
names a HF tokenizer (e.g. "Qwen2Tokenizer" family via litellm's
create_pretrained_tokenizer). Models without a ref fall back to litellm's
per-model tokenizer, then to a conservative o200k estimate. All estimates are
directionally safe for compaction triggering (overestimation only compresses
earlier); provider truth recalibrates via usage events.
"""

from typing import Any

from loguru import logger

import litellm

_O200K = None


def _o200k_encoding():
    global _O200K
    if _O200K is None:
        import tiktoken

        _O200K = tiktoken.get_encoding("o200k_base")
    return _O200K


class TokenCounter:
    """Estimates token counts for the model bound to this counter."""

    def __init__(self, tokenizer_ref: str | None = None, model: str | None = None):
        self._tokenizer = None
        self._resolved = False
        self._tokenizer_ref = tokenizer_ref
        self._model = model

    def _ensure_tokenizer(self) -> None:
        if self._resolved:
            return
        self._resolved = True
        if self._tokenizer_ref:
            try:
                self._tokenizer = litellm.create_pretrained_tokenizer(self._tokenizer_ref)
                logger.info("TokenCounter using pretrained tokenizer ref={}", self._tokenizer_ref)
                return
            except Exception as e:
                logger.warning(
                    "TokenizerRef {} unavailable ({}); falling back to litellm tokenizer",
                    self._tokenizer_ref,
                    e,
                )

    def estimate_text(self, text: str) -> int:
        self._ensure_tokenizer()
        try:
            if self._tokenizer is not None:
                return litellm.token_counter(
                    model=self._model, text=text, custom_tokenizer=self._tokenizer
                )
            return litellm.token_counter(model=self._model, text=text)
        except Exception as e:
            logger.debug("token_counter failed ({}); o200k estimate", e)
            return len(_O200K().encode(text))

    def estimate_messages(self, messages: list[dict[str, Any]]) -> int:
        """Estimate the provider-visible payload size for a message array."""
        self._ensure_tokenizer()
        try:
            if self._tokenizer is not None:
                return litellm.token_counter(
                    model=self._model, messages=messages, custom_tokenizer=self._tokenizer
                )
            return litellm.token_counter(model=self._model, messages=messages)
        except Exception as e:
            logger.debug("messages token_counter failed ({}); char/4 estimate", e)
            total = 0
            for m in messages:
                content = m.get("content")
                if isinstance(content, str):
                    total += len(content) // 4
            return total
