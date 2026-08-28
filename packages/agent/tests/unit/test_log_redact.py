from loguru import logger

from xihe_agent.log_redact import REDACTED, patch_record, redact_text, redact_value


def test_redact_text_bearer_and_jwt():
    text = "call failed with Bearer sk-live-1234567890abcdef"
    assert "sk-live" not in redact_text(text)
    assert REDACTED in redact_text(text)

    jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.dGVzdHNpZw"
    assert jwt not in redact_text(f"token={jwt}")


def test_redact_value_sensitive_keys():
    data = {
        "token": "secret-token-value",
        "nested": {"authorization": "Bearer abc.def.ghi", "keep": "visible"},
        "list": [{"refresh_token": "refresh-secret"}],
    }
    result = redact_value(data)
    assert result["token"] == REDACTED
    assert result["nested"]["authorization"] == REDACTED
    assert result["nested"]["keep"] == "visible"
    assert result["list"][0]["refresh_token"] == REDACTED


def test_patch_record_redacts_message_and_extra():
    record = {
        "message": "exchange failed for Bearer hunter2secret",
        "extra": {"api_key": "ak-secret", "note": "ok"},
    }
    patch_record(record)
    assert "hunter2secret" not in record["message"]
    assert record["extra"]["api_key"] == REDACTED
    assert record["extra"]["note"] == "ok"


def test_loguru_patcher_applies_to_sinks(tmp_path):
    sink = tmp_path / "agent.log"
    logger.configure(patcher=patch_record)
    handler_id = logger.add(sink, serialize=True, level="DEBUG")
    try:
        logger.info("stored refresh token Bearer tok-abc123def456")
    finally:
        logger.remove(handler_id)
    content = sink.read_text(encoding="utf-8")
    assert "tok-abc123def456" not in content
    assert REDACTED in content
