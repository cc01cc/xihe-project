"""xihe_agent package bootstrap.

PLAN-0539: repair ``NO_PROXY``/``no_proxy`` here, before any submodule (and
therefore before the first httpx client) — see :mod:`xihe_agent.env_sanitize`
for why this exact timing is required. Moving this call later reintroduces the
import-time crash; ``tests/unit/test_proxy_env.py`` guards the placement.
"""

from xihe_agent.env_sanitize import sanitize_no_proxy_env as _sanitize_no_proxy_env

_sanitize_no_proxy_env()
