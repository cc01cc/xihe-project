"""PLAN-0537: single service-token resolution order.

Every Agent-side verifier/client must observe the same precedence:
``XIHE_AGENT_API_TOKEN`` wins, ``XIHE_CP_API_TOKEN`` is the fallback, then the
dev default.
"""

from xihe_agent.service_token import resolve_service_token


def test_new_token_wins_when_only_new_is_set():
    assert resolve_service_token({"XIHE_AGENT_API_TOKEN": "new-token"}) == "new-token"


def test_legacy_token_is_used_when_only_legacy_is_set():
    assert resolve_service_token({"XIHE_CP_API_TOKEN": "legacy-token"}) == "legacy-token"


def test_new_token_wins_when_both_are_set_to_the_same_value():
    env = {"XIHE_AGENT_API_TOKEN": "same", "XIHE_CP_API_TOKEN": "same"}
    assert resolve_service_token(env) == "same"


def test_new_token_wins_when_both_differ():
    env = {"XIHE_AGENT_API_TOKEN": "new-token", "XIHE_CP_API_TOKEN": "legacy-token"}
    assert resolve_service_token(env) == "new-token"


def test_dev_default_applies_when_neither_is_set():
    assert resolve_service_token({}) == "dev-token-not-secure"


def test_blank_new_token_falls_back_to_legacy():
    env = {"XIHE_AGENT_API_TOKEN": "   ", "XIHE_CP_API_TOKEN": "legacy-token"}
    assert resolve_service_token(env) == "legacy-token"
