"""PLAN-0307 T3.4 (decisions #7/#25/#32): distributed fail-fast for dangerous factory defaults.

Runs after the config chain is loaded and validates the effective values. With an explicit
``XIHE_ENV=prod`` any insecure default refuses startup (``SystemExit(1)``) and lists the
offending keys plus the fix; in dev/test (or unset, defaulting to dev) the same findings are
only WARNed, and the release gate must force an explicit ``prod``. No per-module prod profile.

The key list mirrors ``spec/config-env-target.md`` §6 and is duplicated per module by design
(no shared runtime dependency); keep the three implementations in sync.
"""

from __future__ import annotations

import os
from collections.abc import Mapping

from loguru import logger

PROD_ENV_NAME = "prod"
DEV_TOKEN = "dev-token-not-secure"
_INSECURE_JWT_SECRETS = frozenset(
    {
        "xihe-cp-jwt-secret-key-change-in-production",
        "dev-jwt-secret-key-do-not-use-in-production-please-change",
    }
)


def collect_violations(environ: Mapping[str, str] | None = None) -> list[str]:
    """Return human-readable violations of the dangerous-defaults contract."""
    env = os.environ if environ is None else environ
    violations: list[str] = []

    if env.get("XIHE_CP_JWT_SECRET") in _INSECURE_JWT_SECRETS:
        violations.append(
            "XIHE_CP_JWT_SECRET: factory/placeholder secret is in use "
            "(generate a random secret, e.g. `openssl rand -base64 48`)"
        )
    if env.get("XIHE_CP_API_TOKEN") == DEV_TOKEN:
        violations.append(
            "XIHE_CP_API_TOKEN: dev token `dev-token-not-secure` is in use (set a strong service token)"
        )
    if env.get("XIHE_AGENT_API_TOKEN") == DEV_TOKEN:
        violations.append(
            "XIHE_AGENT_API_TOKEN: dev token `dev-token-not-secure` is in use (set a strong service token)"
        )
    if (env.get("XIHE_CP_OAUTH_ALLOW_DEV_KEY") or "").lower() == "true":
        violations.append(
            "XIHE_CP_OAUTH_ALLOW_DEV_KEY: must be `false` in prod (dev fallback encryption key would be accepted)"
        )
    if (env.get("XIHE_CP_PROVIDER_CREDENTIALS_ALLOW_DEV_KEY") or "").lower() == "true":
        violations.append(
            "XIHE_CP_PROVIDER_CREDENTIALS_ALLOW_DEV_KEY: must be `false` in prod "
            "(dev fallback encryption key would be accepted)"
        )
    if not (env.get("XIHE_CP_OAUTH_ENCRYPTION_KEY") or "").strip():
        violations.append("XIHE_CP_OAUTH_ENCRYPTION_KEY: required in prod (provide a base64 key)")
    if not (env.get("XIHE_CP_PROVIDER_CREDENTIALS_KEY") or "").strip():
        violations.append("XIHE_CP_PROVIDER_CREDENTIALS_KEY: required in prod (provide a base64 key)")
    return violations


def enforce_security_defaults(environ: Mapping[str, str] | None = None) -> bool:
    """Validate the effective configuration; exits with code 1 when prod is requested."""
    env = os.environ if environ is None else environ
    env_name = env.get("XIHE_ENV") or "dev"
    violations = collect_violations(env)
    if not violations:
        return False
    body = "\n - ".join(violations)
    if env_name == PROD_ENV_NAME:
        logger.error(
            "Refusing to start: insecure default configuration in prod mode:\n - {}\n"
            "Fix the keys above (set real secrets / disable dev keys), then restart.",
            body,
        )
        raise SystemExit(1)
    logger.warning(
        "Insecure default configuration detected ({} mode: WARN only; a prod start would "
        "refuse):\n - {}\nFix before deploying to prod.",
        env_name,
        body,
    )
    return True
