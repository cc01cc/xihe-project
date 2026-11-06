"""C4 regression: LiteLLM token_counter DEBUG must not log ask_user bodies.

The leaked record shape is::

    messages in token_counter: ..., text in token_counter: {"messages": [...]}

LiteLLM formats the whole payload at DEBUG. The primary defense is the WARNING
floor installed by ``xihe_agent.main``; the loguru boundary redaction is the
fallback when a library still formats a payload into the record text.
"""

import json
import logging

import litellm
from loguru import logger

from xihe_agent.log_redact import REDACTED, patch_record, redact_text

CANARY = "XIHE-E2E-ASK-9f3a-user-question-and-answer-body"


def test_token_counter_record_is_redacted_at_loguru_boundary():
    record = (
        "messages in token_counter: None, text in token_counter: "
        + json.dumps({"messages": [{"role": "user", "content": CANARY}]})
    )

    redacted = redact_text(record)

    assert CANARY not in redacted
    assert REDACTED in redacted
    assert "messages in token_counter:" in redacted


def test_litellm_token_counter_debug_does_not_reach_agent_log(tmp_path):
    sink = tmp_path / "agent.log"
    logger.configure(patcher=patch_record)
    handler_id = logger.add(sink, serialize=True, level="DEBUG")

    litellm_logger = logging.getLogger("LiteLLM")
    previous_level = litellm_logger.level
    previous_propagate = litellm_logger.propagate
    previous_handlers = litellm_logger.handlers[:]
    litellm_logger.setLevel(logging.DEBUG)
    litellm_logger.propagate = True
    litellm_logger.handlers = []
    try:
        litellm.token_counter(
            model="gpt-4o",
            messages=[{"role": "user", "content": CANARY}],
        )
    finally:
        litellm_logger.handlers = previous_handlers
        litellm_logger.propagate = previous_propagate
        litellm_logger.setLevel(previous_level)
        logger.remove(handler_id)

    content = sink.read_text(encoding="utf-8")
    assert "messages in token_counter" in content, "DEBUG record did not reach the loguru sink"
    assert CANARY not in content


def test_main_pins_litellm_loggers_to_warning():
    import xihe_agent.main  # noqa: F401  (composition root applies the floor at import)

    for name in ("LiteLLM", "LiteLLM Router", "LiteLLM Proxy"):
        assert logging.getLogger(name).level >= logging.WARNING
