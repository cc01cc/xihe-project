import pytest
from loguru import logger

from xihe_agent.security_defaults import collect_violations, enforce_security_defaults

_INSECURE_ENV = {
    "XIHE_CP_JWT_SECRET": "xihe-cp-jwt-secret-key-change-in-production",
    "XIHE_CP_API_TOKEN": "dev-token-not-secure",
    "XIHE_AGENT_API_TOKEN": "dev-token-not-secure",
    "XIHE_CP_OAUTH_ALLOW_DEV_KEY": "true",
    "XIHE_CP_PROVIDER_CREDENTIALS_ALLOW_DEV_KEY": "true",
    "XIHE_CP_CREDENTIALS_ALLOW_DEV_KEY": "true",
}

_SECURE_ENV = {
    "XIHE_CP_JWT_SECRET": "a-real-random-secret",
    "XIHE_CP_API_TOKEN": "strong-service-token",
    "XIHE_AGENT_API_TOKEN": "strong-service-token",
    "XIHE_CP_OAUTH_ALLOW_DEV_KEY": "false",
    "XIHE_CP_PROVIDER_CREDENTIALS_ALLOW_DEV_KEY": "false",
    "XIHE_CP_CREDENTIALS_ALLOW_DEV_KEY": "false",
    "XIHE_CP_OAUTH_ENCRYPTION_KEY": "base64-key",
    "XIHE_CP_PROVIDER_CREDENTIALS_KEY": "base64-key",
    "XIHE_CP_CREDENTIALS_KEY": "base64-key",
}


def test_collect_violations_flags_all_dangerous_defaults():
    violations = collect_violations(_INSECURE_ENV)
    # 6 explicit insecure values + 3 empty-required encryption keys
    assert len(violations) == 9


def test_prod_with_insecure_defaults_refuses_to_start():
    with pytest.raises(SystemExit) as excinfo:
        enforce_security_defaults({"XIHE_ENV": "prod", **_INSECURE_ENV})
    assert excinfo.value.code == 1


def test_prod_with_secure_values_start():
    assert enforce_security_defaults({"XIHE_ENV": "prod", **_SECURE_ENV}) is False


def test_unset_env_warns_but_does_not_fail(monkeypatch):
    messages: list[str] = []
    handler_id = logger.add(lambda message: messages.append(message), level="WARNING")
    try:
        assert enforce_security_defaults(_INSECURE_ENV) is True
        assert any("WARN only" in message for message in messages)
    finally:
        logger.remove(handler_id)


def test_explicit_dev_warns_but_does_not_fail():
    assert enforce_security_defaults({"XIHE_ENV": "dev", **_INSECURE_ENV}) is True


def test_credential_key_ring_satisfies_prod_requirement():
    violations = collect_violations({"XIHE_CP_CREDENTIALS_KEY_RING": '{"v1":"base64-key"}'})
    assert not any(item.startswith("XIHE_CP_CREDENTIALS_KEY") for item in violations)


def test_credential_dev_key_flag_is_flagged():
    violations = collect_violations(
        {"XIHE_CP_CREDENTIALS_ALLOW_DEV_KEY": "true", "XIHE_CP_CREDENTIALS_KEY": "base64-key"}
    )
    assert any(item.startswith("XIHE_CP_CREDENTIALS_ALLOW_DEV_KEY") for item in violations)
