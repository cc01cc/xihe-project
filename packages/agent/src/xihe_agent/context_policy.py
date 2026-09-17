"""PLAN-0341 T1.6: resolve context-policy effective values for the Agent.

Entries in the `context-policy` domain are nested JSON text under
`defaults` / `models` (ConfigService storage contract). Resolution priority:
models.<model>.<key> → defaults.<key> → code fallback. Failures log a warn
and fall back — never block the run.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any

from loguru import logger

DEFAULT_MAX_INPUT_TOKENS = 128_000
DEFAULT_PRUNE_WINDOW_CHARS = 80_000
DEFAULT_RECOVERY_BAND = 0.8


@dataclass(frozen=True)
class ResolvedContextPolicy:
    max_input_tokens: int | None
    prune_window_chars: int
    recovery_band: float
    tokenizer_ref: str | None
    source: str  # config | default


def _parse_json_object(raw: str | None) -> dict[str, Any]:
    if not raw:
        return {}
    try:
        parsed = json.loads(raw)
        return parsed if isinstance(parsed, dict) else {}
    except Exception as e:
        logger.warning("context-policy entry is not valid JSON: {}", e)
        return {}


def resolve_context_policy(
    model: str | None,
    domain_entries: dict[str, str],
) -> ResolvedContextPolicy:
    """Resolve prune/window values from effective context-policy entries."""
    defaults = _parse_json_object(domain_entries.get("defaults"))
    models = _parse_json_object(domain_entries.get("models"))
    model_cfg: dict[str, Any] = {}
    if model:
        raw_model = models.get(model)
        if isinstance(raw_model, dict):
            model_cfg = raw_model

    def pick(key: str) -> Any:
        if key in model_cfg and model_cfg[key] is not None:
            return model_cfg[key]
        return defaults.get(key)

    max_input = pick("maxInputTokens")
    prune_window = pick("pruneWindowChars")
    recovery_band = pick("recoveryBand")
    tokenizer_ref = pick("tokenizerRef")

    resolved_max: int | None = None
    source = "default"
    if isinstance(max_input, (int, float)) and int(max_input) >= 8192:
        resolved_max = int(max_input)
        source = "config"

    resolved_prune = DEFAULT_PRUNE_WINDOW_CHARS
    if isinstance(prune_window, (int, float)) and int(prune_window) >= 2000:
        resolved_prune = int(prune_window)
        source = "config"

    resolved_band = DEFAULT_RECOVERY_BAND
    if isinstance(recovery_band, (int, float)) and 0.5 <= float(recovery_band) <= 0.95:
        resolved_band = float(recovery_band)
        source = "config"

    resolved_tokenizer: str | None = None
    if isinstance(tokenizer_ref, str) and tokenizer_ref.strip():
        # PLAN-0341 Q5: only trusted namespaces / offline refs.
        ref = tokenizer_ref.strip()
        if _is_trusted_tokenizer_ref(ref):
            resolved_tokenizer = ref
            source = "config"
        else:
            logger.warning(
                "tokenizerRef rejected (untrusted namespace) ref={} falling back to estimation",
                ref,
            )

    return ResolvedContextPolicy(
        max_input_tokens=resolved_max,
        prune_window_chars=resolved_prune,
        recovery_band=resolved_band,
        tokenizer_ref=resolved_tokenizer,
        source=source,
    )


def _is_trusted_tokenizer_ref(ref: str) -> bool:
    """Allow litellm/tiktoken-style names and bare local identifiers only."""
    lowered = ref.lower()
    if lowered.startswith(("tiktoken:", "litellm:", "local:")):
        return True
    # Reject remote URLs and path traversal.
    if "://" in ref or ".." in ref or ref.startswith("/"):
        return False
    # Bare name (HF family via litellm create_pretrained_tokenizer) — allow alnum/_- only.
    return all(c.isalnum() or c in "_-./" for c in ref) and len(ref) <= 128
