"""task-925 — CP URL precedence + all-default readiness guard.

Two fake-green shapes this file pins:

1. A stack-2 Agent must use stack-2's CP (12641). The launcher derives
   `XIHE_CP_URL`; if only `XIHE_CP_PORT` is present the resolver must use it,
   never the stack-1 12631 baseline.
2. A reachable CP that answers `source=default` supplied no business config.
   Readiness must stay `missing_credentials` even if an LLM profile object looks
   populated (that profile can only have come from code defaults/env).
"""

from __future__ import annotations

import pytest

from xihe_agent.app_state import _derive_llm_ready, resolve_cp_url
from xihe_agent.llm.base import LLMConfig


def test_cp_url_wins_over_port():
    assert resolve_cp_url({
        "XIHE_CP_URL": "http://localhost:12641",
        "XIHE_CP_PORT": "19999",
    }) == "http://localhost:12641"


def test_cp_port_is_used_when_url_absent():
    assert resolve_cp_url({"XIHE_CP_PORT": "12641"}) == "http://localhost:12641"


def test_cp_url_defaults_to_stack1_baseline():
    assert resolve_cp_url({}) == "http://localhost:12631"
    assert resolve_cp_url({"XIHE_CP_URL": "", "XIHE_CP_PORT": ""}) == "http://localhost:12631"


def test_cp_url_strips_whitespace():
    assert resolve_cp_url({"XIHE_CP_URL": "  http://localhost:12641  "}) == "http://localhost:12641"


def test_cp_port_must_be_an_integer():
    with pytest.raises(RuntimeError, match="XIHE_CP_PORT must be an integer"):
        resolve_cp_url({"XIHE_CP_PORT": "not-a-port"})


def _report(source: str) -> dict:
    return {
        "ok": True,
        "domains": {"llm-provider": {"status": "ok", "revision": "0:0", "source": source}},
        "revision": "rev",
        "refreshed": True,
        "degraded": [],
    }


PROVIDER = LLMConfig(provider="openai", api_key="", api_base="", model="gpt-test")


def test_all_default_llm_provider_is_never_ready():
    readiness, verified_at = _derive_llm_ready(_report("default"), {}, PROVIDER)
    assert readiness == "missing_credentials"
    assert verified_at is None


def test_configured_llm_provider_without_catalog_entry_is_ready():
    readiness, verified_at = _derive_llm_ready(_report("instance"), {}, PROVIDER)
    assert readiness == "ready"
    assert verified_at is None
