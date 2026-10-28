"""Internal service-token resolution.

PLAN-0537: every Agent-side verifier and client resolves the token through this
single function so the precedence is identical everywhere. Kept in a leaf
module (no ``app_state`` import) to avoid a circular import with
``xihe_agent.llm.models``.
"""

import os
from collections.abc import Mapping

_DEV_TOKEN = "dev-token-not-secure"


def resolve_service_token(env: Mapping[str, str] | None = None) -> str:
    """Return the internal service token.

    ``XIHE_AGENT_API_TOKEN`` wins; ``XIHE_CP_API_TOKEN`` is the legacy fallback.
    Read at call time (not import time) so tests and reloads observe the
    current environment.
    """
    source = os.environ if env is None else env
    token = (source.get("XIHE_AGENT_API_TOKEN") or "").strip()
    if token:
        return token
    return (source.get("XIHE_CP_API_TOKEN") or "").strip() or _DEV_TOKEN
